import 'server-only';

import * as Ably from 'ably';
import { log } from '@/lib/logging';
import { runAfterResponse } from '@/lib/after-response';
import { conversationChannelName, meetingChannelName } from './channels';

/**
 * Server-side Ably seam (BAL-271 / A4 — D1).
 *
 * The DB is the source of truth; Ably is purely a live-update transport. Only
 * the SERVER publishes (after validation + sanitisation + persist) — clients
 * hold subscribe-only tokens, so a tampered client can never spoof a message
 * into another thread. The API key never reaches the browser.
 *
 * Graceful degradation: `ABLY_API_KEY` unset (dev/CI) → publishing is a warn +
 * no-op and the token action returns `{ disabled: true }`; the thread still
 * fully works (own messages append from the action result; the other party
 * sees new content on next load).
 */

let restClient: Ably.Rest | null = null;

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
