import { describe, expect, it } from 'vitest';
import type { MeetingLifecycleStatus, MeetingViewerRole } from '@balo/shared/meetings';
import { resolveTopBarClock } from './top-bar-clock';
import type { MeetingStateSnapshot } from './meeting-state';

/**
 * BAL-134 (§7.3) — **THE TOP-BAR CLOCK MATRIX, EXECUTED AS A TABLE.**
 *
 * `top-bar-clock.ts`'s own docblock says the function "reads no clock… that is what makes the
 * matrix below executable as a table-driven test". This is that table. Plan §12 mandates it by
 * name, and the module shipped with no test at all.
 *
 * ⚠⚠ THE BEHAVIOUR UNDER TEST IS A MONEY CLAIM, NOT CHROME. The amber `counted` chip tells a
 * delivering expert that their time is being credited while they wait; the client sees
 * `not_started` in the SAME room state because nothing is being charged. Two different true
 * sentences about one meeting — and getting either wrong is what BAL-134 says makes an expert
 * leave at minute eight and forfeit a settlement they had already earned.
 */

const ASOF = new Date('2026-08-14T10:12:00.000Z');
const JOINED = new Date('2026-08-14T10:00:00.000Z');

interface SnapshotOverrides {
  readonly status?: MeetingLifecycleStatus;
  readonly viewerRole?: MeetingViewerRole;
  readonly expertFirstJoinedAt?: Date | null;
  readonly expertPresenceOpen?: boolean | null;
  readonly expertPresentMs?: number;
  readonly billableMs?: number;
}

function snapshotOf(overrides: SnapshotOverrides = {}): MeetingStateSnapshot {
  return {
    status: overrides.status ?? 'waiting_for_participants',
    outcome: null,
    endedBy: null,
    viewerRole: overrides.viewerRole ?? 'expert',
    phase: 'running',
    clocks: {
      expertPresentMs: overrides.expertPresentMs ?? 720_000,
      billableMs: overrides.billableMs ?? 0,
      expertFirstJoinedAt:
        overrides.expertFirstJoinedAt === undefined ? JOINED : overrides.expertFirstJoinedAt,
      billableStartedAt: null,
    },
    asOf: ASOF,
    noShowFloorMinutes: 15,
    expertPresenceOpen:
      overrides.expertPresenceOpen === undefined ? true : overrides.expertPresenceOpen,
  };
}

/**
 * ⚠⚠ `null` RATHER THAN `{ kind: 'not_started' }` FOR "NO MIRROR", AND THE DIFFERENCE IS NOT
 * COSMETIC. Collapsing them would put "Not started" on a GUEST's screen for the whole of a live
 * call — the guest surfaces poll nothing at all, the state route being member-only (N5,
 * fix-round-2 — corrected: not because they mount no provider; both DO) — and would flash it on
 * the member route for the one render before the first poll returns.
 */
describe('resolveTopBarClock — no server mirror', () => {
  it('returns null so the frame keeps its shipped local chrome', () => {
    expect(resolveTopBarClock({ snapshot: null })).toBeNull();
  });
});

describe('resolveTopBarClock — the §7.3 matrix', () => {
  const CASES = [
    {
      name: 'scheduled / expert → not_started (nobody has opened an interval)',
      overrides: { status: 'scheduled', viewerRole: 'expert' },
      expected: { kind: 'not_started' },
    },
    {
      name: 'scheduled / client → not_started',
      overrides: { status: 'scheduled', viewerRole: 'client' },
      expected: { kind: 'not_started' },
    },
    {
      name: '⚠⚠ waiting / EXPERT present → counted (the amber chip this ticket exists for)',
      overrides: { status: 'waiting_for_participants', viewerRole: 'expert' },
      expected: 'counted',
    },
    {
      name: '⚠⚠ waiting / CLIENT → not_started — nothing is being CHARGED, and that is the point',
      overrides: { status: 'waiting_for_participants', viewerRole: 'client' },
      expected: { kind: 'not_started' },
    },
    {
      name: 'waiting / expert NOT present → not_started (nothing counted for anyone)',
      overrides: {
        status: 'waiting_for_participants',
        viewerRole: 'expert',
        expertPresenceOpen: false,
        expertFirstJoinedAt: null,
      },
      expected: { kind: 'not_started' },
    },
    {
      name: 'in_progress / expert → billable — the one arm where both lenses agree',
      overrides: { status: 'in_progress', viewerRole: 'expert' },
      expected: 'billable',
    },
    {
      name: 'in_progress / client → billable, the SAME number',
      overrides: { status: 'in_progress', viewerRole: 'client' },
      expected: 'billable',
    },
    {
      name: 'ended / expert → not_started',
      overrides: { status: 'ended', viewerRole: 'expert' },
      expected: { kind: 'not_started' },
    },
    {
      name: 'cancelled / client → not_started',
      overrides: { status: 'cancelled', viewerRole: 'client' },
      expected: { kind: 'not_started' },
    },
  ] as const satisfies readonly {
    name: string;
    overrides: SnapshotOverrides;
    expected: { kind: 'not_started' } | 'counted' | 'billable';
  }[];

  for (const testCase of CASES) {
    it(testCase.name, () => {
      const snapshot = snapshotOf(testCase.overrides);
      const result = resolveTopBarClock({ snapshot });

      if (typeof testCase.expected === 'string') {
        expect(result).toEqual({
          kind: testCase.expected,
          clocks: snapshot.clocks,
          asOf: snapshot.asOf,
        });
        return;
      }
      expect(result).toEqual(testCase.expected);
    });
  }

  it('⚠ a terminal meeting never shows a running clock, on EITHER lens', () => {
    for (const status of ['ended', 'cancelled'] as const) {
      for (const viewerRole of ['expert', 'client'] as const) {
        expect(resolveTopBarClock({ snapshot: snapshotOf({ status, viewerRole }) })).toEqual({
          kind: 'not_started',
        });
      }
    }
  });

  it('⚠ the snapshot arms carry `asOf`, which is what lets the browser interpolate honestly', () => {
    const snapshot = snapshotOf({ status: 'in_progress' });
    const result = resolveTopBarClock({ snapshot });
    expect(result).toMatchObject({ asOf: ASOF });
  });
});

/**
 * ⚠⚠ **"AN EXPERT IS IN THE ROOM RIGHT NOW", NOT "AN EXPERT EVER JOINED".**
 *
 * The chip used to gate on `clocks.expertFirstJoinedAt !== null` — a fact about the PAST that
 * never becomes false again. An expert whose interval closed (network drop, killed tab, closed
 * laptop) has a FROZEN `expertPresentMs` server-side while the chip kept ticking a locally
 * interpolated duration against `asOf`, forever. §7.3's matrix says the opposite in writing:
 * *expert NOT present → `not_started`*.
 */
describe('resolveTopBarClock — the chip gates on LIVE presence (BAL-134)', () => {
  it('⚠⚠ an expert who joined and then DROPPED gets not_started, not a ticking chip', () => {
    const snapshot = snapshotOf({
      viewerRole: 'expert',
      // They joined — so the old gate would have said "counted" — but their interval is CLOSED.
      expertFirstJoinedAt: JOINED,
      expertPresenceOpen: false,
      expertPresentMs: 480_000,
    });

    expect(resolveTopBarClock({ snapshot })).toEqual({ kind: 'not_started' });
  });

  it('shows the counted chip while the interval is genuinely open', () => {
    const snapshot = snapshotOf({ viewerRole: 'expert', expertPresenceOpen: true });
    expect(resolveTopBarClock({ snapshot })).toMatchObject({ kind: 'counted' });
  });

  it('⚠ `expertPresentMs === 0` on the arrival tick still shows the chip — it is a SPAN', () => {
    // Branching on the duration would make the instant of arrival indistinguishable from "no
    // expert yet" and the chip would flicker off for one tick.
    const snapshot = snapshotOf({ expertPresentMs: 0, expertPresenceOpen: true });
    expect(resolveTopBarClock({ snapshot })).toMatchObject({ kind: 'counted' });
  });

  it('⚠ an api that has not sent `presence` yet falls back to "ever joined"', () => {
    // The deploy-skew arm: the OLD, over-stating behaviour, chosen because the alternative blanks
    // the amber chip for every expert until the api catches up. Bounded, documented, not correct.
    expect(
      resolveTopBarClock({ snapshot: snapshotOf({ expertPresenceOpen: null }) })
    ).toMatchObject({ kind: 'counted' });
    expect(
      resolveTopBarClock({
        snapshot: snapshotOf({ expertPresenceOpen: null, expertFirstJoinedAt: null }),
      })
    ).toEqual({ kind: 'not_started' });
  });

  it('⚠ live presence OVERRIDES the fallback in both directions', () => {
    // Present per the server, but never "first joined" in the clocks → still counted.
    expect(
      resolveTopBarClock({
        snapshot: snapshotOf({ expertPresenceOpen: true, expertFirstJoinedAt: null }),
      })
    ).toMatchObject({ kind: 'counted' });
    // Joined once, but not present now → not started.
    expect(
      resolveTopBarClock({
        snapshot: snapshotOf({ expertPresenceOpen: false, expertFirstJoinedAt: JOINED }),
      })
    ).toEqual({ kind: 'not_started' });
  });

  it('⚠ presence does NOT resurrect a clock on a client lens', () => {
    expect(
      resolveTopBarClock({
        snapshot: snapshotOf({ viewerRole: 'client', expertPresenceOpen: true }),
      })
    ).toEqual({ kind: 'not_started' });
  });
});

/**
 * ⚠ THE FUNCTION READS NO CLOCK. Every arm is chosen from the snapshot alone, which is what makes
 * the table above a complete specification rather than a sample.
 */
describe('resolveTopBarClock — purity', () => {
  it('is deterministic across repeated calls with the same snapshot', () => {
    const snapshot = snapshotOf({ status: 'in_progress' });
    expect(resolveTopBarClock({ snapshot })).toEqual(resolveTopBarClock({ snapshot }));
  });

  it('never produces a money figure — only durations and the instant they were taken', () => {
    const result = resolveTopBarClock({ snapshot: snapshotOf({ status: 'in_progress' }) });
    expect(JSON.stringify(result)).not.toMatch(/amount|price|cost|minor|currency/i);
  });
});
