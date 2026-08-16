import { describe, expect, it } from 'vitest';
import {
  IllegalMeetingTransitionError,
  MEETING_TERMINAL_PREDICATES,
  MEETING_TRANSITIONS,
  assertMeetingTransition,
  expertClockStart,
  isLegalMeetingTransition,
  resolveTerminalRule,
  resolveWaitingPhase,
  summarisePresence,
  type LifecyclePresenceInterval,
  type MeetingLifecycleStatus,
  type MeetingTerminalRuleName,
  type MeetingWaitingPhase,
  type PresenceFacts,
  type TerminalRuleInput,
} from './lifecycle';
import { DEFAULT_MEETING_TIMERS } from './timers';

const MINUTE = 60_000;

/** 10:00 UTC. Every instant below is stated as an offset in whole minutes from this. */
const START = new Date('2026-08-14T10:00:00.000Z');

/** `START + n` minutes. Deliberately the ONLY way an instant is constructed in this file. */
function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

// ── THE TRANSITION MAP (§4.1) ─────────────────────────────────────────────────────────────

describe('MEETING_TRANSITIONS (BAL-134 §4.1)', () => {
  const ALL: readonly MeetingLifecycleStatus[] = [
    'scheduled',
    'waiting_for_participants',
    'in_progress',
    'ended',
    'cancelled',
  ];

  it('names exactly the five meeting_status labels', () => {
    expect(Object.keys(MEETING_TRANSITIONS).sort((a, b) => a.localeCompare(b))).toEqual(
      [...ALL].sort((a, b) => a.localeCompare(b))
    );
  });

  it('every declared edge points at a known label', () => {
    for (const targets of Object.values(MEETING_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL).toContain(target);
      }
    }
  });

  it('⚠ both TERMINAL labels are sinks — nothing leaves `ended` or `cancelled`', () => {
    expect(MEETING_TRANSITIONS.ended).toEqual([]);
    expect(MEETING_TRANSITIONS.cancelled).toEqual([]);
  });

  it('⚠ no label lists itself — a second termination is a CAS no-op, never a legal self-edge', () => {
    for (const status of ALL) {
      expect(MEETING_TRANSITIONS[status]).not.toContain(status);
    }
  });

  /** The edges the sweep, the presence writer and the end route actually take. */
  const LEGAL: ReadonlyArray<[MeetingLifecycleStatus, MeetingLifecycleStatus]> = [
    ['scheduled', 'waiting_for_participants'],
    // ⚠ A SAME-INSTANT DOUBLE-JOIN. Requiring the intermediate state would strand such a
    // meeting at `scheduled`, where the MISSED-CALL rule would end a call that is running.
    ['scheduled', 'in_progress'],
    ['scheduled', 'ended'],
    ['scheduled', 'cancelled'],
    ['waiting_for_participants', 'in_progress'],
    ['waiting_for_participants', 'ended'],
    // ⚠ DECLARED LEGAL, DELIBERATELY NOT IMPLEMENTED — D12. BAL-409/BAL-411 own the writer.
    ['waiting_for_participants', 'scheduled'],
    ['in_progress', 'ended'],
  ];

  it.each(LEGAL)('%s → %s is legal', (from, to) => {
    expect(isLegalMeetingTransition(from, to)).toBe(true);
    expect(() => assertMeetingTransition(from, to)).not.toThrow();
  });

  const ILLEGAL: ReadonlyArray<[MeetingLifecycleStatus, MeetingLifecycleStatus]> = [
    ['ended', 'in_progress'],
    ['ended', 'ended'],
    ['cancelled', 'scheduled'],
    ['in_progress', 'waiting_for_participants'],
    ['in_progress', 'cancelled'],
    // ⚠ `cancel()` is gated on `scheduled` ALONE — see `meetingsRepository.cancel`.
    ['waiting_for_participants', 'cancelled'],
  ];

  it.each(ILLEGAL)('%s → %s is refused', (from, to) => {
    expect(isLegalMeetingTransition(from, to)).toBe(false);
    expect(() => assertMeetingTransition(from, to)).toThrow(IllegalMeetingTransitionError);
  });

  it('the thrown error carries both ends of the refused edge', () => {
    try {
      assertMeetingTransition('ended', 'in_progress');
      expect.unreachable('assertMeetingTransition should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalMeetingTransitionError);
      const typed = error as IllegalMeetingTransitionError;
      expect(typed.from).toBe('ended');
      expect(typed.to).toBe('in_progress');
      expect(typed.name).toBe('IllegalMeetingTransitionError');
    }
  });
});

// ── PRESENCE FACTS ────────────────────────────────────────────────────────────────────────

describe('summarisePresence', () => {
  it('reports an empty meeting as nothing having happened', () => {
    expect(summarisePresence([])).toEqual({
      expertEverPresent: false,
      expertOpen: false,
      clientSideEverPresent: false,
      anyOpen: false,
      lastLeftAt: null,
      expertFirstJoinedAt: null,
    });
  });

  it('anchors on the FIRST expert join regardless of array order', () => {
    const intervals: LifecyclePresenceInterval[] = [
      { party: 'expert', joinedAt: at(10), leftAt: at(20) },
      { party: 'expert', joinedAt: at(2), leftAt: at(6) },
    ];
    expect(summarisePresence(intervals).expertFirstJoinedAt).toEqual(at(2));
    expect(summarisePresence([...intervals].reverse()).expertFirstJoinedAt).toEqual(at(2));
  });

  it('reports the LATEST left_at, and reports the room empty only when nothing is open', () => {
    const closed = summarisePresence([
      { party: 'expert', joinedAt: at(0), leftAt: at(30) },
      { party: 'client', joinedAt: at(5), leftAt: at(12) },
    ]);
    expect(closed.anyOpen).toBe(false);
    expect(closed.lastLeftAt).toEqual(at(30));

    const open = summarisePresence([
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'client', joinedAt: at(5), leftAt: at(12) },
    ]);
    expect(open.anyOpen).toBe(true);
    expect(open.expertOpen).toBe(true);
  });

  /**
   * ⚠ THE MONEY RULE, RESTATED AS A TEST. `observer` covers a Balo staffer, a link-share
   * attendee and an expert-side colleague. Counting one as client-side would convert a
   * `no_show_client` — nothing owed — into a settled consultation.
   */
  it('⚠ an `observer` is NEVER client-side presence', () => {
    const facts = summarisePresence([
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'observer', joinedAt: at(1), leftAt: null },
    ]);
    expect(facts.clientSideEverPresent).toBe(false);
    expect(facts.anyOpen).toBe(true);
  });

  it('skips an interval with a non-finite endpoint rather than letting NaN order the timeline', () => {
    const facts = summarisePresence([
      { party: 'expert', joinedAt: new Date('nonsense'), leftAt: at(99) },
      { party: 'expert', joinedAt: at(0), leftAt: at(30) },
      { party: 'client', joinedAt: at(5), leftAt: new Date('nonsense') },
    ]);
    expect(facts.expertFirstJoinedAt).toEqual(at(0));
    expect(facts.lastLeftAt).toEqual(at(30));
    expect(facts.clientSideEverPresent).toBe(false);
  });
});

describe('expertClockStart', () => {
  it('is null when no expert ever joined — there is no clock to start', () => {
    expect(expertClockStart(START, null)).toBeNull();
  });

  it('⚠ an expert arriving EARLY earns nothing — the clock starts at the scheduled start', () => {
    expect(expertClockStart(START, at(-5))).toEqual(START);
  });

  it('⚠ an expert arriving LATE starts their own clock — no-show settles at join + floor', () => {
    expect(expertClockStart(START, at(5))).toEqual(at(5));
  });

  it('an exactly-on-time join is the scheduled start', () => {
    expect(expertClockStart(START, START)).toEqual(START);
  });
});

// ── ⚠⚠ THE PRECEDENCE TABLE (§4.2) ────────────────────────────────────────────────────────

/** The scenario shape every row below states. `null` expectation ⇒ NO rule may fire. */
interface TerminalRow {
  readonly label: string;
  readonly status: MeetingLifecycleStatus;
  readonly intervals: readonly LifecyclePresenceInterval[];
  readonly nowMinutes: number;
  /** Defaults to `START` — overridden only by the D12 reschedule rows. */
  readonly scheduledStart?: Date;
  readonly expected: MeetingTerminalRuleName | null;
  readonly outcome?: 'completed' | 'no_show_client' | 'missed_call' | null;
}

function inputFor(row: TerminalRow): TerminalRuleInput {
  return {
    status: row.status,
    scheduledStart: row.scheduledStart ?? START,
    presence: summarisePresence(row.intervals),
    timers: DEFAULT_MEETING_TIMERS,
    now: at(row.nowMinutes),
  };
}

/**
 * ONE ROW PER RULE, PLUS ONE ROW PER NEAR-MISS. Every row asserts that EXACTLY ONE rule fires,
 * or none — never "at least one".
 */
const TERMINAL_ROWS: readonly TerminalRow[] = [
  // ── RULE 1 — IDLE END. The only rule that requires `in_progress`. ──────────────────────
  {
    label: 'RULE 1 idle end — in_progress, room empty 5 min',
    status: 'in_progress',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ],
    nowMinutes: 35,
    expected: 'idle_end',
    outcome: 'completed',
  },
  {
    label: 'near-miss 1a — one second short of the empty window',
    status: 'in_progress',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ],
    nowMinutes: 34.9,
    expected: null,
  },
  {
    label: 'near-miss 1b — somebody is STILL in the room',
    status: 'in_progress',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ],
    nowMinutes: 60,
    expected: null,
  },
  {
    /**
     * ⚠⚠ RE-DECIDED. This row used to assert `null` — "idle end is scoped to
     * reached-in_progress, so the same empty room at `waiting_for_participants` fires NOTHING".
     * The first half is still true (rule 1 does NOT fire); the conclusion was a STRANDING BUG.
     * A meeting whose expert and client both came and went is over, and leaving it non-terminal
     * forever meant it was never settled and its hold was never released. It now falls to the
     * ABANDONED WAIT with a NULL outcome — BAL-412 reads the presence rows and prices it.
     */
    label:
      '⚠ RE-DECIDED 1c — the SAME empty room at `waiting_for_participants` is NOT an idle end; it is an ABANDONED WAIT with a null outcome',
    status: 'waiting_for_participants',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: at(30) },
      { party: 'client', joinedAt: at(2), leftAt: at(30) },
    ],
    nowMinutes: 35,
    expected: 'abandoned_wait',
    outcome: null,
  },

  // ── RULE 2 — NO-SHOW. The expert is STILL holding the room. ────────────────────────────
  {
    label: 'RULE 2 no-show — expert present since the start, no client ever, floor reached',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: null }],
    nowMinutes: 15,
    expected: 'no_show',
    outcome: 'no_show_client',
  },
  {
    label: 'near-miss 2a — one second short of the floor',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: null }],
    nowMinutes: 14.9,
    expected: null,
  },
  {
    label: '⚠ near-miss 2b — expert joined at 10:05, so the floor is 10:20 and 10:15 is too early',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(5), leftAt: null }],
    nowMinutes: 15,
    expected: null,
  },
  {
    label: 'RULE 2 again — that same late expert settles at 10:20, not 10:15',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(5), leftAt: null }],
    nowMinutes: 20,
    expected: 'no_show',
    outcome: 'no_show_client',
  },
  {
    label: 'near-miss 2c — a client DID arrive, so it is not a no-show',
    status: 'waiting_for_participants',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'client', joinedAt: at(3), leftAt: at(4) },
    ],
    nowMinutes: 30,
    expected: null,
  },
  {
    label: '⚠ near-miss 2d — an `observer` is not a client, so the no-show still fires',
    status: 'waiting_for_participants',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'observer', joinedAt: at(3), leftAt: null },
    ],
    nowMinutes: 15,
    expected: 'no_show',
    outcome: 'no_show_client',
  },

  // ── RULE 3 — MISSED CALL. Nobody delivering ever turned up. ────────────────────────────
  {
    label: 'RULE 3 missed call — nothing at all, 10 minutes past the start',
    status: 'scheduled',
    intervals: [],
    nowMinutes: 10,
    expected: 'missed_call',
    outcome: 'missed_call',
  },
  {
    label: 'RULE 3 — the client showed up alone; still a missed call',
    status: 'waiting_for_participants',
    intervals: [{ party: 'client', joinedAt: at(1), leftAt: null }],
    nowMinutes: 10,
    expected: 'missed_call',
    outcome: 'missed_call',
  },
  {
    /**
     * ⚠ THE GUARD THAT KEEPS RULE 4 FROM SWALLOWING RULE 3. The client came and went at 10:01,
     * so the room is EMPTY well before the missed-call threshold. Rule 4 must NOT fire at 10:06
     * — the expert never joined, and re-labelling a `missed_call` as an outcome-less abandoned
     * wait would lose the failure mode the product counts. `expertEverPresent` is what stops it.
     */
    label:
      '⚠ RULE 3 still owns an EMPTY room the expert never reached — rule 4 must not pre-empt it',
    status: 'waiting_for_participants',
    intervals: [{ party: 'client', joinedAt: at(0), leftAt: at(1) }],
    nowMinutes: 10,
    expected: 'missed_call',
    outcome: 'missed_call',
  },
  {
    label: 'near-miss 3a — one second short of the termination threshold',
    status: 'scheduled',
    intervals: [],
    nowMinutes: 9.9,
    expected: null,
  },
  {
    label:
      '⚠ near-miss 3b — the expert joined at 10:09 and left; the salvage window WORKED and rule 3 is disarmed forever',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(9), leftAt: at(9.5) }],
    nowMinutes: 10,
    expected: null,
  },

  // ── RULE 4 — ABANDONED WAIT (D9), the EMPTY-ROOM catch-all below `in_progress`. ────────
  {
    label: 'RULE 4 abandoned wait — expert waited 8 min, left, room empty 5 min, no client ever',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(8) }],
    nowMinutes: 13,
    expected: 'abandoned_wait',
    outcome: null,
  },
  {
    label: 'near-miss 4a — one second short of the empty window',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(8) }],
    nowMinutes: 12.9,
    expected: null,
  },
  {
    /**
     * ⚠⚠ RE-DECIDED, AND THIS ROW IS THE WHOLE POINT OF THE C2 FIX. It used to assert `null`
     * with the comment "they held the floor, so the outcome is a money question, not a system
     * guess". The money half was right and is preserved (`outcome: null` — BAL-412 decides).
     * The TERMINATION half was wrong: nothing else could ever fire, no human remained to press
     * End, and after 24h the sweep's lookback floor hid the meeting from any future repair. The
     * reconciler made it ordinary rather than exotic, because it closes a dropped-`left` at the
     * SWEEP'S `now` — so a clean 10:08 abandonment recorded at 10:16 crossed the floor and
     * stranded.
     */
    label:
      '⚠⚠ RE-DECIDED 4b — the expert HELD THE FLOOR and then left: the room still terminates, with the outcome left to BAL-412',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(16) }],
    nowMinutes: 30,
    expected: 'abandoned_wait',
    outcome: null,
  },
  {
    /**
     * ⚠⚠ RE-DECIDED. A client who joined and left BEFORE the expert arrived never overlapped
     * them, so `markInProgress` never fired and the meeting is still `waiting_for_participants`.
     * The old `!clientSideEverPresent` guard refused this row and rule 2 refused it too (the
     * expert is not open) — a second permanent stranding, on a different route in.
     */
    label:
      '⚠⚠ RE-DECIDED 4c — a client who came and went BEFORE the expert still leaves an abandoned wait, not a stranded meeting',
    status: 'waiting_for_participants',
    intervals: [
      { party: 'client', joinedAt: at(0), leftAt: at(2) },
      { party: 'expert', joinedAt: at(3), leftAt: at(8) },
    ],
    nowMinutes: 13,
    expected: 'abandoned_wait',
    outcome: null,
  },
  {
    /**
     * ⚠ THE DRIFT CASE. `markWaitingForParticipants` is a compare-and-set that can lose its
     * race or never run (a dropped webhook the reconciler repaired without a status pass), so a
     * meeting can hold presence rows while still reading `scheduled`. Rule 4 accepts BOTH
     * pre-`in_progress` labels for exactly that reason; rule 3 cannot cover it, because the
     * expert DID join.
     */
    label: '⚠ RULE 4 also covers a `scheduled` meeting whose status never caught up',
    status: 'scheduled',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(8) }],
    nowMinutes: 13,
    expected: 'abandoned_wait',
    outcome: null,
  },

  // ── D12 — the stale status a reschedule leaves behind must be INERT ────────────────────
  {
    label:
      '⚠ D12 — a `waiting_for_participants` meeting rescheduled INTO THE FUTURE with a still-open expert interval matches NOTHING',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: null }],
    // The interval has been open all day, so the clock LOOKS long. The wall-clock gate is what
    // stops the no-show firing on a call that has not happened yet.
    scheduledStart: new Date(START.getTime() + 24 * 60 * MINUTE),
    nowMinutes: 20,
    expected: null,
  },
  {
    /**
     * ⚠ THE SAME D12 HAZARD ON THE OTHER SIDE OF RULE 4'S WIDENING. The pre-reschedule attempt
     * left a CLOSED expert interval whose `left_at` is in the past, so anchoring the empty
     * window on `lastLeftAt` alone would terminate a call that has not happened yet.
     * `emptyWindowStartMs` takes the LATER of `lastLeftAt` and `scheduledStart`, which is what
     * keeps this inert.
     */
    label:
      '⚠ D12 — a meeting rescheduled into the future with a CLOSED expert interval is inert too',
    status: 'waiting_for_participants',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(8) }],
    scheduledStart: new Date(START.getTime() + 24 * 60 * MINUTE),
    nowMinutes: 20,
    expected: null,
  },

  // ── THE HUMAN END IS NOT A SWEEP RULE ─────────────────────────────────────────────────
  {
    label:
      '⚠ a healthy live meeting matches NOTHING — the human End (path 5) is a fact about a REQUEST, not about a meeting',
    status: 'in_progress',
    intervals: [
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ],
    nowMinutes: 20,
    expected: null,
  },
  {
    label: '⚠ an already-terminal meeting matches NOTHING on the next tick',
    status: 'ended',
    intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(8) }],
    nowMinutes: 60,
    expected: null,
  },
  {
    label: 'a cancelled meeting matches NOTHING',
    status: 'cancelled',
    intervals: [],
    nowMinutes: 60,
    expected: null,
  },
];

describe('resolveTerminalRule — the precedence table (BAL-134 §4.2)', () => {
  it.each(TERMINAL_ROWS)('$label', (row) => {
    const decision = resolveTerminalRule(inputFor(row));
    if (row.expected === null) {
      expect(decision).toBeNull();
      return;
    }
    expect(decision?.rule).toBe(row.expected);
    expect(decision?.outcome).toBe(row.outcome ?? null);
  });

  /**
   * ⚠⚠ THE DISJOINTNESS PROOF. The four rules are mutually exclusive BY PRECONDITION, which is
   * stronger than an evaluation order — so this evaluates all four PREDICATES independently and
   * asserts at most one holds. Written against `MEETING_TERMINAL_PREDICATES` rather than
   * against `resolveTerminalRule`'s if-chain, so it is a real proof and not a restatement.
   */
  it.each(TERMINAL_ROWS)('⚠ AT MOST ONE rule holds for: $label', (row) => {
    const input = inputFor(row);
    const firing = MEETING_TERMINAL_PREDICATES.filter((entry) => entry.applies(input));
    expect(firing.length).toBeLessThanOrEqual(1);
    expect(firing[0]?.rule ?? null).toBe(row.expected);
  });

  it('the predicate list names all four rules, once each', () => {
    expect(MEETING_TERMINAL_PREDICATES.map((entry) => entry.rule)).toEqual([
      'idle_end',
      'no_show',
      'missed_call',
      'abandoned_wait',
    ]);
  });

  /**
   * ⚠ THE THREE SYSTEM PATHS DEFINED BY THEIR OUTCOME CARRY ONE; THE ABANDONED WAIT DOES NOT
   * (D5/D9). `null` is a real, correct value — BAL-412 resolves it from `meeting_presence`.
   */
  it('⚠ only the abandoned wait leaves `outcome` unset', () => {
    const fired = TERMINAL_ROWS.filter((row) => row.expected !== null);
    for (const row of fired) {
      const decision = resolveTerminalRule(inputFor(row));
      expect(decision?.outcome === null).toBe(row.expected === 'abandoned_wait');
    }
  });
});

// ── ⚠⚠ TOTALITY (C2) ─────────────────────────────────────────────────────────────────────

/**
 * ⚠⚠ THE PROPERTY THAT ACTUALLY PROTECTS A MEETING, AND THE ONE THE TAXONOMY DID NOT HAVE.
 *
 * Disjointness stops TWO rules firing. Totality stops ZERO firing — and zero is the failure
 * with teeth: a non-terminal meeting nothing can terminate is never settled, its credit hold is
 * never released, no human remains to press End, and after 24 h the sweep's
 * `listLifecycleCandidates` lookback floor hides it from every future repair. The taxonomy
 * stranded that way on TWO distinct routes before this test existed (rule 4's removed
 * `expertPresentMs < floor` and `!clientSideEverPresent` guards).
 *
 * ⚠ IT IS DELIBERATELY WRITTEN OVER A GENERATED MATRIX rather than as more hand-picked rows.
 * Both holes were states nobody thought to write a row for; enumerating status × presence-shape
 * is what makes "we did not think of it" impossible rather than unlikely.
 */
describe('⚠⚠ resolveTerminalRule is TOTAL over an empty room (C2)', () => {
  const NON_TERMINAL: readonly MeetingLifecycleStatus[] = [
    'scheduled',
    'waiting_for_participants',
    'in_progress',
  ];

  /** Every shape an EMPTY room can be in. `anyOpen` is false in all of them, by construction. */
  const EMPTY_ROOM_SHAPES: ReadonlyArray<{
    label: string;
    intervals: readonly LifecyclePresenceInterval[];
  }> = [
    { label: 'nobody ever joined', intervals: [] },
    {
      label: 'the expert came and went below the floor',
      intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(8) }],
    },
    {
      label: '⚠ the expert came and went ABOVE the floor (the C2 hole)',
      intervals: [{ party: 'expert', joinedAt: at(0), leftAt: at(20) }],
    },
    {
      label: 'only a client came and went',
      intervals: [{ party: 'client', joinedAt: at(0), leftAt: at(3) }],
    },
    {
      label: '⚠ both came and went but never overlapped (the second C2 hole)',
      intervals: [
        { party: 'client', joinedAt: at(0), leftAt: at(3) },
        { party: 'expert', joinedAt: at(5), leftAt: at(12) },
      ],
    },
    {
      label: 'a full consultation that ended',
      intervals: [
        { party: 'expert', joinedAt: at(0), leftAt: at(30) },
        { party: 'client', joinedAt: at(2), leftAt: at(30) },
      ],
    },
    {
      label: 'only an observer came and went',
      intervals: [{ party: 'observer', joinedAt: at(0), leftAt: at(4) }],
    },
  ];

  const MATRIX = NON_TERMINAL.flatMap((status) =>
    EMPTY_ROOM_SHAPES.map((shape) => ({ status, ...shape }))
  );

  /** A day past the scheduled start — past every window in `DEFAULT_MEETING_TIMERS`. */
  const LONG_AFTER = 24 * 60;

  it.each(MATRIX)(
    '⚠⚠ $status + $label past every window MUST terminate — a rule-less non-terminal meeting is unrecoverable',
    ({ status, intervals }) => {
      const input: TerminalRuleInput = {
        status,
        scheduledStart: START,
        presence: summarisePresence(intervals),
        timers: DEFAULT_MEETING_TIMERS,
        now: at(LONG_AFTER),
      };

      expect(summarisePresence(intervals).anyOpen).toBe(false);
      expect(resolveTerminalRule(input)).not.toBeNull();
      // Totality must not have been bought with an overlap.
      expect(MEETING_TERMINAL_PREDICATES.filter((entry) => entry.applies(input))).toHaveLength(1);
    }
  );

  /**
   * ⚠ THE ONE CARVE-OUT, ASSERTED RATHER THAN ASSUMED. A room somebody is STILL IN matches
   * nothing but the no-show, and that is correct: an occupied meeting is not stranded, it is
   * happening. It is also BOUNDED — every open interval is closed by `participant.left`, by
   * `meeting.ended`, or by the per-minute reconciler — so the room becomes empty (and therefore
   * terminable by the matrix above) shortly after everyone really leaves.
   */
  it('⚠ an OCCUPIED room is the only state that may match nothing, and only while occupied', () => {
    const occupied: readonly LifecyclePresenceInterval[] = [
      { party: 'expert', joinedAt: at(0), leftAt: null },
      { party: 'client', joinedAt: at(1), leftAt: null },
    ];
    const base = {
      scheduledStart: START,
      presence: summarisePresence(occupied),
      timers: DEFAULT_MEETING_TIMERS,
      now: at(LONG_AFTER),
    };

    expect(resolveTerminalRule({ ...base, status: 'in_progress' })).toBeNull();

    // …and the moment the room empties, the very same meeting terminates.
    const emptied = summarisePresence(
      occupied.map((interval) => ({ ...interval, leftAt: at(LONG_AFTER - 30) }))
    );
    expect(
      resolveTerminalRule({ ...base, status: 'in_progress', presence: emptied })
    ).not.toBeNull();
  });
});

// ── THE SERVER-COMPUTED WAITING PHASE (§7.1) ──────────────────────────────────────────────

describe('resolveWaitingPhase — the 2×4 matrix', () => {
  function phaseFor(
    status: MeetingLifecycleStatus,
    intervals: readonly LifecyclePresenceInterval[],
    nowMinutes: number
  ): MeetingWaitingPhase {
    return resolveWaitingPhase({
      status,
      scheduledStart: START,
      presence: summarisePresence(intervals),
      timers: DEFAULT_MEETING_TIMERS,
      now: at(nowMinutes),
    });
  }

  /** The EXPERT-MISSING progression — anchored on the wall clock, alert at 5 min. */
  const EXPERT_MISSING: readonly LifecyclePresenceInterval[] = [];
  /** The CLIENT-MISSING progression — anchored on the expert-present clock start. */
  const EXPERT_HOLDING: readonly LifecyclePresenceInterval[] = [
    { party: 'expert', joinedAt: at(0), leftAt: null },
  ];

  const MATRIX: ReadonlyArray<{
    absent: 'expert' | 'client';
    phase: MeetingWaitingPhase;
    status: MeetingLifecycleStatus;
    intervals: readonly LifecyclePresenceInterval[];
    nowMinutes: number;
  }> = [
    // EXPERT MISSING
    {
      absent: 'expert',
      phase: 'pre-start',
      status: 'scheduled',
      intervals: EXPERT_MISSING,
      nowMinutes: -1,
    },
    {
      absent: 'expert',
      phase: 'running',
      status: 'scheduled',
      intervals: EXPERT_MISSING,
      nowMinutes: 4,
    },
    {
      absent: 'expert',
      phase: 'near',
      status: 'scheduled',
      intervals: EXPERT_MISSING,
      nowMinutes: 5,
    },
    {
      absent: 'expert',
      phase: 'settled',
      status: 'ended',
      intervals: EXPERT_MISSING,
      nowMinutes: 12,
    },
    // CLIENT MISSING (the expert is holding the room)
    {
      absent: 'client',
      phase: 'pre-start',
      status: 'waiting_for_participants',
      intervals: EXPERT_HOLDING,
      nowMinutes: -1,
    },
    {
      absent: 'client',
      phase: 'running',
      status: 'waiting_for_participants',
      intervals: EXPERT_HOLDING,
      nowMinutes: 4,
    },
    {
      absent: 'client',
      phase: 'near',
      status: 'waiting_for_participants',
      intervals: EXPERT_HOLDING,
      nowMinutes: 5,
    },
    {
      absent: 'client',
      phase: 'settled',
      status: 'ended',
      intervals: EXPERT_HOLDING,
      nowMinutes: 20,
    },
  ];

  it.each(MATRIX)('$absent missing at +$nowMinutes min → $phase', (row) => {
    expect(phaseFor(row.status, row.intervals, row.nowMinutes)).toBe(row.phase);
  });

  it('`in_progress` is `running` — both parties are here and the waiting stage is not shown', () => {
    expect(
      phaseFor(
        'in_progress',
        [
          { party: 'expert', joinedAt: at(0), leftAt: null },
          { party: 'client', joinedAt: at(1), leftAt: null },
        ],
        45
      )
    ).toBe('running');
  });

  it('`cancelled` is settled', () => {
    expect(phaseFor('cancelled', EXPERT_MISSING, 5)).toBe('settled');
  });

  /**
   * ⚠⚠ `settled` COMES ONLY FROM A TERMINAL STATUS. A meeting one tick past its termination
   * threshold has NOT settled — the sweep has not run — and telling a waiting client "nothing
   * was charged" before that is true would be a money claim made on a guess.
   */
  it('⚠ passing a termination threshold does NOT settle a still-live meeting', () => {
    expect(phaseFor('scheduled', EXPERT_MISSING, 30)).toBe('near');
    expect(phaseFor('waiting_for_participants', EXPERT_HOLDING, 30)).toBe('near');
  });

  /**
   * ⚠ A LATE EXPERT SHIFTS THE CLIENT-MISSING PROGRESSION. Joining at 10:05 means their nudge
   * anchor is 10:05, so 10:09 is still `running` where an on-time expert would be `near`.
   */
  it('⚠ the client-missing progression is anchored on the expert-present clock start', () => {
    const late: readonly LifecyclePresenceInterval[] = [
      { party: 'expert', joinedAt: at(5), leftAt: null },
    ];
    expect(phaseFor('waiting_for_participants', late, 9)).toBe('running');
    expect(phaseFor('waiting_for_participants', late, 10)).toBe('near');
  });

  it('an expert who LEFT falls back to the expert-missing progression', () => {
    const left: readonly LifecyclePresenceInterval[] = [
      { party: 'expert', joinedAt: at(0), leftAt: at(1) },
    ];
    // Anchored on the wall clock again, so the 5-minute expert alert governs.
    expect(phaseFor('waiting_for_participants', left, 4)).toBe('running');
    expect(phaseFor('waiting_for_participants', left, 5)).toBe('near');
  });
});

// ── A TYPE-LEVEL WITNESS, so a new fact cannot be added without a decision ─────────────────

describe('PresenceFacts', () => {
  it('names exactly the six structural facts the rules read', () => {
    const facts: PresenceFacts = summarisePresence([]);
    expect(Object.keys(facts).sort((a, b) => a.localeCompare(b))).toEqual([
      'anyOpen',
      'clientSideEverPresent',
      'expertEverPresent',
      'expertFirstJoinedAt',
      'expertOpen',
      'lastLeftAt',
    ]);
  });
});
