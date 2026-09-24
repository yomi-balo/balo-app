'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Ably from 'ably';
import {
  conversationChannelName,
  CONVERSATION_EVENT_FILE,
  CONVERSATION_EVENT_MESSAGE,
  typingChannelName,
  type TypingSignal,
} from '@/lib/realtime/channels';
import { fetchRealtimeToken, type RealtimeTokenResult } from '@/lib/realtime/ably-auth';
import {
  isConversationFilePayload,
  isConversationMessagePayload,
  sanitizeRealtimeBodyHtml,
} from '@/lib/realtime/message-payload';
import { attachTypingChannel } from '@/lib/realtime/typing-channel';
import { createTypingRelay, type TypingRelay } from '@/lib/realtime/typing-relay';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/conversations/conversation-view-types';
import { useTypingIndicator, type TypingIndicatorView } from './use-typing-indicator';

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
  /**
   * The ONE open thread whose `typing:{conversationId}` channel to attach; `null` or omitted
   * means no typing at all. Callers pass it only while that thread's composer is live.
   *
   * ⚠⚠ ONE THREAD, NEVER THE WHOLE LIST. A project request's token grants typing on every
   * conversation it lists, but Ably caps ATTACHED channels at 200 per connection on every plan,
   * so typing follows the thread on screen while messages keep their full fan-out.
   *
   * ⚠ IT MUST BE ONE OF `conversationIds`. The token mints a typing grant only alongside its
   * conversation's grant, so any other id could never attach; it is ignored instead.
   */
  typingConversationId?: string | null;
  /**
   * The surface's typing Server Action, called with the typing thread's conversation id. The
   * SERVER publishes the signal — this client's token is subscribe-only — after re-running the
   * surface's post gate. Absent ⇒ the viewer SEES others typing but signals nothing.
   *
   * Read through a ref at call time, so it need not be memoized.
   */
  sendTyping?: ((conversationId: string, signal: TypingSignal) => Promise<unknown>) | null;
}

export interface UseConversationRealtimeResult {
  status: ConversationRealtimeStatus;
  /**
   * The typing view for `typingConversationId`, or `null` when there is none to show: realtime
   * disabled, no typing thread, or one outside `conversationIds`. A surface renders no typing UI
   * at all for `null` — never an empty or broken one.
   */
  typing: TypingIndicatorView | null;
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
 * The conversation whose typing channel this mount attaches, or `null`: realtime must be on and
 * the id must be one of the subscribed conversations (see `typingConversationId`).
 */
function typingConversationIdFor(
  enabled: boolean,
  channelsKey: string,
  typingConversationId: string | null
): string | null {
  if (!enabled || typingConversationId === null) return null;
  return channelsKey.split(',').includes(typingConversationId) ? typingConversationId : null;
}

/**
 * Subscribe-only Ably client for the conversation island (BAL-271 / A4 — D1), plus the typing
 * signal for the one open thread.
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
 *
 * ── ⚠⚠ TYPING: READ ON THIS CLIENT, SENT THROUGH THE SERVER ────────────────────────────────
 *
 * This client publishes NOTHING, typing included. The viewer's own signals go out through
 * `sendTyping` (a Server Action; the server publishes), one call at a time via
 * `createTypingRelay` so a `stopped` can never overtake its `started`. Inbound signals are read
 * by `attachTypingChannel`, which reads only the name and the server-stamped `clientId` and drops
 * the viewer's own (the server fans it back) — and so their other tabs'.
 *
 *   · ONE CLIENT PER MOUNT, STILL. The connect effect publishes its client into state; the
 *     typing effect attaches on THAT client. Switching the typing thread therefore attaches and
 *     releases ONLY the typing channel — no new client, no token refetch, no message-channel
 *     re-subscribe.
 *   · ON A SWITCH OR TEARDOWN the old thread gets `stopped` (if a burst was open) through ITS
 *     relay — bound to the old conversation id — before that relay is closed; inbound typists are
 *     cleared and the channel is released. A closed relay still sends a signal already queued, so
 *     the stop is not lost to the switch. It travels over HTTP, so closing the Ably client (a
 *     rebuild, an unmount) cannot cancel it.
 */
export function useConversationRealtime(
  input: UseConversationRealtimeInput
): UseConversationRealtimeResult {
  const {
    enabled,
    fetchToken,
    conversationIds,
    onMessage,
    onFile,
    typingConversationId = null,
  } = input;
  const [status, setStatus] = useState<ConversationRealtimeStatus>(
    enabled ? 'connecting' : 'disabled'
  );
  /** The mount's one live client, set by the connect effect so the typing effect can ride it. */
  const [client, setClient] = useState<Ably.Realtime | null>(null);
  /** The relay for the attached typing thread; `null` while no typing channel is attached. */
  const [typingRelay, setTypingRelay] = useState<TypingRelay | null>(null);

  const sendTypingRef = useRef(input.sendTyping ?? null);
  useEffect(() => {
    sendTypingRef.current = input.sendTyping ?? null;
  }, [input.sendTyping]);

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

  const typingId = typingConversationIdFor(enabled, channelsKey, typingConversationId);
  /** Read by the message listener, which outlives any one typing thread. */
  const typingIdRef = useRef(typingId);
  useEffect(() => {
    typingIdRef.current = typingId;
  }, [typingId]);

  // `null` until the typing channel is attached, so a keystroke before then opens no burst.
  const publishTyping = typingRelay?.publish ?? null;
  const { typingClientIds, onKeystroke, onStopped, receive, clear } = useTypingIndicator({
    publish: publishTyping,
  });

  useEffect(() => {
    if (client === null || typingId === null) return;
    const handle = attachTypingChannel(client, typingChannelName(typingId), receive);
    // ⚠ BOUND TO THIS THREAD'S ID, so a stop sent from the cleanup below names the thread being
    // left, however the surface's `sendTyping` has changed by then.
    const relay = createTypingRelay((signal) => {
      const send = sendTypingRef.current;
      return send === null ? Promise.resolve() : send(typingId, signal);
    });
    setTypingRelay(relay);
    return () => {
      // `stopped` while `publish` still points at THIS thread's relay, then forget its typists.
      onStopped();
      clear();
      relay.close();
      handle.release();
      setTypingRelay(null);
    };
  }, [client, typingId, receive, onStopped, clear]);

  useEffect(() => {
    if (!enabled || channelsKey === '') {
      setStatus('disabled');
      return;
    }

    let disposed = false;
    let realtime: Ably.Realtime | null = null;
    setStatus('connecting');

    const connect = async (): Promise<void> => {
      const AblySdk = await import('ably');
      if (disposed) return;

      realtime = new AblySdk.Realtime({
        // Node-callback style — NOT a promise-returning callback (D1).
        authCallback: (_tokenParams, callback) => fetchRealtimeToken(fetchToken, callback),
      });

      realtime.connection.on('connected', () => {
        if (!disposed) setStatus('connected');
      });
      realtime.connection.on('failed', () => {
        if (!disposed) setStatus('failed');
      });
      realtime.connection.on('disconnected', () => {
        if (!disposed) setStatus('connecting');
      });
      realtime.connection.on('suspended', () => {
        if (!disposed) setStatus('connecting');
      });

      for (const conversationId of channelsKey.split(',')) {
        const channel = realtime.channels.get(conversationChannelName(conversationId));
        channel
          .subscribe(CONVERSATION_EVENT_MESSAGE, (msg: Ably.InboundMessage) => {
            if (!disposed && isConversationMessagePayload(msg.data)) {
              onMessageRef.current({
                ...msg.data,
                bodyHtml: sanitizeRealtimeBodyHtml(msg.data.bodyHtml),
              });
              // Their message landed, so they are no longer typing it — clear them at once
              // rather than waiting for their `stopped`, which is sent after the post.
              if (msg.data.conversationId === typingIdRef.current) {
                receive('stopped', msg.data.senderUserId);
              }
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

      setClient(realtime);
    };

    connect().catch(() => {
      if (!disposed) setStatus('failed');
    });

    return () => {
      disposed = true;
      realtime?.close();
      realtime = null;
      setClient(null);
    };
    // ⚠ `fetchToken` MUST BE MEMOIZED BY THE CALLER — see the prop's docblock.
    // `receive` is stable for the life of the mount (see `useTypingIndicator`).
  }, [enabled, fetchToken, channelsKey, receive]);

  const typing = useMemo(
    () => (typingId === null ? null : { typingClientIds, onKeystroke, onStopped }),
    [typingId, typingClientIds, onKeystroke, onStopped]
  );

  return { status, typing };
}
