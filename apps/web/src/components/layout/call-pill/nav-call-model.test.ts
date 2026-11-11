import { describe, it, expect } from 'vitest';
import type { NavCallView } from '@/lib/meetings/nav-call-view-types';
import {
  navCallEventProps,
  navCallIsQuiet,
  navCallPartyName,
  selectNavCalls,
} from './nav-call-model';

const MIN = 60_000;
const T0 = new Date('2026-09-17T10:00:00.000Z');

function at(minutesFromT0: number): Date {
  return new Date(T0.getTime() + minutesFromT0 * MIN);
}

function call(overrides: Partial<NavCallView> = {}): NavCallView {
  return {
    meetingId: 'm-1',
    contextType: 'case',
    title: 'Case title',
    counterpartyName: 'Priya',
    counterpartyOrgLabel: null,
    scheduledStart: T0.toISOString(),
    scheduledEnd: at(30).toISOString(),
    status: 'scheduled',
    href: '/cases/eng-1',
    joinPath: '/meetings/m-1/call',
    rescheduleProposalExpiresAt: null,
    roomReady: true,
    otherWorkspace: false,
    ...overrides,
  };
}

describe('selectNavCalls — window', () => {
  it('a start 4 minutes out is not a candidate', () => {
    const result = selectNavCalls([call()], at(-4), '/dashboard');
    expect(result.primary).toBeNull();
    expect(result.others).toEqual([]);
  });

  it('start − 3 minutes is joinable', () => {
    const result = selectNavCalls([call()], at(-3), '/dashboard');
    expect(result.primary?.call.meetingId).toBe('m-1');
    expect(result.primary?.timing.joinVisible).toBe(true);
  });

  it('30 minutes after the scheduled end the call drops out', () => {
    const result = selectNavCalls([call()], at(30 + 30), '/dashboard');
    expect(result.primary).toBeNull();
  });

  it('an open window with no ready room is a candidate showing the setting-up state', () => {
    const result = selectNavCalls([call({ roomReady: false })], at(-1), '/dashboard');
    expect(result.primary?.timing.roomSettingUp).toBe(true);
    expect(result.primary?.timing.joinVisible).toBe(false);
  });

  it('an empty list yields no primary', () => {
    expect(selectNavCalls([], T0, '/dashboard')).toEqual({ primary: null, others: [] });
  });
});

describe('selectNavCalls — back-to-back', () => {
  it('at 9:58 a 9:30 call (in grace) and a 10:00 call → primary is 10:00, others is [9:30]', () => {
    const earlier = call({
      meetingId: 'm-930',
      scheduledStart: at(-30).toISOString(),
      scheduledEnd: at(-2).toISOString(),
    });
    const later = call({ meetingId: 'm-1000' });

    const result = selectNavCalls([earlier, later], at(-2), '/dashboard');

    expect(result.primary?.call.meetingId).toBe('m-1000');
    expect(result.others.map((c) => c.call.meetingId)).toEqual(['m-930']);
  });

  it('is independent of input order and breaks start ties by meeting id', () => {
    const a = call({ meetingId: 'm-a' });
    const b = call({ meetingId: 'm-b' });

    const forward = selectNavCalls([a, b], T0, '/dashboard');
    const reversed = selectNavCalls([b, a], T0, '/dashboard');

    expect(forward.primary?.call.meetingId).toBe('m-a');
    expect(reversed.primary?.call.meetingId).toBe('m-a');
    expect(forward.others.map((c) => c.call.meetingId)).toEqual(['m-b']);
  });
});

describe('selectNavCalls — own recap/end page', () => {
  it.each(['/meetings/m-1000', '/meetings/m-1000/end'])(
    'on %s the excluded call drops out and the next candidate is promoted',
    (pathname) => {
      const earlier = call({
        meetingId: 'm-930',
        scheduledStart: at(-30).toISOString(),
        scheduledEnd: at(-2).toISOString(),
      });
      const later = call({ meetingId: 'm-1000' });

      const result = selectNavCalls([earlier, later], at(-2), pathname);

      expect(result.primary?.call.meetingId).toBe('m-930');
      expect(result.others).toEqual([]);
    }
  );

  it('another meeting’s recap page excludes nothing', () => {
    const result = selectNavCalls([call()], T0, '/meetings/other');
    expect(result.primary?.call.meetingId).toBe('m-1');
  });
});

describe('navCallIsQuiet', () => {
  it('is quiet when a page-level Join is live', () => {
    expect(navCallIsQuiet({ joinOnPage: true, now: T0, scheduledEnd: at(30) })).toBe(true);
  });

  it('is quiet from the scheduled end onward (overrun grace)', () => {
    expect(navCallIsQuiet({ joinOnPage: false, now: at(30), scheduledEnd: at(30) })).toBe(true);
    expect(navCallIsQuiet({ joinOnPage: false, now: at(40), scheduledEnd: at(30) })).toBe(true);
  });

  it('is loud before the end with no page-level Join', () => {
    expect(navCallIsQuiet({ joinOnPage: false, now: at(29), scheduledEnd: at(30) })).toBe(false);
  });
});

describe('navCallEventProps', () => {
  it('projects the shared base with a signed, unfloored minutes_to_start', () => {
    const candidate = { call: call({ otherWorkspace: true }), timing: selectTiming(at(-3)) };

    expect(
      navCallEventProps(candidate, { now: at(-3), quiet: false, workspaceType: 'company' })
    ).toEqual({
      meeting_type: 'case',
      minutes_to_start: 3,
      quiet: false,
      other_workspace: true,
      workspace_type: 'company',
    });
  });

  it('goes negative once the call has started', () => {
    const candidate = { call: call(), timing: selectTiming(at(12)) };
    const props = navCallEventProps(candidate, {
      now: at(12),
      quiet: true,
      workspaceType: 'expert',
    });
    expect(props.minutes_to_start).toBe(-12);
    expect(props.quiet).toBe(true);
  });
});

function selectTiming(now: Date) {
  const primary = selectNavCalls([call()], now, '/dashboard').primary;
  if (primary === null) throw new Error('expected a candidate');
  return primary.timing;
}

describe('navCallPartyName', () => {
  it('uses the counterparty name', () => {
    expect(navCallPartyName({ counterpartyName: 'Priya', contextType: 'case' })).toBe('Priya');
  });

  it('falls back to the meeting type label', () => {
    expect(navCallPartyName({ counterpartyName: null, contextType: 'case' })).toBe('Consultation');
  });
});
