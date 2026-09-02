import { describe, expect, it } from 'vitest';
import type { MeetingLifecycleStatus } from './lifecycle';
import { MEETING_CLOSED_TO_JOIN, meetingIsClosedToJoin } from './closed-to-join';

describe('MEETING_CLOSED_TO_JOIN — a TERMINAL set, never an allow-list', () => {
  it('closes exactly `ended` and `cancelled`', () => {
    expect([...MEETING_CLOSED_TO_JOIN].sort((a, b) => a.localeCompare(b))).toEqual([
      'cancelled',
      'ended',
    ]);
  });

  it('⚠ leaves `waiting_for_participants` OPEN — the state joining matters most in', () => {
    // An `IN ('scheduled','in_progress')` ALLOW-list would have excluded this silently. That
    // is the whole argument for naming what is closed instead.
    expect(meetingIsClosedToJoin('waiting_for_participants')).toBe(false);
  });

  it('is a TERMINAL set, not an allow-list — its size is 2 and it is not the complement of an open set', () => {
    expect(MEETING_CLOSED_TO_JOIN.size).toBe(2);
    // The complement an ALLOW-list would have named — `['scheduled', 'in_progress']` — is a
    // strict two-member set too, but a DIFFERENT one: proving this is not that set is what
    // proves the naming direction, not just the count.
    expect(MEETING_CLOSED_TO_JOIN.has('scheduled')).toBe(false);
    expect(MEETING_CLOSED_TO_JOIN.has('in_progress')).toBe(false);
  });

  // A table over EVERY member of MeetingLifecycleStatus. Exhaustiveness is enforced by typing
  // the fixture as Record<MeetingLifecycleStatus, boolean> — a sixth enum label fails to
  // compile here until somebody writes a row for it, and the default answer is OPEN (false),
  // the opposite default direction from `cancellable.test.ts` / `reschedulable.test.ts` — see
  // this module's own docblock for why a JOIN gate must default open.
  const EXPECTED_CLOSED: Record<MeetingLifecycleStatus, boolean> = {
    scheduled: false,
    waiting_for_participants: false,
    in_progress: false,
    ended: true,
    cancelled: true,
  };

  it.each(Object.entries(EXPECTED_CLOSED) as [MeetingLifecycleStatus, boolean][])(
    'status=%s → closedToJoin=%s',
    (status, expected) => {
      expect(meetingIsClosedToJoin(status)).toBe(expected);
      expect(MEETING_CLOSED_TO_JOIN.has(status)).toBe(expected);
    }
  );

  it('is pure — the same status always yields the same answer', () => {
    expect(meetingIsClosedToJoin('ended')).toBe(meetingIsClosedToJoin('ended'));
    expect(meetingIsClosedToJoin('scheduled')).toBe(meetingIsClosedToJoin('scheduled'));
  });
});
