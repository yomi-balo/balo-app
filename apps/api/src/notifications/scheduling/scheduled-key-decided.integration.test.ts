import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * BAL-134 / BAL-654 — "ONCE PER KEY" AGAINST A REAL POSTGRES.
 *
 * `scheduled_notifications`' dedupe key folds only onto PENDING rows (a partial unique index), so
 * "a fired promise is not armed again" lives in the key's HISTORY, read by `isScheduledKeyDecided`.
 * The unit suites pin the pure decision and the arm sites over mocked history; this file pins the
 * claim they all rest on — that the rows `scheduleNotification` really writes, moved through the
 * statuses the dispatch tick really sets, make the next arm a no-op (or not).
 *
 * ⚠ THIS FILE LIVES IN `apps/api` BUT RUNS FROM `packages/db/vitest.config.integration.ts`; see
 * `receivable-dunning-sweep.integration.test.ts` for the harness. Every write rolls back with the
 * per-test transaction. `pnpm test:integration` passes VACUOUSLY without Docker — check the
 * reported file and test counts, never the exit code.
 *
 * Mocks, and only these: the Redis-backed modules the waiting-SMS guard imports but this file
 * never reaches. `@balo/db`, the scheduler and the repository are the production code.
 */

vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../lib/rate-limiter.js', () => ({
  RATE_LIMIT_DEADLINE_MS: 2000,
  checkRateLimit: vi.fn(),
  releaseRateLimitSlot: vi.fn(),
}));

import { scheduledNotificationsRepository, type ScheduledNotification } from '@balo/db';
import { DEFAULT_MEETING_TIMERS } from '@balo/shared/meetings';
import { expertAbsentKey, scheduleExpertAbsentAlert } from './meeting-absence.js';
import {
  isWaitingSmsDecided,
  meetingWaitingSmsKey,
  scheduleWaitingPartySms,
  type ScheduleWaitingPartySmsInput,
} from './meeting-waiting-sms.js';

const CLAIM = { claimTtlMinutes: 5, maxAttempts: 3 } as const;

function waitingInput(meetingId: string): ScheduleWaitingPartySmsInput {
  const scheduledStart = new Date(Date.now() - 5 * 60_000);
  return {
    meetingId,
    scheduledStart,
    direction: 'to_client',
    waiterFirstJoinedAt: scheduledStart,
    companyId: randomUUID(),
    expertProfileId: randomUUID(),
  };
}

function absentAlertInput(meetingId: string): Parameters<typeof scheduleExpertAbsentAlert>[0] {
  const scheduledStart = new Date(Date.now() - 10 * 60_000);
  return {
    meetingId,
    scheduledStart,
    absenceAnchor: scheduledStart,
    contextType: 'case',
    timers: DEFAULT_MEETING_TIMERS,
  };
}

function historyOf(key: string): Promise<ScheduledNotification[]> {
  return scheduledNotificationsRepository.findByDedupeKey(key);
}

/** The pending row the arm just wrote — the one the dispatch tick would claim next. */
async function pendingRow(key: string): Promise<ScheduledNotification> {
  const pending = (await historyOf(key)).find((row) => row.status === 'pending');
  if (pending === undefined) {
    throw new Error(`expected a pending row for ${key}`);
  }
  return pending;
}

/** The dispatch tick's own path: claim, then the terminal mark. */
async function claimAnd(
  key: string,
  terminal: (id: string) => Promise<void>
): Promise<ScheduledNotification> {
  const pending = await pendingRow(key);
  const claimed = await scheduledNotificationsRepository.claim({ id: pending.id, ...CLAIM });
  if (claimed === undefined) {
    throw new Error(`could not claim ${pending.id}`);
  }
  await terminal(claimed.id);
  return pending;
}

describe('the waiting-party SMS key is armed once per meeting', () => {
  it('arms nothing once the promise has been published', async () => {
    const meetingId = randomUUID();
    const key = meetingWaitingSmsKey(meetingId);

    await scheduleWaitingPartySms(waitingInput(meetingId));
    expect(await historyOf(key)).toHaveLength(1);
    expect(await isWaitingSmsDecided(meetingId)).toBe(false);

    const fired = await claimAnd(key, (id) => scheduledNotificationsRepository.markPublished(id));

    expect(await isWaitingSmsDecided(meetingId)).toBe(true);
    await scheduleWaitingPartySms(waitingInput(meetingId));

    const history = await historyOf(key);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: fired.id, status: 'published' });
  });

  it('arms nothing while the first send is claimed and in flight', async () => {
    const meetingId = randomUUID();
    const key = meetingWaitingSmsKey(meetingId);
    await scheduleWaitingPartySms(waitingInput(meetingId));
    const pending = await pendingRow(key);
    await scheduledNotificationsRepository.claim({ id: pending.id, ...CLAIM });

    await scheduleWaitingPartySms(waitingInput(meetingId));

    const history = await historyOf(key);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe('claimed');
  });

  it('arms again after a re-armable skip (waiter_left)', async () => {
    const meetingId = randomUUID();
    const key = meetingWaitingSmsKey(meetingId);
    await scheduleWaitingPartySms(waitingInput(meetingId));
    const skipped = await claimAnd(key, (id) =>
      scheduledNotificationsRepository.markSkipped(id, 'waiter_left')
    );

    expect(await isWaitingSmsDecided(meetingId)).toBe(false);
    await scheduleWaitingPartySms(waitingInput(meetingId));

    const history = await historyOf(key);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === skipped.id)?.status).toBe('skipped');
    expect(history.filter((row) => row.status === 'pending')).toHaveLength(1);
  });

  it('does not arm again after a final skip', async () => {
    const meetingId = randomUUID();
    const key = meetingWaitingSmsKey(meetingId);
    await scheduleWaitingPartySms(waitingInput(meetingId));
    await claimAnd(key, (id) => scheduledNotificationsRepository.markSkipped(id, 'no_number'));

    expect(await isWaitingSmsDecided(meetingId)).toBe(true);
    await scheduleWaitingPartySms(waitingInput(meetingId));

    expect(await historyOf(key)).toHaveLength(1);
  });
});

describe('the expert-absent alert key is armed once per meeting, but a failed send re-arms', () => {
  it('arms nothing once the alert has been published', async () => {
    const meetingId = randomUUID();
    const key = expertAbsentKey(meetingId);
    await scheduleExpertAbsentAlert(absentAlertInput(meetingId));
    await claimAnd(key, (id) => scheduledNotificationsRepository.markPublished(id));

    await scheduleExpertAbsentAlert(absentAlertInput(meetingId));

    expect(await historyOf(key)).toHaveLength(1);
  });

  it('arms again after a terminally failed send, so one failed delivery cannot silence the alert', async () => {
    const meetingId = randomUUID();
    const key = expertAbsentKey(meetingId);
    await scheduleExpertAbsentAlert(absentAlertInput(meetingId));
    const failed = await claimAnd(key, (id) =>
      scheduledNotificationsRepository.markFailed(id, 'provider down')
    );

    await scheduleExpertAbsentAlert(absentAlertInput(meetingId));

    const history = await historyOf(key);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === failed.id)?.status).toBe('failed');
    expect(history.filter((row) => row.status === 'pending')).toHaveLength(1);
  });

  it('arms again after a venue skip, and not after a final one', async () => {
    const venueMeeting = randomUUID();
    await scheduleExpertAbsentAlert(absentAlertInput(venueMeeting));
    await claimAnd(expertAbsentKey(venueMeeting), (id) =>
      scheduledNotificationsRepository.markSkipped(id, 'venue_unavailable')
    );
    await scheduleExpertAbsentAlert(absentAlertInput(venueMeeting));
    expect(await historyOf(expertAbsentKey(venueMeeting))).toHaveLength(2);

    const joinedMeeting = randomUUID();
    await scheduleExpertAbsentAlert(absentAlertInput(joinedMeeting));
    await claimAnd(expertAbsentKey(joinedMeeting), (id) =>
      scheduledNotificationsRepository.markSkipped(id, 'expert_joined_before_alert')
    );
    await scheduleExpertAbsentAlert(absentAlertInput(joinedMeeting));
    expect(await historyOf(expertAbsentKey(joinedMeeting))).toHaveLength(1);
  });
});
