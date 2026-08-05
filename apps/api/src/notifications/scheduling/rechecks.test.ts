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

afterEach(() => {
  // The registry is module-level state; a test that registers must not leak into the next.
  for (const key of Object.keys(SCHEDULED_RECHECKS)) {
    delete SCHEDULED_RECHECKS[key];
  }
});

describe('SCHEDULED_RECHECKS', () => {
  it('ships EMPTY — BAL-420 ships the primitive inert; consumers register in their own PR', () => {
    expect(Object.keys(SCHEDULED_RECHECKS)).toEqual([]);
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
