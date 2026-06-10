import 'server-only';

import * as Ably from 'ably';
import { log } from '@/lib/logging';
import { conversationChannelName } from './channels';

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
 * NEVER throws to the caller: a publish failure is logged and swallowed — the
 * mutation already succeeded and must not fail because the live transport
 * hiccuped. Callers still `await` this (a dropped fire-and-forget promise can
 * be cut short on serverless after the response returns).
 */
export async function publishConversationEvent(
  relationshipId: string,
  name: 'message' | 'file',
  data: unknown
): Promise<void> {
  const client = getAblyRest();
  const channel = conversationChannelName(relationshipId);
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
}
