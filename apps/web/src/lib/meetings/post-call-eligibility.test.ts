import { describe, it, expect } from 'vitest';
import { meetingAllowsPostCallActions } from './post-call-eligibility';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const PAST = new Date('2026-08-13T11:00:00.000Z');
const FUTURE = new Date('2026-08-13T13:00:00.000Z');

describe('meetingAllowsPostCallActions — the time half', () => {
  it('DENIES a meeting whose scheduled start is still in the future', () => {
    expect(meetingAllowsPostCallActions({ scheduledStart: FUTURE, status: 'scheduled' }, NOW)).toBe(
      false
    );
  });

  it('ALLOWS a past-start meeting that is still `scheduled` — the 100% case today', () => {
    // ⚠ THE ASSERTION THAT KEEPS THE FEATURE ALIVE. `meetings.status` has no live transition
    // writer (BAL-134 is Backlog), so every real row sits at `scheduled`. A rule that required
    // `ended` — or `started_at != null`, which NOTHING writes — would deny 100% of sessions.
    expect(meetingAllowsPostCallActions({ scheduledStart: PAST, status: 'scheduled' }, NOW)).toBe(
      true
    );
  });

  it('ALLOWS exactly at the scheduled start — the boundary is inclusive', () => {
    expect(meetingAllowsPostCallActions({ scheduledStart: NOW, status: 'scheduled' }, NOW)).toBe(
      true
    );
  });

  it('DENIES one millisecond before the scheduled start', () => {
    const aHairEarly = new Date(NOW.getTime() - 1);
    expect(
      meetingAllowsPostCallActions({ scheduledStart: NOW, status: 'scheduled' }, aHairEarly)
    ).toBe(false);
  });

  it('reads the wall clock when no clock is injected', () => {
    const longAgo = new Date('2020-01-01T00:00:00.000Z');
    const farOff = new Date('2099-01-01T00:00:00.000Z');
    expect(meetingAllowsPostCallActions({ scheduledStart: longAgo, status: 'scheduled' })).toBe(
      true
    );
    expect(meetingAllowsPostCallActions({ scheduledStart: farOff, status: 'scheduled' })).toBe(
      false
    );
  });
});

describe('meetingAllowsPostCallActions — the cancelled half', () => {
  it('DENIES a cancelled meeting even though its start has long passed', () => {
    // ⚠ THE LIVE HALF. `status='cancelled'` IS written today by `meetingsRepository.cancel()`,
    // so this branch guards real rows rather than a hypothetical future state.
    expect(meetingAllowsPostCallActions({ scheduledStart: PAST, status: 'cancelled' }, NOW)).toBe(
      false
    );
  });

  it('DENIES a cancelled meeting whose start is also in the future — both halves fail', () => {
    expect(meetingAllowsPostCallActions({ scheduledStart: FUTURE, status: 'cancelled' }, NOW)).toBe(
      false
    );
  });

  it('ALLOWS every non-cancelled status once the start has passed', () => {
    for (const status of [
      'scheduled',
      'waiting_for_participants',
      'in_progress',
      'ended',
    ] as const) {
      expect(
        meetingAllowsPostCallActions({ scheduledStart: PAST, status }, NOW),
        status + ' must be allowed once the start has passed'
      ).toBe(true);
    }
  });
});

describe('meetingAllowsPostCallActions — the ACCEPTED residual', () => {
  it('still ALLOWS a no-show whose scheduled start has passed', () => {
    // ⚠ DOCUMENTED AND ACCEPTED, NOT AN OVERSIGHT. The platform has no evidence a call happened
    // (`started_at` has no writer), and the close ALREADY requires a client-company member plus a
    // mandatory confirmation — so the worst case is a legitimate member deliberately closing
    // their OWN case after a no-show. BAL-134 tightens this to `started_at != null`.
    expect(meetingAllowsPostCallActions({ scheduledStart: PAST, status: 'scheduled' }, NOW)).toBe(
      true
    );
  });
});
