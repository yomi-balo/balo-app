'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Ably from 'ably';
import {
  conversationChannelName,
  CONVERSATION_EVENT_FILE,
  CONVERSATION_EVENT_MESSAGE,
} from '@/lib/realtime/channels';
import type {
  ConversationFileView,
  ConversationMessageView,
} from '@/lib/project-request/conversation-view-types';
import { createConversationRealtimeTokenAction } from '@/app/(dashboard)/projects/[requestId]/_actions/create-conversation-realtime-token';

export type ConversationRealtimeStatus = 'disabled' | 'connecting' | 'connected' | 'failed';

export interface UseConversationRealtimeInput {
  /** Server said realtime is on AND there are channels to join. */
  enabled: boolean;
  requestId: string;
  relationshipIds: string[];
  onMessage: (message: ConversationMessageView) => void;
  onFile: (file: ConversationFileView) => void;
}

function hasStringFields<K extends string>(
  data: unknown,
  keys: readonly K[]
): data is Record<K, string> {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return keys.every((key) => typeof record[key] === 'string');
}

/** Full structural guard over every message field the island consumes. */
export function isConversationMessagePayload(data: unknown): data is ConversationMessageView {
  return hasStringFields(data, [
    'id',
    'relationshipId',
    'bodyHtml',
    'senderUserId',
    'senderName',
    'createdAtIso',
  ]);
}

/** Full structural guard over every file field the island consumes. */
export function isConversationFilePayload(data: unknown): data is ConversationFileView {
  return (
    hasStringFields(data, [
      'id',
      'relationshipId',
      'fileName',
      'contentType',
      'uploadedByUserId',
      'uploadedByName',
      'createdAtIso',
    ]) && typeof (data as { sizeBytes?: unknown }).sizeBytes === 'number'
  );
}

/** The only tags a realtime message body may carry (what the server emits). */
const REALTIME_ALLOWED_TAG = /^<(?:\/?p|br\s*\/?)>$/i;

/** The node-callback Ably hands to `authCallback` implementations. */
type AblyAuthResultCallback = Parameters<NonNullable<Ably.ClientOptions['authCallback']>>[1];

/**
 * Best-effort error → string for the auth callback: `Error` and Ably's
 * `ErrorInfo` both carry a string `.message` (structural narrowing, no `any`);
 * anything else gets a fixed label instead of '[object Object]'.
 */
function authErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'Realtime token request failed';
}

/**
 * Fetches a token via the Server Action and reports through Ably's
 * NODE-CALLBACK contract — an async `authCallback` that returns a promise
 * silently fails (D1), so this stays a `void`-returning function.
 */
function fetchRealtimeToken(requestId: string, callback: AblyAuthResultCallback): void {
  createConversationRealtimeTokenAction({ requestId })
    .then((result) => {
      if (result.success) {
        callback(null, result.tokenRequest);
      } else {
        callback(result.error ?? 'Realtime disabled', null);
      }
    })
    .catch((error: unknown) => {
      callback(authErrorMessage(error), null);
    });
}

/**
 * Client-side defense-in-depth for Ably-delivered `bodyHtml` before it can
 * reach `dangerouslySetInnerHTML`: every tag except `<p>`, `</p>`, `<br>` is
 * escaped in place (no sanitizer dependency in the bundle). Server-built
 * payloads (`plainMessageToHtml` → `sanitizeProjectHtml`) pass through
 * unchanged; a hostile payload renders as inert text.
 */
export function sanitizeRealtimeBodyHtml(html: string): string {
  // `<` up to the next `>` (or end of input for an unterminated tag). The
  // bounded `[^<>]*` body cannot backtrack catastrophically (no nesting).
  return html.replace(/<[^<>]*>?/g, (tag) =>
    REALTIME_ALLOWED_TAG.test(tag) ? tag : tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  );
}

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
  const { enabled, requestId, relationshipIds, onMessage, onFile } = input;
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
    () => [...relationshipIds].sort((a, b) => a.localeCompare(b)).join(','),
    [relationshipIds]
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
        authCallback: (_tokenParams, callback) => fetchRealtimeToken(requestId, callback),
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

      for (const relationshipId of channelsKey.split(',')) {
        const channel = client.channels.get(conversationChannelName(relationshipId));
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
  }, [enabled, requestId, channelsKey]);

  return { status };
}
