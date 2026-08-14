import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';
import { SCHEDULED_RECHECKS, runRecheck, UnknownRecheckError } from './rechecks.js';

function row(overrides: Partial<ScheduledNotification> = {}): ScheduledNotification {
  return {
    id: 'row-1',
    dedupeKey: 'meeting_expert_absent:m-1',
    event: 'user.welcome',
    payload: { correlationId: 'c-1', stored: true },
    scheduledFor: new Date('2026-08-05T12:00:00.000Z'),
    status: 'claimed',
    mode: 'first_wins',
    recheck: null,
    attempts: 1,
    claimedAt: new Date('2026-08-05T12:00:01.000Z'),
    publishedAt: null,
    cancelledAt: null,
    skipReason: null,
    lastError: null,
    createdAt: new Date('2026-08-05T11:00:00.000Z'),
    updatedAt: new Date('2026-08-05T11:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

/**
 * The registry's BUILT-IN entries, snapshotted before any test registers an ad-hoc guard.
 *
 * ⚠ RESTORED (not emptied) in `afterEach`. BAL-424 registered the first real consumer, so a
 * blanket delete of every key would strip `conversation_unread` for the rest of the file.
 */
const BUILT_IN_RECHECKS = { ...SCHEDULED_RECHECKS };

afterEach(() => {
  // The registry is module-level state; a test that registers must not leak into the next.
  for (const key of Object.keys(SCHEDULED_RECHECKS)) {
    delete SCHEDULED_RECHECKS[key];
  }
  Object.assign(SCHEDULED_RECHECKS, BUILT_IN_RECHECKS);
});

describe('SCHEDULED_RECHECKS', () => {
  /**
   * BAL-420 shipped this registry EMPTY, naming BAL-424 (conversation unread) as a
   * PROSPECTIVE consumer "if it takes the dependency at all". It took it, and BAL-134 added the
   * next two.
   *
   * ⚠ AN EXACT-SET ASSERTION ON PURPOSE. An UNREGISTERED recheck name fails CLOSED (terminal
   * `failed` + `log.error`), so a promise armed against a missing guard is a DEAD alert — and
   * BAL-134's expert-absent alert is the one Balo has operationally committed to. Registering a
   * name without its consumer, or shipping a consumer without its name, must come past here.
   */
  it('carries exactly three guards: BAL-424 conversation_unread + BAL-134 absence pair', () => {
    expect(Object.keys(BUILT_IN_RECHECKS)).toEqual([
      'conversation_unread',
      'meeting_expert_absent',
      'meeting_client_absent',
    ]);
  });

  it('dispatches a conversation_unread row to that guard', async () => {
    // The guard reads live state; here it only has to be REACHED, so a payload with no
    // `conversationId` is the cheapest terminal answer that proves dispatch happened.
    const subject = row({ recheck: 'conversation_unread', payload: { correlationId: 'c-1' } });
    await expect(runRecheck(subject)).resolves.toEqual({
      publish: false,
      reason: 'malformed_payload',
    });
  });
});

describe('runRecheck', () => {
  it('NULL recheck ⇒ publish the STORED payload unconditionally', async () => {
    const subject = row({ recheck: null });

    await expect(runRecheck(subject)).resolves.toEqual({
      publish: true,
      payload: subject.payload,
    });
  });

  it('blank recheck is treated as absent, not as a name to look up', async () => {
    const subject = row({ recheck: '   ' });

    await expect(runRecheck(subject)).resolves.toEqual({
      publish: true,
      payload: subject.payload,
    });
  });

  it('delegates to a REGISTERED guard and returns ITS payload, not the stored one', async () => {
    const rebuilt = { correlationId: 'c-1', unreadCount: 3 };
    const guard = vi.fn().mockResolvedValue({ publish: true, payload: rebuilt });
    SCHEDULED_RECHECKS.conversation_unread = guard;
    const subject = row({ recheck: 'conversation_unread' });

    const result = await runRecheck(subject);

    expect(guard).toHaveBeenCalledWith(subject);
    // The stored payload is the DEFAULT answer, never the answer — the guard just read
    // live state and hands back what it found.
    expect(result).toEqual({ publish: true, payload: rebuilt });
  });

  it('passes a declining guard through as a NORMAL {publish:false} outcome', async () => {
    SCHEDULED_RECHECKS.conversation_unread = vi
      .fn()
      .mockResolvedValue({ publish: false, reason: 'all_read' });

    await expect(runRecheck(row({ recheck: 'conversation_unread' }))).resolves.toEqual({
      publish: false,
      reason: 'all_read',
    });
  });

  it('an UNREGISTERED name THROWS UnknownRecheckError — never a silent publish or skip', async () => {
    // The deploy-skew case: a row written by an older build whose guard was renamed or
    // removed. Failing closed on an unknown guard is the only safe reading.
    const subject = row({ recheck: 'guard_that_was_deleted' });

    await expect(runRecheck(subject)).rejects.toBeInstanceOf(UnknownRecheckError);
    await expect(runRecheck(subject)).rejects.toThrow(/guard_that_was_deleted/);
  });

  it('UnknownRecheckError carries the offending name for the log line', async () => {
    const error = await runRecheck(row({ recheck: 'gone' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnknownRecheckError);
    expect((error as UnknownRecheckError).recheck).toBe('gone');
    expect((error as UnknownRecheckError).name).toBe('UnknownRecheckError');
  });

  it('does NOT catch a guard that throws — the tick leaves such a row `claimed`', async () => {
    SCHEDULED_RECHECKS.flaky = vi.fn().mockRejectedValue(new Error('db blip'));

    // A transient failure must not consume the notification: it is retried after the claim
    // TTL and only becomes terminal once attempts are exhausted.
    await expect(runRecheck(row({ recheck: 'flaky' }))).rejects.toThrow('db blip');
  });
});
