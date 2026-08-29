import { describe, expect, it } from 'vitest';
import type { MeetingLifecycleStatus } from './lifecycle';
import { CANCELLABLE_MEETING_STATUSES, resolveCancelRefusal } from './cancellable';
import { resolveRescheduleRefusal } from './reschedulable';

describe('resolveCancelRefusal — BAL-410 D5', () => {
  // A table over EVERY member of MeetingLifecycleStatus. Exhaustiveness is enforced by typing
  // the fixture as Record<MeetingLifecycleStatus, boolean> — a sixth enum label fails to
  // compile here until somebody writes a row for it, and the default answer is DENY.
  const EXPECTED_CANCELLABLE: Record<MeetingLifecycleStatus, boolean> = {
    scheduled: true,
    waiting_for_participants: false,
    in_progress: false,
    ended: false,
    cancelled: false,
  };

  it.each(Object.entries(EXPECTED_CANCELLABLE) as [MeetingLifecycleStatus, boolean][])(
    'status=%s → cancellable=%s',
    (status, expected) => {
      const refusal = resolveCancelRefusal(status);
      expect(refusal === null).toBe(expected);
      if (!expected) {
        expect(refusal).toBe('status_not_cancellable');
      }
    }
  );

  it('exactly one status is cancellable', () => {
    const cancellable = Object.values(EXPECTED_CANCELLABLE).filter(Boolean);
    expect(cancellable).toHaveLength(1);
    expect(CANCELLABLE_MEETING_STATUSES).toEqual(['scheduled']);
  });

  /**
   * The AC — "cancellation is unavailable once the meeting has started" — is delivered by
   * STATE. `waiting_for_participants` is the first status a joined meeting reaches, and it is
   * refused here.
   */
  it('refuses every status a joined meeting can be in', () => {
    for (const status of ['waiting_for_participants', 'in_progress', 'ended'] as const) {
      expect(resolveCancelRefusal(status)).toBe('status_not_cancellable');
    }
  });

  /**
   * ⚠ THE ONE DELIBERATE DISAGREEMENT WITH `resolveRescheduleRefusal` (D5), pinned so nobody
   * "aligns" the two guards. A `scheduled` meeting whose start has passed and which nobody
   * joined is STILL CANCELLABLE — reschedule refuses it (`already_started`), cancel does not,
   * because with no presence there is nothing to settle and cancelling charges nobody.
   */
  it('a past-start, never-joined scheduled meeting is still cancellable — where reschedule refuses it', () => {
    const now = new Date('2026-08-24T10:00:00.000Z');
    const pastStart = new Date('2026-08-24T09:00:00.000Z');

    expect(resolveCancelRefusal('scheduled')).toBeNull();
    expect(resolveRescheduleRefusal('scheduled', pastStart, now)).toBe('already_started');
  });

  /** PURE: the answer depends on the status alone, so repeated calls cannot drift with time. */
  it('is pure — the same status always yields the same answer', () => {
    expect(resolveCancelRefusal('scheduled')).toBe(resolveCancelRefusal('scheduled'));
    expect(resolveCancelRefusal('cancelled')).toBe(resolveCancelRefusal('cancelled'));
  });
});
