import { describe, expect, it } from 'vitest';
import {
  CALL_HOURS,
  CALL_NOW_RING_MS,
  CALL_NOW_RING_SMS_MS,
  CALL_NOW_SCHEDULED_MINUTES,
  NO_CALL_NOW_FACTS,
  RING_TOKEN_GRACE_MS,
  callNowFactsFromRings,
  clipUnansweredRingIntervals,
  isRingLive,
  isSameLocalDay,
  isWithinCallHours,
  resolveCallNowAvailability,
  ringAnalyticsOutcome,
  selectInPlaceCandidate,
  type CallNowGateFacts,
  type CallRingFacts,
  type CallRingStatus,
} from './call-now';
import { joinWindowOpensAt } from '../engagements';
import { MIN_MEETING_MINUTES } from './bounds';
import {
  resolveTerminalRule,
  summarisePresence,
  type LifecyclePresenceInterval,
} from './lifecycle';
import { DEFAULT_MEETING_TIMERS } from './timers';

const MINUTE = 60_000;
const START = new Date('2026-08-14T10:00:00.000Z');

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

function ring(overrides: Partial<CallRingFacts> = {}): CallRingFacts {
  return {
    placement: 'new_meeting',
    status: 'ringing',
    createdAt: at(0),
    expiresAt: at(1),
    endedAt: null,
    ...overrides,
  };
}

describe('constants', () => {
  it('pins the ring windows, the created meeting window and the call hours', () => {
    expect(CALL_NOW_RING_MS).toBe(45_000);
    expect(CALL_NOW_RING_SMS_MS).toBe(120_000);
    expect(CALL_NOW_SCHEDULED_MINUTES).toBe(MIN_MEETING_MINUTES);
    expect(CALL_HOURS).toEqual({ startHour: 8, endHour: 20 });
  });
});

describe('callNowFactsFromRings', () => {
  it('is booked with no ring for a meeting nobody rang', () => {
    expect(callNowFactsFromRings([])).toEqual(NO_CALL_NOW_FACTS);
  });

  it('is call_now when any ring created the meeting, whatever the order', () => {
    const created = ring({ placement: 'new_meeting', createdAt: at(0) });
    const inPlace = ring({ placement: 'in_place', createdAt: at(5) });
    expect(callNowFactsFromRings([inPlace, created]).origin).toBe('call_now');
    expect(callNowFactsFromRings([created, inPlace]).origin).toBe('call_now');
  });

  it('stays booked when only in-place rings exist', () => {
    expect(callNowFactsFromRings([ring({ placement: 'in_place' })]).origin).toBe('booked');
  });

  it('reports the latest ring by createdAt', () => {
    const older = ring({ placement: 'in_place', status: 'unanswered', createdAt: at(0) });
    const newer = ring({ placement: 'in_place', status: 'ringing', createdAt: at(10) });
    expect(callNowFactsFromRings([newer, older]).ring).toBe(newer);
    expect(callNowFactsFromRings([older, newer]).ring).toBe(newer);
  });
});

describe('isRingLive', () => {
  it('is live while ringing and inside the window', () => {
    expect(isRingLive(ring({ expiresAt: at(1) }), at(0))).toBe(true);
  });

  it('is not live at or after expiresAt, even if the row still says ringing', () => {
    expect(isRingLive(ring({ expiresAt: at(1) }), at(1))).toBe(false);
    expect(isRingLive(ring({ expiresAt: at(1) }), at(2))).toBe(false);
  });

  it.each(['connected', 'unanswered', 'declined', 'stopped'] as const)(
    'is never live once %s, even inside the window',
    (status) => {
      expect(isRingLive(ring({ status, expiresAt: at(10) }), at(0))).toBe(false);
    }
  );
});

describe('clipUnansweredRingIntervals', () => {
  // `at(0)` reads as 2:00 pm; the booking starts at 4:00 pm, so its join window opens at 3:57 pm.
  const SECOND = 1_000;
  const BOOKED_START = at(120);
  const WINDOW_OPENS = joinWindowOpensAt(BOOKED_START);
  const declined2pm = ring({
    placement: 'in_place',
    status: 'declined',
    createdAt: at(0),
    expiresAt: at(0.75),
    endedAt: at(0.5),
  });
  const before: LifecyclePresenceInterval = { party: 'expert', joinedAt: at(-10), leftAt: at(-5) };

  function clip(
    intervals: readonly LifecyclePresenceInterval[],
    rings: readonly CallRingFacts[] = [declined2pm]
  ): LifecyclePresenceInterval[] {
    return clipUnansweredRingIntervals(intervals, rings, WINDOW_OPENS);
  }

  function lifecycleAt(
    intervals: readonly LifecyclePresenceInterval[],
    rings: CallRingFacts[]
  ): ReturnType<typeof resolveTerminalRule> {
    return resolveTerminalRule({
      status: 'waiting_for_participants',
      scheduledStart: BOOKED_START,
      scheduledEnd: at(150),
      presence: summarisePresence(clipUnansweredRingIntervals(intervals, rings, WINDOW_OPENS)),
      timers: DEFAULT_MEETING_TIMERS,
      now: at(135),
      venueReadyAt: at(-60),
      admittedLinkGuestPresent: false,
      callNow: callNowFactsFromRings(rings),
    });
  }

  it('pins the token grace both the ring token and the clip use', () => {
    expect(RING_TOKEN_GRACE_MS).toBe(60_000);
  });

  it('ring at 2:00 declined, caller leaves 2:05 — dropped, and the 4 pm no-show still fires', () => {
    const caller: LifecyclePresenceInterval = { party: 'client', joinedAt: at(0), leftAt: at(5) };
    const expertAt4: LifecyclePresenceInterval = {
      party: 'expert',
      joinedAt: BOOKED_START,
      leftAt: null,
    };
    expect(clip([caller, expertAt4])).toEqual([expertAt4]);
    expect(lifecycleAt([caller, expertAt4], [declined2pm])).toMatchObject({
      outcome: 'no_show_client',
    });
  });

  it('ring at 3:58 inside the window, nobody ejected, consultation runs to 4:30 — kept from its in-window join, no no-show', () => {
    const declined358 = ring({
      placement: 'in_place',
      status: 'declined',
      createdAt: at(118),
      expiresAt: at(118.75),
      endedAt: at(118.5),
    });
    const caller: LifecyclePresenceInterval = {
      party: 'client',
      joinedAt: at(118),
      leftAt: at(150),
    };
    const callee: LifecyclePresenceInterval = {
      party: 'expert',
      joinedAt: at(118.25),
      leftAt: at(150),
    };
    const kept = clip([caller, callee], [declined358]);
    expect(kept).toEqual([caller, callee]);
    expect(kept.every((interval) => interval.joinedAt.getTime() >= WINDOW_OPENS.getTime())).toBe(
      true
    );
    expect(lifecycleAt([caller, callee], [declined358])).toBeNull();
  });

  it('a party who rejoins at 2:00:40, inside the token grace, and stays to 4:20 counts from 3:57, not 2:00', () => {
    const rejoin: LifecyclePresenceInterval = {
      party: 'client',
      joinedAt: new Date(at(0).getTime() + 40 * SECOND),
      leftAt: at(140),
    };
    expect(clip([rejoin])).toEqual([{ ...rejoin, joinedAt: WINDOW_OPENS }]);
  });

  it('clips an OPEN interval too, keeping it open', () => {
    const open: LifecyclePresenceInterval = { party: 'client', joinedAt: at(0.2), leftAt: null };
    expect(clip([open])).toEqual([{ party: 'client', joinedAt: WINDOW_OPENS, leftAt: null }]);
  });

  it('drops a ring-time interval that left exactly at the window open, keeps one that left a moment after', () => {
    const atOpen: LifecyclePresenceInterval = {
      party: 'client',
      joinedAt: at(0),
      leftAt: WINDOW_OPENS,
    };
    const justAfter: LifecyclePresenceInterval = {
      party: 'expert',
      joinedAt: at(0),
      leftAt: new Date(WINDOW_OPENS.getTime() + 1),
    };
    expect(clip([atOpen, justAfter])).toEqual([{ ...justAfter, joinedAt: WINDOW_OPENS }]);
  });

  it('a ring declined before its expiry is clipped until expiresAt + grace, the life of the ring token', () => {
    // Declined at 2:00:30, expiry 2:00:45: the token works until 2:01:45, so a rejoin at 2:01:40 —
    // past endedAt + grace (2:01:30) — is still ring-time presence, and leaves before 3:57.
    const lateRejoin: LifecyclePresenceInterval = {
      party: 'client',
      joinedAt: new Date(at(0.75).getTime() + RING_TOKEN_GRACE_MS - 5_000),
      leftAt: at(5),
    };
    expect(clip([lateRejoin])).toEqual([]);
  });

  it('the attempt window ends RING_TOKEN_GRACE_MS after the later of end and expiry: inclusive at the edge, untouched one ms later', () => {
    const graceEnd = at(0.75).getTime() + RING_TOKEN_GRACE_MS;
    const atEdge: LifecyclePresenceInterval = {
      party: 'client',
      joinedAt: new Date(graceEnd),
      leftAt: at(5),
    };
    const pastEdge: LifecyclePresenceInterval = {
      party: 'client',
      joinedAt: new Date(graceEnd + 1),
      leftAt: at(5),
    };
    expect(clip([atEdge, pastEdge])).toEqual([pastEdge]);
  });

  it('leaves untouched an interval that joined before the ring started', () => {
    const spanning: LifecyclePresenceInterval = {
      party: 'expert',
      joinedAt: at(-1),
      leftAt: at(3),
    };
    expect(clip([before, spanning])).toEqual([before, spanning]);
  });

  it.each(['unanswered', 'declined', 'stopped'] as const)(
    'clips for an in-place ring that ended %s',
    (status) => {
      const inside: LifecyclePresenceInterval = { party: 'client', joinedAt: at(0), leftAt: at(2) };
      expect(clip([inside], [{ ...declined2pm, status }])).toEqual([]);
    }
  );

  it.each([
    ['a connected in-place ring', { status: 'connected' as const }],
    ['a ring still ringing', { status: 'ringing' as const, endedAt: null }],
    ['a new-meeting ring', { placement: 'new_meeting' as const }],
    ['a ring with no end recorded', { endedAt: null }],
  ])('keeps every interval as recorded for %s', (_label, overrides) => {
    const inside: LifecyclePresenceInterval = { party: 'client', joinedAt: at(0), leftAt: at(2) };
    expect(clip([inside], [{ ...declined2pm, ...overrides }])).toEqual([inside]);
  });

  it('returns an equal copy, not the input, when no ring applies', () => {
    const input = [before];
    const result = clipUnansweredRingIntervals(input, [], WINDOW_OPENS);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('preserves extra fields on the intervals it keeps or clips', () => {
    const untouched = { ...before, id: 'row-1' };
    const clipped = { party: 'client' as const, joinedAt: at(0), leftAt: at(140), id: 'row-2' };
    const [first, second] = clip([untouched, clipped]);
    expect(first).toBe(untouched);
    expect(second).toEqual({ ...clipped, joinedAt: WINDOW_OPENS });
  });
});

describe('isWithinCallHours', () => {
  // 2026-08-14 is in AEST (UTC+10): 22:00Z → 08:00 local; 21:59Z → 07:59 local.
  it('opens at 08:00 local and closes at 20:00 local, in the expert zone', () => {
    expect(isWithinCallHours(new Date('2026-08-13T21:59:00.000Z'), 'Australia/Sydney')).toBe(false);
    expect(isWithinCallHours(new Date('2026-08-13T22:00:00.000Z'), 'Australia/Sydney')).toBe(true);
    expect(isWithinCallHours(new Date('2026-08-14T09:59:00.000Z'), 'Australia/Sydney')).toBe(true);
    expect(isWithinCallHours(new Date('2026-08-14T10:00:00.000Z'), 'Australia/Sydney')).toBe(false);
  });

  it('reads the zone, not the server clock', () => {
    const instant = new Date('2026-08-14T10:00:00.000Z');
    expect(isWithinCallHours(instant, 'UTC')).toBe(true);
    expect(isWithinCallHours(instant, 'Australia/Sydney')).toBe(false);
  });

  it('treats midnight as hour 0, not 24', () => {
    expect(isWithinCallHours(new Date('2026-08-14T00:00:00.000Z'), 'UTC')).toBe(false);
  });

  it('fails closed on an invalid zone and on an invalid instant', () => {
    expect(isWithinCallHours(START, 'Not/AZone')).toBe(false);
    expect(isWithinCallHours(new Date(Number.NaN), 'UTC')).toBe(false);
  });
});

describe('isSameLocalDay', () => {
  it('compares calendar days in the given zone', () => {
    const lateUtc = new Date('2026-08-14T23:00:00.000Z');
    const earlyUtc = new Date('2026-08-14T01:00:00.000Z');
    expect(isSameLocalDay(lateUtc, earlyUtc, 'UTC')).toBe(true);
    // In Sydney (UTC+10) the first is 09:00 on the 15th and the second 11:00 on the 14th.
    expect(isSameLocalDay(lateUtc, earlyUtc, 'Australia/Sydney')).toBe(false);
  });

  it('is false for an invalid zone or instant', () => {
    expect(isSameLocalDay(START, START, 'Not/AZone')).toBe(false);
    expect(isSameLocalDay(START, new Date(Number.NaN), 'UTC')).toBe(false);
  });
});

describe('selectInPlaceCandidate', () => {
  const NOW = new Date('2026-08-14T01:00:00.000Z');
  const meeting = (id: string, scheduledStart: Date, status = 'scheduled') => ({
    id,
    status,
    scheduledStart,
  });

  it('picks the earliest scheduled meeting later today', () => {
    const later = meeting('later', new Date('2026-08-14T08:00:00.000Z'));
    const sooner = meeting('sooner', new Date('2026-08-14T03:00:00.000Z'));
    expect(selectInPlaceCandidate([later, sooner], NOW, 'UTC')).toEqual({
      meetingId: 'sooner',
      scheduledStart: sooner.scheduledStart,
    });
  });

  it('ignores a meeting that already started, is on another day, or is not scheduled', () => {
    expect(
      selectInPlaceCandidate(
        [
          meeting('started', new Date('2026-08-14T00:30:00.000Z')),
          meeting('tomorrow', new Date('2026-08-15T03:00:00.000Z')),
          meeting('waiting', new Date('2026-08-14T03:00:00.000Z'), 'waiting_for_participants'),
          meeting('cancelled', new Date('2026-08-14T04:00:00.000Z'), 'cancelled'),
        ],
        NOW,
        'UTC'
      )
    ).toBeNull();
  });

  it('measures "today" in the supplied zone', () => {
    const lateTonightUtc = meeting('m', new Date('2026-08-14T23:30:00.000Z'));
    expect(selectInPlaceCandidate([lateTonightUtc], NOW, 'UTC')?.meetingId).toBe('m');
    // 23:30Z is 09:30 on the 15th in Sydney, while NOW is 11:00 on the 14th there.
    expect(selectInPlaceCandidate([lateTonightUtc], NOW, 'Australia/Sydney')).toBeNull();
  });

  it('returns null for no meetings', () => {
    expect(selectInPlaceCandidate([], NOW, 'UTC')).toBeNull();
  });
});

describe('resolveCallNowAvailability', () => {
  const OPEN: CallNowGateFacts = {
    callerSide: 'client',
    caseOpen: true,
    expertAvailableForWork: true,
    calleeResolved: true,
    calleeRecentlyDeclinedCaller: false,
    calleeInLiveMeeting: false,
    ringLiveOnCase: false,
    companyHasOtherLiveSession: false,
    calleeOnline: false,
    expertWithinCallHours: true,
  };

  it('offers Call now when every gate passes', () => {
    expect(resolveCallNowAvailability(OPEN)).toEqual({ canCallNow: true });
  });

  /** Each row breaks exactly ONE gate. */
  const SINGLE_GATES: ReadonlyArray<{
    readonly refusal: string;
    readonly reason: string | null;
    readonly facts: Partial<CallNowGateFacts>;
  }> = [
    { refusal: 'case_closed', reason: null, facts: { caseOpen: false } },
    { refusal: 'expert_paused', reason: null, facts: { expertAvailableForWork: false } },
    { refusal: 'callee_unavailable', reason: null, facts: { calleeResolved: false } },
    {
      refusal: 'recently_declined',
      reason: null,
      facts: { calleeRecentlyDeclinedCaller: true },
    },
    { refusal: 'ring_in_progress', reason: null, facts: { ringLiveOnCase: true } },
    { refusal: 'company_in_call', reason: null, facts: { companyHasOtherLiveSession: true } },
    { refusal: 'callee_busy', reason: 'busy', facts: { calleeInLiveMeeting: true } },
    { refusal: 'outside_hours', reason: 'outside_hours', facts: { expertWithinCallHours: false } },
  ];

  it.each(SINGLE_GATES)(
    '$refusal refuses with display reason $reason',
    ({ refusal, reason, facts }) => {
      expect(resolveCallNowAvailability({ ...OPEN, ...facts })).toEqual({
        canCallNow: false,
        refusal,
        reason,
      });
    }
  );

  it('first failing gate wins — each gate outranks every later one', () => {
    const broken: CallNowGateFacts = {
      ...OPEN,
      caseOpen: false,
      expertAvailableForWork: false,
      calleeResolved: false,
      calleeRecentlyDeclinedCaller: true,
      ringLiveOnCase: true,
      companyHasOtherLiveSession: true,
      calleeInLiveMeeting: true,
      expertWithinCallHours: false,
    };
    const order = SINGLE_GATES.map((gate) => gate.refusal);
    let facts = broken;
    for (const gate of SINGLE_GATES) {
      expect(resolveCallNowAvailability(facts)).toMatchObject({ refusal: gate.refusal });
      const repaired: Partial<CallNowGateFacts> = {
        caseOpen: true,
        expertAvailableForWork: true,
        calleeResolved: true,
        calleeRecentlyDeclinedCaller: false,
        ringLiveOnCase: false,
        companyHasOtherLiveSession: false,
        calleeInLiveMeeting: false,
        expertWithinCallHours: true,
      };
      const key = Object.keys(gate.facts)[0] as keyof CallNowGateFacts;
      facts = { ...facts, [key]: repaired[key] };
    }
    expect(order).toHaveLength(8);
    expect(resolveCallNowAvailability(facts)).toEqual({ canCallNow: true });
  });

  it('expert_paused applies to client callers only', () => {
    expect(
      resolveCallNowAvailability({ ...OPEN, callerSide: 'expert', expertAvailableForWork: false })
    ).toEqual({ canCallNow: true });
  });

  it('outside_hours applies to client callers only', () => {
    expect(
      resolveCallNowAvailability({ ...OPEN, callerSide: 'expert', expertWithinCallHours: false })
    ).toEqual({ canCallNow: true });
  });

  it('an online callee is rung outside call hours', () => {
    expect(
      resolveCallNowAvailability({ ...OPEN, calleeOnline: true, expertWithinCallHours: false })
    ).toEqual({ canCallNow: true });
  });
});

describe('ringAnalyticsOutcome', () => {
  it.each<[Exclude<CallRingStatus, 'ringing'>, string]>([
    ['connected', 'connected'],
    ['unanswered', 'no_answer'],
    ['declined', 'declined'],
    ['stopped', 'stopped'],
  ])('%s → %s', (status, expected) => {
    expect(ringAnalyticsOutcome(status)).toBe(expected);
  });
});
