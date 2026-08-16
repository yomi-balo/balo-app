'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Ably from 'ably';
import {
  conversationChannelName,
  CONVERSATION_EVENT_FILE,
  CONVERSATION_EVENT_MESSAGE,
} from '@/lib/realtime/channels';
import { fetchRealtimeToken, type RealtimeTokenResult } from '@/lib/realtime/ably-auth';
import {
  isConversationFilePayload,
  isConversationMessagePayload,
  sanitizeRealtimeBodyHtml,
} from '@/lib/realtime/message-payload';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';

export type ConversationRealtimeStatus = 'disabled' | 'connecting' | 'connected' | 'failed';

/**
 * What a token fetcher must return.
 *
 * ⚠ BAL-437 MOVED THE DECLARATION to `@/lib/realtime/ably-auth` (its second consumer is the
 * in-call hook, which must not import a conversation module). This alias is kept because
 * `create-case-realtime-token.ts` imports the name FROM HERE, and re-pointing that import
 * would be churn in a `'use server'` module for no behavioural gain.
 */
export type ConversationRealtimeTokenResult = RealtimeTokenResult;

export interface UseConversationRealtimeInput {
  /** Server said realtime is on AND there are channels to join. */
  enabled: boolean;
  /**
   * ⚠ BAL-421 REPLACED A HARD-CODED `requestId` + A HARD IMPORT OF THE PROJECT-REQUEST
   * TOKEN ACTION. That import was this hook's ONLY coupling to a route — everything else
   * already keyed on `conversationIds` alone — and a Case has no request id to pass. Each
   * surface now injects its OWN entitlement-resolving action.
   *
   * ⚠⚠ IT MUST BE MEMOIZED WITH `useCallback`. It is an effect dependency, so an unstable
   * identity tears down and re-subscribes every Ably channel on EVERY RENDER — which looks
   * like flapping connectivity rather than like a bug, and would be found in production
   * rather than in review.
   */
  fetchToken: () => Promise<ConversationRealtimeTokenResult>;
  /**
   * BAL-424 — CONVERSATION ids, not relationship ids. The channel name, the token's
   * capability list and both wire payloads all key on the conversation.
   */
  conversationIds: string[];
  onMessage: (message: ConversationMessageView) => void;
  onFile: (file: ConversationFileView) => void;
}

/**
 * ⚠⚠ BAL-437 MOVED THE THREE PAYLOAD PRIMITIVES to `@/lib/realtime/message-payload` —
 * `isConversationMessagePayload`, `isConversationFilePayload` and `sanitizeRealtimeBodyHtml`.
 * The in-call hook needs two of them, and importing them FROM HERE made the CALL surface reach
 * into the project-request/case conversation feature for a transport-level primitive. That is
 * the coupling BAL-421 already broke once for the token plumbing (`ably-auth.ts`); this closes
 * the same seam one import lower down. ⚠ THEY ARE NOT RE-EXPORTED — one path, not two.
 */

/**
 * Subscribe-only Ably client for the conversation island (BAL-271 / A4 — D1).
 *
 * TRUST BOUNDARY: channel payloads arrive as `unknown` from a third-party
 * transport. Every consumed field is structurally type-checked
 * (`isConversationMessagePayload` / `isConversationFilePayload`) and message
 * `bodyHtml` is re-sanitised client-side (`sanitizeRealtimeBodyHtml`) before
 * the island may render it via `dangerouslySetInnerHTML` — even though the
 * server only ever publishes sanitised view-models, a compromised key or
 * channel must degrade to inert text, never script execution.
 *
 * - The `ably` SDK is DYNAMICALLY imported inside the effect (never in the
 *   initial bundle, never evaluated during SSR instantiation).
 * - Token auth via the Server Action through Ably's NODE-CALLBACK style
 *   `authCallback` (an async callback that returns a promise silently fails).
 * - `enabled: false` → terminal `'disabled'` status, no client, no retry loop,
 *   no toasts — the thread still works through action results + reloads.
 */
export function useConversationRealtime(input: UseConversationRealtimeInput): {
  status: ConversationRealtimeStatus;
} {
  const { enabled, fetchToken, conversationIds, onMessage, onFile } = input;
  const [status, setStatus] = useState<ConversationRealtimeStatus>(
    enabled ? 'connecting' : 'disabled'
  );

  // Keep the latest handlers in refs so re-renders never resubscribe channels.
  const onMessageRef = useRef(onMessage);
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onMessageRef.current = onMessage;
    onFileRef.current = onFile;
  }, [onMessage, onFile]);

  // Stable identity for the channel set (order-insensitive).
  const channelsKey = useMemo(
    () => [...conversationIds].sort((a, b) => a.localeCompare(b)).join(','),
    [conversationIds]
  );

  useEffect(() => {
    if (!enabled || channelsKey === '') {
      setStatus('disabled');
      return;
    }

    let disposed = false;
    let client: Ably.Realtime | null = null;
    setStatus('connecting');

    const connect = async (): Promise<void> => {
      const AblySdk = await import('ably');
      if (disposed) return;

      client = new AblySdk.Realtime({
        // Node-callback style — NOT a promise-returning callback (D1).
        authCallback: (_tokenParams, callback) => fetchRealtimeToken(fetchToken, callback),
      });

      client.connection.on('connected', () => {
        if (!disposed) setStatus('connected');
      });
      client.connection.on('failed', () => {
        if (!disposed) setStatus('failed');
      });
      client.connection.on('disconnected', () => {
        if (!disposed) setStatus('connecting');
      });
      client.connection.on('suspended', () => {
        if (!disposed) setStatus('connecting');
      });

      for (const conversationId of channelsKey.split(',')) {
        const channel = client.channels.get(conversationChannelName(conversationId));
        channel
          .subscribe(CONVERSATION_EVENT_MESSAGE, (msg: Ably.InboundMessage) => {
            if (!disposed && isConversationMessagePayload(msg.data)) {
              onMessageRef.current({
                ...msg.data,
                bodyHtml: sanitizeRealtimeBodyHtml(msg.data.bodyHtml),
              });
            }
          })
          .catch(() => {
            // Attach failures surface via the connection-state listeners.
          });
        channel
          .subscribe(CONVERSATION_EVENT_FILE, (msg: Ably.InboundMessage) => {
            if (!disposed && isConversationFilePayload(msg.data)) {
              onFileRef.current(msg.data);
            }
          })
          .catch(() => {
            // Attach failures surface via the connection-state listeners.
          });
      }
    };

    connect().catch(() => {
      if (!disposed) setStatus('failed');
    });

    return () => {
      disposed = true;
      client?.close();
      client = null;
    };
    // ⚠ `fetchToken` MUST BE MEMOIZED BY THE CALLER — see the prop's docblock.
  }, [enabled, fetchToken, channelsKey]);

  return { status };
}
