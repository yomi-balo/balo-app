import { describe, expect, it } from 'vitest';
import type { MeetingLifecycleStatus } from './lifecycle';
import { RESCHEDULABLE_MEETING_STATUSES, resolveRescheduleRefusal } from './reschedulable';

const FUTURE = new Date('2026-09-01T10:00:00.000Z');
const NOW = new Date('2026-08-24T10:00:00.000Z');
const PAST = new Date('2026-08-01T10:00:00.000Z');

describe('resolveRescheduleRefusal — T-SHARED-1', () => {
  // A table over EVERY member of MeetingLifecycleStatus. Exhaustiveness is enforced by typing
  // the fixture as Record<MeetingLifecycleStatus, boolean> — a sixth enum label fails to
  // compile here until somebody writes a row for it, and the default answer is DENY.
  const EXPECTED_RESCHEDULABLE: Record<MeetingLifecycleStatus, boolean> = {
    scheduled: true,
    waiting_for_participants: false,
    in_progress: false,
    ended: false,
    cancelled: false,
  };

  it.each(Object.entries(EXPECTED_RESCHEDULABLE) as [MeetingLifecycleStatus, boolean][])(
    'status=%s → reschedulable=%s',
    (status, expected) => {
      const refusal = resolveRescheduleRefusal(status, FUTURE, NOW);
      expect(refusal === null).toBe(expected);
      if (!expected) {
        expect(refusal).toBe('status_not_reschedulable');
      }
    }
  );

  it('exactly one status is reschedulable', () => {
    const reschedulable = Object.values(EXPECTED_RESCHEDULABLE).filter(Boolean);
    expect(reschedulable).toHaveLength(1);
    expect(RESCHEDULABLE_MEETING_STATUSES).toEqual(['scheduled']);
  });

  it('a future scheduledStart is reschedulable', () => {
    expect(resolveRescheduleRefusal('scheduled', FUTURE, NOW)).toBeNull();
  });

  it('a past scheduledStart is already_started', () => {
    expect(resolveRescheduleRefusal('scheduled', PAST, NOW)).toBe('already_started');
  });

  it('scheduledStart === now counts as started', () => {
    expect(resolveRescheduleRefusal('scheduled', NOW, NOW)).toBe('already_started');
  });

  it('fails closed on an Invalid Date scheduledStart', () => {
    expect(resolveRescheduleRefusal('scheduled', new Date('not-a-date'), NOW)).toBe(
      'invalid_instant'
    );
  });

  it('fails closed on an Invalid Date now', () => {
    expect(resolveRescheduleRefusal('scheduled', FUTURE, new Date('not-a-date'))).toBe(
      'invalid_instant'
    );
  });

  it('invalid_instant takes precedence over status_not_reschedulable', () => {
    expect(resolveRescheduleRefusal('cancelled', new Date('not-a-date'), NOW)).toBe(
      'invalid_instant'
    );
  });

  it('status_not_reschedulable takes precedence over already_started', () => {
    // waiting_for_participants with a past start would ALSO be "already_started" if status
    // were allowed through — the status check must fire first.
    expect(resolveRescheduleRefusal('waiting_for_participants', PAST, NOW)).toBe(
      'status_not_reschedulable'
    );
  });
});
