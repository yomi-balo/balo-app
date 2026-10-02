import { describe, expect, it } from 'vitest';
import { resolveMeetingSettlement, type MeetingSettlementInput } from '@balo/shared/credit';
import {
  DEFAULT_MEETING_TIMERS,
  computeMeetingClocks,
  resolveTerminalRule,
  summarisePresence,
  type PresenceInterval,
} from '@balo/shared/meetings';

/**
 * ⚠⚠ INVARIANT — **BEFORE THE SCHEDULED START, ONLY TIME TOGETHER BILLS; FROM THE START, TIME COUNTS
 * EXACTLY AS BEFORE.** ADR-1040 Amendment 7 §D / ADR-1044 (billing Rule A), owner ruling D13
 * (Yomi, 2026-09-27), built in BAL-474.
 *
 * The rule: billable = |expert ∩ client-side, strictly before T| + the from-T figure (D15.3: the expert's
 * gap-inclusive span from their FIRST PRESENCE AT OR AFTER T — a row spanning T starts at T, a row entirely
 * before T does not anchor it — to their last presence). The 15-minute floor and the F1 cap apply to that
 * TOTAL. (Before D15.3 the from-T figure was BAL-412's `max(T, expert first join)` over the start-clamped
 * clocks, which anchors at T for an expert who checked in early and came back late; that clock still decides
 * the shape and the no-show, and rows 15–16 pin the difference.) There is no lower time bound: only minutes both parties were
 * really in the room bill before T, so a solo early wait — or a click days early with nobody else
 * there — bills nothing.
 *
 * ⚠ THE `togetherBeforeStartMs` INPUT IS COMPUTED HERE BY THE TEST'S OWN ORACLE, not by production
 * code. The oracle samples every second before T and counts the seconds an expert row AND a client
 * row are both open. The production helpers (`coPresentMsBefore`, `clampIntervalsToStart`) are
 * pinned against the same oracle in `packages/shared/src/meetings/index.test.ts`. So this file is
 * RED on a tree whose SETTLEMENT ignores the together term, whatever else exists.
 *
 * ⚠ THE CLOCKS ARE BUILT THE WAY THE READERS BUILD THEM: `computeMeetingClocks` over intervals
 * clamped to T (BAL-134's R10 rule, applied at read time — presence rows are stored at their true
 * instants). They decide the SHAPE and the no-show clock, which are unchanged.
 *
 * ⚠⚠ D15.3 — THE FROM-START FIGURE COUNTS FROM THE EXPERT'S FIRST PRESENCE AT OR AFTER T. It is the
 * gap-inclusive span of the expert's presence at or after T: a row that spans T starts at T, a row
 * entirely before T (`leftAt <= T`) does not anchor it, and an expert never present at or after T is 0.
 * `oracleExpertFromStartMs` restates that rule by sampling seconds, independently of production
 * (`expertPresentFromStartMs`). Rows 15-16 are RED on a tree that anchors the clock at T for an expert
 * who arrives late after an early check-in: together 09:00-09:30 and both back at 10:10 must bill 30 + 50,
 * not 30 + 60.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;
const FLOOR_MS = 15 * MS_PER_MINUTE;
const MAX_BILLABLE_MINUTES = 240;

/** T = 10:00 UTC. Every instant below is a wall-clock string on this day. */
const SCHEDULED_START = new Date('2026-09-27T10:00:00.000Z');
const SCHEDULED_END = new Date('2026-09-27T11:00:00.000Z');
const DAY_START = new Date('2026-09-27T00:00:00.000Z');

function clock(hhmm: string): Date {
  return new Date(`2026-09-27T${hhmm}:00.000Z`);
}

interface Presence {
  readonly party: 'expert' | 'client' | 'observer';
  readonly from: string;
  readonly to: string | null;
}

function toIntervals(rows: readonly Presence[]): PresenceInterval[] {
  return rows.map((row) => ({
    party: row.party,
    joinedAt: clock(row.from),
    leftAt: row.to === null ? null : clock(row.to),
  }));
}

/** BAL-134 R10, restated by the test itself (never imported): raise the join, then the leave. */
function clampToStartOwn(intervals: readonly PresenceInterval[]): PresenceInterval[] {
  return intervals.map((interval) => {
    const joinedAt = new Date(Math.max(interval.joinedAt.getTime(), SCHEDULED_START.getTime()));
    const leftAt =
      interval.leftAt === null
        ? null
        : new Date(Math.max(interval.leftAt.getTime(), joinedAt.getTime()));
    return { party: interval.party, joinedAt, leftAt };
  });
}

/**
 * THE ORACLE. One sample per second of the day before T: an expert row and a client row are both
 * open at that second (half-open `[joined, left)`; an open row runs to `now`). Independent of the
 * production span arithmetic, so it cannot share a defect with it.
 */
function oracleTogetherBeforeStartMs(intervals: readonly PresenceInterval[], now: Date): number {
  const openAt = (party: PresenceInterval['party'], second: number): boolean =>
    intervals.some(
      (interval) =>
        interval.party === party &&
        interval.joinedAt.getTime() <= second &&
        second < (interval.leftAt === null ? now.getTime() : interval.leftAt.getTime())
    );
  let together = 0;
  for (
    let second = DAY_START.getTime();
    second < SCHEDULED_START.getTime();
    second += MS_PER_SECOND
  ) {
    if (openAt('expert', second) && openAt('client', second)) {
      together += MS_PER_SECOND;
    }
  }
  return together;
}

/**
 * THE ORACLE FOR THE FROM-START FIGURE (D15.3). Samples every second from T to the end of the day: the
 * first second an expert row is open at or after T, to the end of the last such second. Zero if none.
 */
function oracleExpertFromStartMs(intervals: readonly PresenceInterval[], now: Date): number {
  let first: number | null = null;
  let last: number | null = null;
  for (
    let second = SCHEDULED_START.getTime();
    second < DAY_START.getTime() + 24 * 60 * MS_PER_MINUTE;
    second += MS_PER_SECOND
  ) {
    const open = intervals.some(
      (interval) =>
        interval.party === 'expert' &&
        interval.joinedAt.getTime() <= second &&
        second < (interval.leftAt === null ? now.getTime() : interval.leftAt.getTime())
    );
    if (open) {
      first ??= second;
      last = second + MS_PER_SECOND;
    }
  }
  return first === null || last === null ? 0 : last - first;
}

interface Row {
  readonly label: string;
  readonly presence: readonly Presence[];
  readonly end: string;
  readonly drawn?: number;
  readonly expect: {
    readonly billable: number;
    readonly actual?: number;
    readonly shape: 'held' | 'no_show_client' | 'abandoned_wait';
    readonly floorApplied?: boolean;
    readonly uncapped?: number;
  };
  /** RED today (the together term is what is missing) or a control that is GREEN today. */
  readonly kind: 'red' | 'control';
}

function settle(row: Row): ReturnType<typeof resolveMeetingSettlement> {
  const raw = toIntervals(row.presence);
  const end = clock(row.end);
  const togetherBeforeStartMs = oracleTogetherBeforeStartMs(raw, end);
  const clocks = computeMeetingClocks(clampToStartOwn(raw), end);
  // A NON-fresh object on purpose: `expertPresentFromStartMs` is not on the input type until D15.3 is
  // built, and a fresh literal would fail the excess-property check instead of failing on ASSERTION.
  const input = {
    clocks,
    togetherBeforeStartMs,
    expertPresentFromStartMs: oracleExpertFromStartMs(raw, end),
    scheduledStart: SCHEDULED_START,
    clientSideEverPresent: summarisePresence(raw).clientSideEverPresent,
    floorMs: FLOOR_MS,
    minutesAlreadyDrawn: row.drawn ?? 0,
    maxBillableMinutes: MAX_BILLABLE_MINUTES,
  };
  return resolveMeetingSettlement(input as MeetingSettlementInput);
}

const ROWS: readonly Row[] = [
  {
    kind: 'red',
    label: '1 — together 09:50–10:40 (D13 example 1)',
    presence: [
      { party: 'expert', from: '09:50', to: '10:40' },
      { party: 'client', from: '09:50', to: '10:40' },
    ],
    end: '10:40',
    expect: { billable: 50, actual: 50, shape: 'held' },
  },
  {
    kind: 'red',
    label:
      '2 — together 09:00–09:01, the expert waits alone, the client is back at 10:00 (example 2)',
    presence: [
      { party: 'expert', from: '09:00', to: '11:00' },
      { party: 'client', from: '09:00', to: '09:01' },
      { party: 'client', from: '10:00', to: '11:00' },
    ],
    end: '11:00',
    expect: { billable: 61, shape: 'held' },
  },
  {
    kind: 'red',
    label: '3 — together 09:50–09:54, both leave, back at 10:00 (example 3)',
    presence: [
      { party: 'expert', from: '09:50', to: '09:54' },
      { party: 'client', from: '09:50', to: '09:54' },
      { party: 'expert', from: '10:00', to: '10:45' },
      { party: 'client', from: '10:00', to: '10:45' },
    ],
    end: '10:45',
    expect: { billable: 49, shape: 'held' },
  },
  {
    kind: 'red',
    label: '4 — together 09:30–09:55, nobody returns (example 4)',
    presence: [
      { party: 'expert', from: '09:30', to: '09:55' },
      { party: 'client', from: '09:30', to: '09:55' },
    ],
    end: '10:05',
    expect: { billable: 25, actual: 25, shape: 'held' },
  },
  {
    kind: 'red',
    label:
      '5 — together 09:30–09:31, the client never returns, the expert waits 10:00–10:15 (example 5)',
    presence: [
      { party: 'expert', from: '09:30', to: '09:31' },
      { party: 'client', from: '09:30', to: '09:31' },
      { party: 'expert', from: '10:00', to: '10:15' },
    ],
    end: '10:20',
    expect: { billable: 16, shape: 'held' },
  },
  {
    kind: 'red',
    label: '6 — the FLOOR applies to the total: together 5 minutes only → billed 15, actual 5',
    presence: [
      { party: 'expert', from: '09:50', to: '09:55' },
      { party: 'client', from: '09:50', to: '09:55' },
    ],
    end: '10:05',
    expect: { billable: 15, actual: 5, shape: 'held', floorApplied: true },
  },
  {
    kind: 'red',
    label: '7 — F1 caps the TOTAL: together 06:00–10:00 plus 60 from T is 300, capped at 240',
    presence: [
      { party: 'expert', from: '06:00', to: '11:00' },
      { party: 'client', from: '06:00', to: '11:00' },
    ],
    end: '11:00',
    expect: { billable: 240, shape: 'held', uncapped: 300 },
  },
  {
    kind: 'red',
    label:
      '8 — agreement with the meter: row 1 with 40 minutes already drawn from T is still 50 (no Q1)',
    presence: [
      { party: 'expert', from: '09:50', to: '10:40' },
      { party: 'client', from: '09:50', to: '10:40' },
    ],
    end: '10:40',
    drawn: 40,
    expect: { billable: 50, shape: 'held' },
  },
  {
    kind: 'red',
    label:
      '15 — D15.3: together 09:00–09:30, both back 10:10–11:00 → 30 + 50 = 80 (the 10:00–10:10 gap is not billed)',
    presence: [
      { party: 'expert', from: '09:00', to: '09:30' },
      { party: 'client', from: '09:00', to: '09:30' },
      { party: 'expert', from: '10:10', to: '11:00' },
      { party: 'client', from: '10:10', to: '11:00' },
    ],
    end: '11:00',
    expect: { billable: 80, actual: 80, shape: 'held' },
  },
  {
    kind: 'red',
    label:
      '16 — D15.3: the expert alone 09:00–09:05 (D4: not credited), then both 10:10–10:40 → 0 + 30 = 30',
    presence: [
      { party: 'expert', from: '09:00', to: '09:05' },
      { party: 'expert', from: '10:10', to: '10:40' },
      { party: 'client', from: '10:10', to: '10:40' },
    ],
    end: '10:40',
    expect: { billable: 30, actual: 30, shape: 'held' },
  },
  {
    kind: 'control',
    label:
      '17 — D15.3 control: an expert row SPANNING T (09:50–10:40) with the client from 10:10 → the from-start figure still starts at T: 40',
    presence: [
      { party: 'expert', from: '09:50', to: '10:40' },
      { party: 'client', from: '10:10', to: '10:40' },
    ],
    end: '10:40',
    expect: { billable: 40, actual: 40, shape: 'held' },
  },
  {
    kind: 'control',
    label: '9 — control, a solo EARLY EXPERT: expert 09:00–10:30, client 10:00–10:30',
    presence: [
      { party: 'expert', from: '09:00', to: '10:30' },
      { party: 'client', from: '10:00', to: '10:30' },
    ],
    end: '10:30',
    expect: { billable: 30, shape: 'held' },
  },
  {
    kind: 'control',
    label: '10 — control, a solo EARLY CLIENT: client 09:00–10:30, expert 10:00–10:30',
    presence: [
      { party: 'client', from: '09:00', to: '10:30' },
      { party: 'expert', from: '10:00', to: '10:30' },
    ],
    end: '10:30',
    expect: { billable: 30, shape: 'held' },
  },
  {
    kind: 'control',
    label: '11 — control, a LATE client: expert 09:40–10:45, client 10:05–10:45',
    presence: [
      { party: 'expert', from: '09:40', to: '10:45' },
      { party: 'client', from: '10:05', to: '10:45' },
    ],
    end: '10:45',
    expect: { billable: 45, shape: 'held' },
  },
  {
    kind: 'control',
    label:
      '12 — control, a no-show: the expert waits 09:40–10:20, nobody from the client side ever joins',
    presence: [{ party: 'expert', from: '09:40', to: '10:20' }],
    end: '10:20',
    expect: { billable: 15, shape: 'no_show_client', floorApplied: true },
  },
  {
    kind: 'control',
    label:
      '13 — control, an abandoned wait below the floor: expert 09:40–10:10 (10 from T), no client',
    presence: [{ party: 'expert', from: '09:40', to: '10:10' }],
    end: '10:10',
    expect: { billable: 0, shape: 'abandoned_wait' },
  },
  {
    kind: 'control',
    label:
      '14 — control, an OBSERVER alongside the expert is not "together": observer 09:30–10:30, expert 10:00–10:30',
    presence: [
      { party: 'observer', from: '09:30', to: '10:30' },
      { party: 'expert', from: '10:00', to: '10:30' },
    ],
    end: '10:30',
    expect: { billable: 15, shape: 'no_show_client', floorApplied: true },
  },
];

describe('INVARIANT: before the scheduled start only time together bills; from the start, time counts as before', () => {
  it('has the full table — 10 rows that need Rule A or D15.3, 7 controls that do not', () => {
    expect(ROWS).toHaveLength(17);
    expect(ROWS.filter((row) => row.kind === 'red')).toHaveLength(10);
    expect(ROWS.filter((row) => row.kind === 'control')).toHaveLength(7);
  });

  it.each(ROWS)('$label', (row) => {
    const settlement = settle(row);
    expect(settlement.shape).toBe(row.expect.shape);
    expect(settlement.billableMinutes).toBe(row.expect.billable);
    // One figure drives the charge, the accrual and the tick range.
    expect(settlement.topUpToTickSeq).toBe(settlement.billableMinutes);
    if (row.expect.actual !== undefined) {
      expect(settlement.actualMinutes).toBe(row.expect.actual);
    }
    if (row.expect.floorApplied !== undefined) {
      expect(settlement.floorApplied).toBe(row.expect.floorApplied);
    }
    if (row.expect.uncapped !== undefined) {
      expect(settlement.uncappedRuleMinutes).toBe(row.expect.uncapped);
      expect(settlement.ruleMinutes).toBe(MAX_BILLABLE_MINUTES);
    }
    if (row.drawn !== undefined) {
      // The meter drew ONLY from T: nothing was drawn for the pre-T minutes, so the rule figure is the
      // billed figure and the Q1 no-refund clamp never fires.
      expect(settlement.ruleMinutes).toBe(settlement.billableMinutes);
    }
  });

  it('the oracle itself: 10 + 40 minutes for row 1, 1 for row 2, 4 for row 3, 25 for row 4, 1 for row 5', () => {
    const together = (row: Row): number =>
      oracleTogetherBeforeStartMs(toIntervals(row.presence), clock(row.end)) / MS_PER_MINUTE;
    const [row1, row2, row3, row4, row5] = ROWS;
    expect(
      [row1, row2, row3, row4, row5].map((row) => (row === undefined ? -1 : together(row)))
    ).toEqual([10, 1, 4, 25, 1]);
  });

  describe('an early check-in NEVER ends the booking (the idle anchor stays max(lastLeftAt, T))', () => {
    const presenceFor = (rows: readonly Presence[]) => summarisePresence(toIntervals(rows));

    it('the no-show rule still fires at exactly the floor after the start, and not a minute before', () => {
      const presence = presenceFor([{ party: 'expert', from: '09:40', to: null }]);
      const base = {
        status: 'waiting_for_participants' as const,
        scheduledStart: SCHEDULED_START,
        scheduledEnd: SCHEDULED_END,
        presence,
        timers: DEFAULT_MEETING_TIMERS,
        venueReadyAt: clock('09:00'),
      };
      expect(resolveTerminalRule({ ...base, now: clock('10:14') })).toBeNull();
      expect(resolveTerminalRule({ ...base, now: clock('10:15') })).toMatchObject({
        rule: 'no_show',
      });
    });

    it('an in_progress room that emptied at 09:54 is not ended at 09:59, and idle-ends five minutes after the START', () => {
      const presence = presenceFor([
        { party: 'expert', from: '09:50', to: '09:54' },
        { party: 'client', from: '09:50', to: '09:54' },
      ]);
      const base = {
        status: 'in_progress' as const,
        scheduledStart: SCHEDULED_START,
        scheduledEnd: SCHEDULED_END,
        presence,
        timers: DEFAULT_MEETING_TIMERS,
        venueReadyAt: clock('09:00'),
      };
      expect(resolveTerminalRule({ ...base, now: clock('09:59') })).toBeNull();
      expect(resolveTerminalRule({ ...base, now: clock('10:04') })).toBeNull();
      expect(resolveTerminalRule({ ...base, now: clock('10:05') })).toMatchObject({
        rule: 'idle_end',
      });
    });
  });
});
