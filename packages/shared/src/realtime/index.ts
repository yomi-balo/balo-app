/**
 * BAL-620 — the shared realtime contract for the in-app notification ping: the channel name and
 * the event names that `apps/api`'s publisher (`in-app-push.ts`) and `apps/web`'s bell
 * subscriber (`use-notification-push.ts`) both agree on.
 *
 * PURE and dependency-free (mirrors `@balo/shared/rate-limit`): no I/O, no Ably SDK, no logging
 * transport, so both bundles can import it without dragging anything across the boundary.
 *
 * ⚠⚠ THE NAMESPACE SPELLING IS A CONTRACT. Ably matches a channel rule or a token capability
 * against the namespace LITERALLY up to the first colon, so `notifications` does NOT match
 * `notification:*`. Any Ably dashboard rule for this channel must be written `notifications:*`.
 *
 * ⚠ NO persistence or integration rule, EVER, on `notifications:*`. The ping is a disposable
 * "go refetch" signal; the durable record is the `user_notifications` row.
 *
 * ⚠ THE WIRE FORMAT: A NAME, NOTHING ELSE. {@link NOTIFICATIONS_EVENT_CREATED} and
 * {@link NOTIFICATIONS_EVENT_READ} are published with NO `data` and `extras: { ephemeral: true }`, so it is exempt from history, rewind, resume
 * and integrations. A receiver reads only the name and refetches the feed through the
 * authenticated `GET /api/notifications`, so a channel subscriber learns nothing about the
 * notification itself.
 */

/**
 * The namespace prefix of the notifications channel, colon included. Private: every reader goes
 * through {@link notificationsChannelName}, so the spelling has one definition.
 */
const NOTIFICATIONS_NAMESPACE_PREFIX = 'notifications:';

/** `notifications:{userId}` — one private channel per recipient. */
export function notificationsChannelName(userId: string): string {
  return `${NOTIFICATIONS_NAMESPACE_PREFIX}${userId}`;
}

/** Channel message name: a new in-app notification row was written for this user. No payload. */
export const NOTIFICATIONS_EVENT_CREATED = 'notification.created';

/** Channel message name: this user's notification rows were marked read. No payload. */
export const NOTIFICATIONS_EVENT_READ = 'notification.read';
