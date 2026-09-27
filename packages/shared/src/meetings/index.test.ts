import { describe, it, expect } from 'vitest';
import {
  clampIntervalsToStart,
  computeMeetingClocks,
  coPresentMsBefore,
  currentCoPresenceStartedAt,
  expertPresentFromStartMs,
  presencePartyForGuest,
  type MeetingClocks,
  type PresenceInterval,
} from './index';

const MIN = 60_000;
const T0 = new Date('2026-08-05T10:00:00.000Z');
/** An Invalid Date — `getTime()` is NaN. */
const INVALID = new Date('nope');

/** `T0 + n` minutes. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MIN);
}

function interval(
  party: PresenceInterval['party'],
  fromMinutes: number,
  toMinutes: number | null
): PresenceInterval {
  return {
    party,
    joinedAt: at(fromMinutes),
    leftAt: toMinutes === null ? null : at(toMinutes),
  };
}

/** Every ordering of `items`. `n!` rows — keep the inputs to 3 intervals. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  const out: T[][] = [];
  for (const [index, head] of items.entries()) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      out.push([head, ...tail]);
    }
  }
  return out;
}

/**
 * THE ASSERTION SHAPE THE `toSpans` NON-FINITE GUARD ACTUALLY NEEDS. Runs `intervals` in
 * EVERY order and requires (a) ONE result across all of them and (b) that it equals the
 * `interpretable`-only truth. A single fixed order does not discriminate: the guard's
 * failure mode is order-DEPENDENCE, so some orders come out right even unguarded.
 */
function expectOrderInvariantTruth(
  intervals: readonly PresenceInterval[],
  interpretable: readonly PresenceInterval[],
  now: Date,
  expectedOrderings: number
): MeetingClocks {
  const truth = computeMeetingClocks([...interpretable], now);
  const orderings = permutations(intervals);
  expect(orderings).toHaveLength(expectedOrderings);
  for (const ordering of orderings) {
    expect(computeMeetingClocks(ordering, now)).toEqual(truth);
  }
  return truth;
}

describe('computeMeetingClocks', () => {
  it('no intervals at all → both clocks zero, both anchors null', () => {
    const clocks = computeMeetingClocks([], at(60));

    expect(clocks).toEqual({
      expertPresentMs: 0,
      billableMs: 0,
      expertFirstJoinedAt: null,
      billableStartedAt: null,
    });
  });

  it('the straightforward case — expert 0→30, client 5→25 ⇒ billable is the 20-min overlap', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 30), interval('client', 5, 25)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(30 * MIN);
    expect(clocks.billableMs).toBe(20 * MIN);
    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
    expect(clocks.billableStartedAt).toEqual(at(5));
  });

  it('THE REJOIN CASE — a client drop+rejoin yields ONE continuous span, not two fragments', () => {
    // expert 0→40; client 5→15, drops, rejoins 25→35.
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 40), interval('client', 5, 15), interval('client', 25, 35)],
      at(60)
    );

    // A SUM would be 10 + 10 = 20 min (under-billing the call by the 10-min gap).
    // The SPAN is 5 → 35 = 30 min, gap INCLUSIVE. The timer never restarted.
    expect(clocks.billableMs).toBe(30 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(5));
    expect(clocks.expertPresentMs).toBe(40 * MIN);
  });

  it('an EXPERT drop+rejoin does not move the first-join anchor or restart the clock', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 10), interval('expert', 20, 30), interval('client', 2, 28)],
      at(60)
    );

    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
    expect(clocks.expertPresentMs).toBe(30 * MIN); // 0 → 30, gap inclusive
    expect(clocks.billableMs).toBe(26 * MIN); // 2 → 28, gap inclusive
    expect(clocks.billableStartedAt).toEqual(at(2));
  });

  it('expert only, no client ever ⇒ billableMs 0 with a running expert clock (the no-show input)', () => {
    const clocks = computeMeetingClocks([interval('expert', 0, 15)], at(60));

    expect(clocks.expertPresentMs).toBe(15 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
  });

  it('client only, expert never joined ⇒ both clocks zero and both anchors null', () => {
    const clocks = computeMeetingClocks([interval('client', 0, 15)], at(60));

    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.expertFirstJoinedAt).toBeNull();
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('an observer NEVER makes a meeting billable', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 20), interval('observer', 0, 20)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(20 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('an observer alongside a client neither extends nor shortens the billable span', () => {
    const withObserver = computeMeetingClocks(
      [interval('expert', 0, 30), interval('client', 10, 20), interval('observer', 0, 30)],
      at(60)
    );
    const withoutObserver = computeMeetingClocks(
      [interval('expert', 0, 30), interval('client', 10, 20)],
      at(60)
    );

    expect(withObserver).toEqual(withoutObserver);
  });

  it('still-open intervals run to `now`', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, null), interval('client', 5, null)],
      at(25)
    );

    expect(clocks.expertPresentMs).toBe(25 * MIN);
    expect(clocks.billableMs).toBe(20 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(5));
  });

  it('a zero-length join blip is a real event — a 0 ms clock, not a dropped interval', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 10, 10), interval('client', 10, 10)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.billableMs).toBe(0);
    // The anchors are still recorded — the parties WERE both in the room, instantaneously.
    expect(clocks.expertFirstJoinedAt).toEqual(at(10));
    expect(clocks.billableStartedAt).toEqual(at(10));
  });

  it('client first, expert second — the billable clock starts when the EXPERT arrives', () => {
    const clocks = computeMeetingClocks(
      [interval('client', 0, 40), interval('expert', 12, 40)],
      at(60)
    );

    expect(clocks.expertFirstJoinedAt).toEqual(at(12));
    expect(clocks.billableStartedAt).toEqual(at(12));
    expect(clocks.billableMs).toBe(28 * MIN);
    expect(clocks.expertPresentMs).toBe(28 * MIN);
  });

  it('non-overlapping presence (client leaves BEFORE the expert joins) ⇒ never billable', () => {
    const clocks = computeMeetingClocks(
      [interval('client', 0, 5), interval('expert', 10, 30)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(20 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('two concurrent clients — the billable span covers the union of their presence', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 60), interval('client', 5, 20), interval('client', 15, 45)],
      at(90)
    );

    expect(clocks.billableStartedAt).toEqual(at(5));
    expect(clocks.billableMs).toBe(40 * MIN); // 5 → 45
  });

  // ── DOCBLOCK PINS ────────────────────────────────────────────────────────────────────
  // These two exist so the WORKED EXAMPLE in the `@balo/shared/meetings` docblock (and its
  // copy on `schema/meeting-presence.ts`) can never drift from the behaviour again: a prose
  // example that was never executed shipped the WRONG number once already. They assert the
  // documented scenario EXACTLY and the documented value EXACTLY. If the arithmetic ever
  // changes, both docblocks change with these assertions — never the other way round.

  it('DOCBLOCK PIN — client 2→4 and 58→60 of a 60-min call ⇒ billableMs is exactly 58 min', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 60), interval('client', 2, 4), interval('client', 58, 60)],
      at(90)
    );

    // A SUM of the client's intervals is 2 + 2 = 4 min. The SPAN is 2 → 60 = 58 min.
    expect(clocks.billableMs).toBe(58 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(2));
    expect(clocks.expertPresentMs).toBe(60 * MIN);
  });

  it('DOCBLOCK PIN (THE TRAP) — the same client present from minute 0 ⇒ the FULL 60, not 58', () => {
    // The anchor is the FIRST both-present instant, not the call start. Present from 0, the
    // span IS the call length — which is why `0→2 / 58→60` is a USELESS worked example (it
    // coincidentally equals the trivial full-call case and demonstrates nothing about gaps).
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 60), interval('client', 0, 2), interval('client', 58, 60)],
      at(90)
    );

    expect(clocks.billableMs).toBe(60 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(0));
  });

  it('DOCBLOCK PIN (BAL-132) — a `link`-channel guest stored `party="client"` contributes ZERO billableMs', () => {
    // ⚠⚠ THE THIRD PIN, AND THE ONE THAT PROVES A MONEY RULE RATHER THAN AN ARITHMETIC ONE.
    // A self-claimed lobby visitor's `party` is a PLACEHOLDER: `meeting_guests.party` is NOT
    // NULL and CHECK-narrowed to two labels, and a bare meeting URL carries no sharer
    // identity, so `claimLobbyPlace` writes `client` because the column demands a value —
    // not because anybody resolved a side.
    //
    // The scenario is the expensive one: the REAL client leaves at minute 10, and an
    // expert-side colleague who was forwarded the link sits in the room until minute 60.
    // Routed through `presencePartyForGuest` WITH the channel, that person is `observer` and
    // the billable span closes at 10. Had the placeholder `client` been trusted, the span
    // would run 0 → 60 and the client company would be billed 50 extra minutes for the
    // expert's own colleague.
    const lobbyGuestParty = presencePartyForGuest({ party: 'client', inviteChannel: 'link' });
    expect(lobbyGuestParty).toBe('observer');

    const clocks = computeMeetingClocks(
      [
        interval('expert', 0, 60),
        // The genuine client member, present for the first ten minutes only.
        interval('client', 0, 10),
        // The lobby knock, present throughout — and billable for none of it.
        interval(lobbyGuestParty, 0, 60),
      ],
      at(90)
    );

    expect(clocks.billableMs).toBe(10 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(0));
    expect(clocks.expertPresentMs).toBe(60 * MIN);
  });

  it('BAL-132 CONTROL — the SAME rows with the placeholder trusted would bill 60, not 10', () => {
    // The counterfactual, executed rather than asserted in prose: this is what the pin above
    // is worth. If a future edit made `presencePartyForGuest` ignore the invite channel, the
    // guest's row would come through as `client` and produce exactly this number.
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 60), interval('client', 0, 10), interval('client', 0, 60)],
      at(90)
    );

    expect(clocks.billableMs).toBe(60 * MIN);
  });

  // ── NON-FINITE INPUT (the `toSpans` guard) ───────────────────────────────────────────
  // Postgres CAN hold instants JavaScript cannot (`infinity`, `-infinity`, dates outside
  // JS's ±8.64e15 ms range), and postgres-js parses every one of them to an Invalid Date;
  // the CHECK `meeting_presence_left_after_joined` does not stop `left_at = 'infinity'`
  // either. What keeps it off the live path is the WRITE side — the driver throws on an
  // Invalid Date bind param — plus this module's own client-bundle surface
  // (`@balo/shared/meetings`, BAL-403), where a caller constructs `Date`s directly. See the
  // `toSpans` docblock for the round-trip these sentences come from.
  //
  // WHAT THESE TESTS HAVE TO PROVE, AND WHY A FIXED INPUT ORDER CANNOT. Left in, a
  // non-finite `start` reaches `merge`'s `(a, b) => a.start - b.start` and every comparison
  // involving it returns NaN — an INCONSISTENT COMPARATOR — so the corrupt element keeps
  // whatever position the caller's array gave it and the clocks of the VALID rows around it
  // depend on INPUT ORDER. It is NOT one fixed wrong number: executed with the guard
  // deleted, the `joinedAt` case below returns `expert 20 min / billable 10 min` for THREE
  // of its six orderings and `NaN / 0` for the other three — and the natural single
  // ordering (valid rows first, corrupt row appended) is one of the three that come out
  // RIGHT even unguarded. So each test runs ALL orderings and asserts one result across
  // them AND that it equals the uninterpretable-rows-REMOVED truth. Deleting the guard
  // fails every one of them.

  // Either endpoint can be the non-finite one, and both reduce to the SAME truth — the
  // expert really was present 0→20 only — so they share one body rather than two
  // near-identical ones (which SonarCloud would also read as new-code duplication).
  const CORRUPT_ROWS: ReadonlyArray<{ endpoint: string; corrupt: PresenceInterval }> = [
    { endpoint: 'joinedAt', corrupt: { party: 'expert', joinedAt: INVALID, leftAt: at(60) } },
    { endpoint: 'leftAt', corrupt: { party: 'expert', joinedAt: at(30), leftAt: INVALID } },
  ];

  it.each(CORRUPT_ROWS)(
    'a non-finite $endpoint is SKIPPED — same result in EVERY input order, and it is the corrupt-row-removed truth',
    ({ corrupt }) => {
      const interpretable = [interval('expert', 0, 20), interval('client', 10, 60)];

      const clocks = expectOrderInvariantTruth(
        [...interpretable, corrupt],
        interpretable,
        at(90),
        6
      );

      expect(clocks.expertPresentMs).toBe(20 * MIN);
      expect(clocks.billableMs).toBe(10 * MIN); // 10 → 20: the truth with the garbage removed
      expect(clocks.expertFirstJoinedAt).toEqual(at(0));
      expect(clocks.billableStartedAt).toEqual(at(10));
    }
  );

  it('an ALL-non-finite input yields zero clocks and null anchors, in every input order', () => {
    const corrupt: PresenceInterval[] = [
      { party: 'expert', joinedAt: INVALID, leftAt: null },
      { party: 'expert', joinedAt: at(0), leftAt: INVALID },
      { party: 'client', joinedAt: INVALID, leftAt: INVALID },
    ];

    // Nothing is interpretable, so the truth is the empty input.
    const clocks = expectOrderInvariantTruth(corrupt, [], at(60), 6);

    expect(clocks).toEqual({
      expertPresentMs: 0,
      billableMs: 0,
      expertFirstJoinedAt: null,
      billableStartedAt: null,
    });
  });

  it('an Invalid `now` drops every still-OPEN interval — the LOUD→SILENT residual, pinned', () => {
    // `now` closes open intervals, so an Invalid `now` makes each of them non-finite and the
    // guard drops them ALL — returning a plausible FINITE number where the pre-guard code
    // returned NaN. Unreachable in production (`resolveClockCeiling` supplies
    // `meetings.ended_at` or `new Date()`), but it is a real trade and it is asserted here
    // rather than left to be discovered.
    const closed = [interval('expert', 0, 20), interval('client', 5, 25)];
    const stillOpen = interval('expert', 30, null);

    const clocks = expectOrderInvariantTruth([...closed, stillOpen], closed, INVALID, 6);

    expect(clocks.expertPresentMs).toBe(20 * MIN); // NOT NaN, and NOT 0 → 30+
    expect(clocks.billableMs).toBe(15 * MIN); // 5 → 20
    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
    expect(clocks.billableStartedAt).toEqual(at(5));
  });

  // ── FINITE CLAMP (`Math.max`, NOT the guard) ─────────────────────────────────────────
  // This one is here for contrast: it is unaffected by the `Number.isFinite` guard (all its
  // endpoints are finite) and pins the OTHER half of the expression.

  it('a FINITE malformed row (leftAt BEFORE joinedAt) still clamps to a zero-length span', () => {
    // Unlike a non-finite row this one HAS a position on the timeline, so it is KEPT and
    // clamped rather than dropped. The DB CHECK `meeting_presence_left_after_joined`
    // already rejects it, so this is defensive — but the behaviour is pinned either way.
    const clocks = computeMeetingClocks(
      [{ party: 'expert', joinedAt: at(30), leftAt: at(10) }, interval('client', 0, 60)],
      at(90)
    );

    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.expertFirstJoinedAt).toEqual(at(30));
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toEqual(at(30));
  });

  it('input order is irrelevant', () => {
    const forward = computeMeetingClocks(
      [interval('expert', 0, 40), interval('client', 5, 15), interval('client', 25, 35)],
      at(60)
    );
    const shuffled = computeMeetingClocks(
      [interval('client', 25, 35), interval('client', 5, 15), interval('expert', 0, 40)],
      at(60)
    );

    expect(shuffled).toEqual(forward);
  });
});

// ── BAL-474 Rule A (D13) ──────────────────────────────────────────────────────────────────────────────

/** T = `T0`. The test's OWN oracle: count the seconds before T an expert row and a client row are both open. */
function oracleTogetherMs(intervals: readonly PresenceInterval[], now: Date): number {
  const from = T0.getTime() - 24 * 60 * MIN;
  const open = (party: PresenceInterval['party'], second: number): boolean =>
    intervals.some(
      (row) =>
        row.party === party &&
        row.joinedAt.getTime() <= second &&
        second < (row.leftAt === null ? now.getTime() : row.leftAt.getTime())
    );
  let together = 0;
  for (let second = from; second < T0.getTime(); second += 1_000) {
    if (open('expert', second) && open('client', second)) {
      together += 1_000;
    }
  }
  return together;
}

describe('clampIntervalsToStart — BAL-134 R10, applied at READ time', () => {
  const start = T0;

  it('raises a join before the start to the start, and leaves a join at or after it alone', () => {
    const [early, exact, late] = clampIntervalsToStart(
      [interval('expert', -5, 30), interval('expert', 0, 30), interval('expert', 5, 30)],
      start
    );
    expect(early?.joinedAt).toEqual(start);
    expect(exact?.joinedAt).toEqual(start);
    expect(late?.joinedAt).toEqual(at(5));
  });

  it('an interval that ended BEFORE the start collapses to a zero-length interval AT the start (the old write clamp)', () => {
    const [collapsed] = clampIntervalsToStart([interval('client', -20, -10)], start);
    expect(collapsed?.joinedAt).toEqual(start);
    expect(collapsed?.leftAt).toEqual(start);
  });

  it('a leave after the start is kept; an open interval stays open', () => {
    const [kept, open] = clampIntervalsToStart(
      [interval('expert', -5, 30), interval('client', -5, null)],
      start
    );
    expect(kept?.leftAt).toEqual(at(30));
    expect(open?.leftAt).toBeNull();
    expect(open?.joinedAt).toEqual(start);
  });

  it('never mutates its input and keeps every other property on the row', () => {
    const original = { ...interval('expert', -5, 30), id: 'row-1' };
    const [clamped] = clampIntervalsToStart([original], start);
    expect(original.joinedAt).toEqual(at(-5));
    expect(clamped).toMatchObject({ id: 'row-1', party: 'expert' });
  });

  it('passes a non-finite row through untouched (computeMeetingClocks skips it), and a non-finite start changes nothing', () => {
    const bad: PresenceInterval = { party: 'expert', joinedAt: INVALID, leftAt: null };
    expect(clampIntervalsToStart([bad], start)).toEqual([bad]);
    const rows = [interval('expert', -5, 30)];
    expect(clampIntervalsToStart(rows, INVALID)).toEqual(rows);
  });

  it('computeMeetingClocks over the CLAMPED intervals is exactly what the old write-side clamp fed it', () => {
    const raw = [
      interval('expert', -30, 60),
      interval('client', -30, -29),
      interval('client', 0, 60),
    ];
    const clocks = computeMeetingClocks(clampIntervalsToStart(raw, start), at(60));
    expect(clocks.expertFirstJoinedAt).toEqual(start);
    expect(clocks.expertPresentMs).toBe(60 * MIN);
    expect(clocks.billableStartedAt).toEqual(start);
  });
});

describe('coPresentMsBefore — Rule A: the sum of the real expert ∩ client intersection before T', () => {
  const together = (intervals: readonly PresenceInterval[], now: Date = at(120)): number =>
    coPresentMsBefore(intervals, T0, now);

  const EXAMPLES: ReadonlyArray<readonly [string, PresenceInterval[], number]> = [
    [
      'example 1 — 09:50–10:40 together',
      [interval('expert', -10, 40), interval('client', -10, 40)],
      10,
    ],
    [
      'example 2 — together 09:00–09:01, the client is back only at 10:00',
      [interval('expert', -60, 60), interval('client', -60, -59), interval('client', 0, 60)],
      1,
    ],
    [
      'example 3 — together 09:50–09:54, both back at 10:00',
      [
        interval('expert', -10, -6),
        interval('client', -10, -6),
        interval('expert', 0, 45),
        interval('client', 0, 45),
      ],
      4,
    ],
    [
      'example 4 — together 09:30–09:55',
      [interval('expert', -30, -5), interval('client', -30, -5)],
      25,
    ],
    [
      'example 5 — together 09:30–09:31, the expert waits 10:00–10:15',
      [interval('expert', -30, -29), interval('client', -30, -29), interval('expert', 0, 15)],
      1,
    ],
    [
      'F1 row — both 06:00–11:00',
      [interval('expert', -240, 60), interval('client', -240, 60)],
      240,
    ],
  ];

  it.each(EXAMPLES)('%s', (_label, intervals, expectedMinutes) => {
    expect(together(intervals)).toBe(expectedMinutes * MIN);
    // …and it agrees with the independent second-sampling oracle.
    expect(together(intervals)).toBe(oracleTogetherMs(intervals, at(120)));
    expect(EXAMPLES).toHaveLength(6);
  });

  it('a SOLO early wait (either side) is not together', () => {
    expect(together([interval('expert', -60, 30), interval('client', 0, 30)])).toBe(0);
    expect(together([interval('client', -60, 30), interval('expert', 0, 30)])).toBe(0);
  });

  it('an OBSERVER is on neither side', () => {
    expect(together([interval('observer', -30, 30), interval('expert', -30, 30)])).toBe(0);
    expect(together([interval('observer', -30, 30), interval('client', -30, 30)])).toBe(0);
  });

  it('two overlapping rows of one party (two devices) count the time ONCE', () => {
    expect(
      together([
        interval('expert', -20, 30),
        interval('client', -20, -10),
        interval('client', -15, -5),
      ])
    ).toBe(15 * MIN);
  });

  it('an OPEN row runs to `now`: while the room is still together at T−4 it is 6 minutes, and never past T', () => {
    const open = [interval('expert', -10, null), interval('client', -10, null)];
    expect(coPresentMsBefore(open, T0, at(-4))).toBe(6 * MIN);
    expect(coPresentMsBefore(open, T0, at(30))).toBe(10 * MIN);
  });

  it('is order-independent (all six orderings of a three-row scenario)', () => {
    const rows = [
      interval('expert', -30, 30),
      interval('client', -30, -20),
      interval('client', -10, 30),
    ];
    const expected = together(rows);
    expect(expected).toBe(20 * MIN);
    for (const ordering of permutations(rows)) {
      expect(together(ordering)).toBe(expected);
    }
  });

  it('a non-finite row is skipped, deterministically', () => {
    const rows: PresenceInterval[] = [
      interval('expert', -10, 30),
      interval('client', -10, 30),
      { party: 'client', joinedAt: INVALID, leftAt: null },
    ];
    expect(together(rows)).toBe(10 * MIN);
    expect(together([...rows].reverse())).toBe(10 * MIN);
  });

  it('a non-finite start yields 0, and nothing before the start yields 0', () => {
    expect(
      coPresentMsBefore([interval('expert', -10, 30), interval('client', -10, 30)], INVALID, at(30))
    ).toBe(0);
    expect(together([interval('expert', 5, 30), interval('client', 5, 30)])).toBe(0);
  });
});

describe('expertPresentFromStartMs — D15.3: the expert’s span from their first presence AT OR AFTER the start', () => {
  const START = T0;
  const from = (intervals: readonly PresenceInterval[], now = at(600)) =>
    expertPresentFromStartMs(intervals, START, now);

  it('⚠⚠ a row entirely before the start does not anchor it: 09:00–09:30 then 10:10–11:00 is 50, not 60', () => {
    expect(from([interval('expert', -60, -30), interval('expert', 10, 60)])).toBe(50 * MIN);
  });

  it('a row that SPANS the start begins at the start', () => {
    expect(from([interval('expert', -10, 40)])).toBe(40 * MIN);
  });

  it('a row that ends EXACTLY at the start does not anchor it (`leftAt <= T`)', () => {
    expect(from([interval('expert', -30, 0), interval('expert', 10, 60)])).toBe(50 * MIN);
    expect(from([interval('expert', -30, 0)])).toBe(0);
  });

  it('0 when the expert was never present at or after the start (only before it)', () => {
    expect(from([interval('expert', -60, -5)])).toBe(0);
  });

  it('0 when there is no expert row at all — client and observer rows are on neither side', () => {
    expect(from([interval('client', 0, 30), interval('observer', 0, 30)])).toBe(0);
  });

  it('is gap-inclusive AFTER the start: 10:05–10:10 and 10:30–10:40 is 35', () => {
    expect(from([interval('expert', 5, 10), interval('expert', 30, 40)])).toBe(35 * MIN);
  });

  it('a pre-deploy row stored CLAMPED (joined = left = T) has leftAt <= T and is dropped', () => {
    expect(from([interval('expert', 0, 0), interval('expert', 10, 60)])).toBe(50 * MIN);
  });

  it('an OPEN row runs to `now`', () => {
    expect(from([interval('expert', -20, null)], at(45))).toBe(45 * MIN);
    expect(from([interval('expert', 10, null)], at(45))).toBe(35 * MIN);
  });

  it('is independent of input order', () => {
    const rows = [
      interval('expert', -60, -30),
      interval('expert', 10, 30),
      interval('expert', 40, 60),
    ];
    for (const ordering of permutations(rows)) {
      expect(from(ordering)).toBe(50 * MIN);
    }
  });

  it('skips a non-finite row and fails closed on a non-finite start', () => {
    expect(
      from([{ party: 'expert', joinedAt: INVALID, leftAt: at(30) }, interval('expert', 10, 60)])
    ).toBe(50 * MIN);
    expect(expertPresentFromStartMs([interval('expert', 10, 60)], INVALID, at(600))).toBe(0);
  });

  it('agrees with the start-clamped clocks whenever no expert row ended before the start', () => {
    const rows = [
      interval('expert', -10, 20),
      interval('expert', 30, 50),
      interval('client', 0, 50),
    ];
    const clocks = computeMeetingClocks(clampIntervalsToStart(rows, START), at(600));
    expect(from(rows)).toBe(clocks.expertPresentMs);
  });
});

describe('currentCoPresenceStartedAt — since when have both been here?', () => {
  it('is the LATER of the two parties’ earliest open joins', () => {
    expect(
      currentCoPresenceStartedAt([interval('expert', -20, null), interval('client', -5, null)])
    ).toEqual(at(-5));
    expect(
      currentCoPresenceStartedAt([interval('client', -20, null), interval('expert', -5, null)])
    ).toEqual(at(-5));
  });

  it('is null unless BOTH an expert and a client row are open', () => {
    expect(currentCoPresenceStartedAt([])).toBeNull();
    expect(currentCoPresenceStartedAt([interval('expert', -5, null)])).toBeNull();
    expect(currentCoPresenceStartedAt([interval('client', -5, null)])).toBeNull();
    expect(
      currentCoPresenceStartedAt([interval('expert', -5, null), interval('observer', -5, null)])
    ).toBeNull();
  });

  it('with two devices, a party’s EARLIEST open row wins', () => {
    expect(
      currentCoPresenceStartedAt([
        interval('expert', -30, null),
        interval('expert', -10, null),
        interval('client', -20, null),
        interval('client', -2, null),
      ])
    ).toEqual(at(-20));
  });

  it('a CLOSED row is not co-presence, and a non-finite join is skipped', () => {
    expect(
      currentCoPresenceStartedAt([interval('expert', -5, null), interval('client', -5, -1)])
    ).toBeNull();
    expect(
      currentCoPresenceStartedAt([
        interval('expert', -5, null),
        { party: 'client', joinedAt: INVALID, leftAt: null },
      ])
    ).toBeNull();
  });
});
