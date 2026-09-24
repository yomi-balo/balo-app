import 'server-only';

import * as Ably from 'ably';
import { log } from '@/lib/logging';
import { runAfterResponse } from '@/lib/after-response';
import {
  conversationChannelName,
  meetingChannelName,
  typingChannelName,
  typingEventNameFor,
  type TypingSignal,
} from './channels';

/**
 * Server-side Ably seam (BAL-271 / A4 — D1).
 *
 * The DB is the source of truth; Ably is purely a live-update transport. Only
 * the SERVER publishes (after validation + sanitisation + persist) — clients
 * hold subscribe-only tokens, so a tampered client can never spoof a message
 * into another thread. The API key never reaches the browser. That includes the
 * "typing…" signal: a Server Action relays it to {@link publishTypingSignal}.
 *
 * Graceful degradation: `ABLY_API_KEY` unset (dev/CI) → publishing is a warn +
 * no-op and the token action returns `{ disabled: true }`; the thread still
 * fully works (own messages append from the action result; the other party
 * sees new content on next load).
 */

let restClient: Ably.Rest | null = null;
let typingRestClient: Ably.Rest | null = null;

/**
 * ⚠ THE TYPING PUBLISH'S OWN BUDGET: one attempt, 1.5 s. A typing signal is disposable, and it is
 * AWAITED inside a Server Action — and Next runs a page's Server Actions one at a time, so a
 * typing call stuck on Ably's defaults (10 s per request, 3 retries) would hold up the very next
 * message send behind it. A dropped signal costs nothing: receivers expire it at 12 s.
 */
export const TYPING_PUBLISH_TIMEOUT_MS = 1_500;

/** True when the server holds an Ably API key (realtime transport available). */
export function isRealtimeConfigured(): boolean {
  const key = process.env.ABLY_API_KEY;
  return typeof key === 'string' && key.length > 0;
}

/** Lazy REST singleton — `null` when realtime is unconfigured. */
export function getAblyRest(): Ably.Rest | null {
  if (!isRealtimeConfigured()) return null;
  restClient ??= new Ably.Rest({ key: process.env.ABLY_API_KEY });
  return restClient;
}

/** The typing publish's REST client: same key, a tight budget ({@link TYPING_PUBLISH_TIMEOUT_MS}). */
function getTypingAblyRest(): Ably.Rest | null {
  if (!isRealtimeConfigured()) return null;
  typingRestClient ??= new Ably.Rest({
    key: process.env.ABLY_API_KEY,
    httpRequestTimeout: TYPING_PUBLISH_TIMEOUT_MS,
    httpMaxRetryCount: 0,
  });
  return typingRestClient;
}

/**
 * Publish a persisted conversation event to the thread's channel.
 *
 * ⚠ THE FIRST ARGUMENT IS A `conversations.id` (BAL-424), never a relationship id — see
 * `channels.ts`. Passing the wrong one publishes to a channel nobody subscribes to, which
 * fails SILENTLY: this function never throws.
 *
 * NEVER throws to the caller: a publish failure is logged and swallowed — the
 * mutation already succeeded and must not fail because the live transport
 * hiccuped.
 *
 * Durability (BAL-279): the publish is deferred to Next's `after()` (via
 * {@link runAfterResponse}), the same freeze-safe hop the durable notification
 * dispatch now rides. This replaces the old "callers must await this so a dropped
 * promise isn't cut short on serverless" contract — the ephemeral realtime ping
 * and the durable notification now share ONE durability story, and the action no
 * longer pays the publish round-trip on its response path. The returned promise
 * resolves eagerly (work deferred); it is kept only for signature stability.
 */
export function publishConversationEvent(
  conversationId: string,
  name: 'message' | 'file',
  data: unknown
): Promise<void> {
  return deferPublish(conversationChannelName(conversationId), name, data);
}

/**
 * BAL-437 — publish a CALL-GRAIN event to `meeting:{meetingId}`.
 *
 * ⚠⚠ THE FIRST ARGUMENT IS A `meetings.id`, and passing the wrong one FAILS SILENTLY — the
 * exact footgun {@link publishConversationEvent} names for the conversation id. There is no
 * FK, no RLS and no round-trip verdict: a publish to a channel nobody subscribes to is
 * indistinguishable from a successful one.
 *
 * ⚠⚠ IT NEVER THROWS **AND IT IS DEFERRED**, so a caller that returns `{ success: true }`
 * returns BEFORE the publish is even attempted. For `sendMeetingReactionAction` that is the
 * correct trade — the sender's float already rendered optimistically, so nobody is misled —
 * but it means a publish failure is a `log.error` the user never sees. Written down here so
 * the next reader does not mistake `{ success: true }` for "it was delivered".
 *
 * ⚠ REACTIONS ARE NEVER PERSISTED, AND THIS FUNCTION IS WHY THAT IS STRUCTURAL: it is the
 * ONLY thing `sendMeetingReactionAction` calls. There is no repository on that path at all.
 */
export function publishMeetingEvent(
  meetingId: string,
  name: 'reaction' | 'file',
  data: unknown
): Promise<void> {
  return deferPublish(meetingChannelName(meetingId), name, data);
}

/**
 * Publish one "typing…" signal on `typing:{conversationId}`, attributed to `userId`.
 *
 * ⚠⚠ THE SERVER STAMPS THE IDENTITY. `clientId` is set here from the caller's SESSION user —
 * receivers read it as the typist and read nothing else (`typing-channel.ts`) — so the caller
 * must pass the session user's id after its gate, never an id from input. The message carries
 * NO `data` and is `ephemeral`: exempt from history, rewind, resume and integrations.
 *
 * ⚠⚠ IT IS AWAITED, NOT DEFERRED — the opposite of {@link deferPublish}, on purpose. A sender's
 * `started` and `stopped` are two separate action calls; the client sends them one at a time
 * (`typing-relay.ts`), and that ordering only survives to the channel if each action returns
 * AFTER Ably acknowledged its publish. Deferred, a `stopped` could land before its `started`
 * and leave a phantom typist on every screen until the 12 s receiver expiry.
 *
 * ⚠ IT IS BOUNDED: its own REST client allows one attempt of {@link TYPING_PUBLISH_TIMEOUT_MS}.
 *
 * ⚠ IT THROWS on a failed or timed-out publish, so the calling action can log it with its own
 * correlation ids. With no `ABLY_API_KEY` it is a no-op: nobody can be subscribed.
 */
export async function publishTypingSignal(
  conversationId: string,
  userId: string,
  signal: TypingSignal
): Promise<void> {
  const client = getTypingAblyRest();
  if (client === null) return;
  await client.channels.get(typingChannelName(conversationId)).publish({
    name: typingEventNameFor(signal),
    clientId: userId,
    extras: { ephemeral: true },
  });
}

/**
 * The one publish body, shared by both namespaces.
 *
 * ⚠ EXTRACTED RATHER THAN COPIED. Two verbatim copies of the deferral + the unconfigured warn
 * + the swallow-and-log would be ~20 duplicated lines against SonarCloud's 3% new-code
 * duplication gate, and — worse — two places for the never-throws contract to drift. The
 * returned promise resolves EAGERLY (the work is deferred); it is kept only for signature
 * stability, exactly as the shipped contract states.
 */
function deferPublish(channel: string, name: string, data: unknown): Promise<void> {
  runAfterResponse('Ably publish', async () => {
    const client = getAblyRest();
    if (client === null) {
      log.warn('Realtime disabled (no ABLY_API_KEY) — skipping publish', { channel, name });
      return;
    }

    try {
      await client.channels.get(channel).publish(name, data);
    } catch (error) {
      log.error('Ably publish failed', {
        channel,
        name,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  });

  return Promise.resolve();
}
