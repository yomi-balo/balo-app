import { randomUUID } from 'node:crypto';
import { db } from '../../client';
import { scheduledNotifications } from '../../schema';
import type { NewScheduledNotification, ScheduledNotification } from '../../schema';

interface ScheduledNotificationFactoryOverrides {
  /** Reuse a specific dedup key instead of a fresh unique one. */
  dedupeKey?: string;
  /** Row-level overrides (status, attempts, claimedAt, scheduledFor, payload, deletedAt, …). */
  values?: Partial<NewScheduledNotification>;
}

/**
 * Seeds one `scheduled_notifications` row (default `status='pending'`, `mode='first_wins'`,
 * `scheduled_for` one minute in the past so it is immediately due, and a fresh unique
 * dedup key so parallel cases never collide on the partial unique).
 *
 * Inserts DIRECTLY via `db`, not through `scheduledNotificationsRepository.schedule()`, so a
 * test can seed ANY state — `claimed` with a stale `claimed_at`, `attempts` already at the
 * ceiling, terminal, soft-deleted — none of which the repository will produce, by design.
 * Same rationale as `transcript.factory` / `meeting.factory`: the repository's write path is
 * the thing UNDER test, so it must not also be the only way to reach a fixture.
 *
 * `scheduled_notifications` has NO foreign keys, so there is nothing to seed underneath it.
 */
export async function scheduledNotificationFactory(
  overrides: ScheduledNotificationFactoryOverrides = {}
): Promise<ScheduledNotification> {
  const [row] = await db
    .insert(scheduledNotifications)
    .values({
      dedupeKey: overrides.dedupeKey ?? `sched-${randomUUID()}`,
      event: 'meeting.participant_absent',
      payload: { meetingId: randomUUID(), scheduledStart: '2026-08-05T10:00:00.000Z' },
      scheduledFor: new Date(Date.now() - 60_000),
      ...overrides.values,
    })
    .returning();
  if (row === undefined) {
    throw new Error('scheduled notification insert failed');
  }
  return row;
}
