import { describe, expect, it } from 'vitest';
import { DEFAULT_MEETING_TIMERS, type MeetingTimers } from '@balo/shared/meetings';
import {
  AROUND_START_MINUTES,
  VENUE_REPAIR_TICK_MS,
  bucketOf,
  dueVenueRepair,
  venueRepairCandidateStartAfter,
  venueRepairCutoff,
} from './venue-repair-schedule.js';

const MS_PER_MINUTE = 60_000;
/** A fixed epoch, minute-aligned — never `new Date()` (memory: hardcoded-date fixtures). */
const START = new Date('2026-09-01T09:00:00.000Z');

function minutes(n: number): number {
  return n * MS_PER_MINUTE;
}

function at(offsetMinutes: number): Date {
  return new Date(START.getTime() + minutes(offsetMinutes));
}

describe('venueRepairCutoff / venueRepairCandidateStartAfter', () => {
  it('is scheduledStart + missedCallTerminationMs − the 2-minute margin', () => {
    expect(venueRepairCutoff(START, DEFAULT_MEETING_TIMERS)).toEqual(at(8));
  });

  it('candidate window start mirrors the cutoff offset, anchored on now', () => {
    const now = at(0);
    expect(venueRepairCandidateStartAfter(now, DEFAULT_MEETING_TIMERS)).toEqual(
      new Date(now.getTime() - minutes(8))
    );
  });
});

describe('dueVenueRepair — booked 9 minutes before start (the ticket repro)', () => {
  const createdAt = at(-9);

  it.each([
    { label: 'start-8 (start series)', now: at(-8), bucket: bucketOf(at(-8).getTime()) },
    { label: 'start-7 (created+2)', now: at(-7), bucket: bucketOf(at(-7).getTime()) },
    {
      label: 'start-4 (created+5 AND start-4 — one bucket, one result)',
      now: at(-4),
      bucket: bucketOf(at(-4).getTime()),
    },
    { label: 'start-2', now: at(-2), bucket: bucketOf(at(-2).getTime()) },
    { label: 'start', now: at(0), bucket: bucketOf(at(0).getTime()) },
    { label: 'start+2', now: at(2), bucket: bucketOf(at(2).getTime()) },
    { label: 'start+4', now: at(4), bucket: bucketOf(at(4).getTime()) },
  ])('is due at $label, not final', ({ now, bucket }) => {
    const due = dueVenueRepair({
      now,
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(due).toEqual({ checkpointBucket: bucket, final: false });
  });

  it('is due AND FINAL at start+6 (created+15 AND start+6)', () => {
    const due = dueVenueRepair({
      now: at(6),
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(due).toEqual({ checkpointBucket: bucketOf(at(6).getTime()), final: true });
  });

  it('one-tick catch-up: at start+7 it still returns bucket(start+6), final:true — same jobId', () => {
    const due = dueVenueRepair({
      now: at(7),
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(due).toEqual({ checkpointBucket: bucketOf(at(6).getTime()), final: true });
  });

  it('is null at and after the cutoff (start+8)', () => {
    for (const offset of [8, 9, 20]) {
      const due = dueVenueRepair({
        now: at(offset),
        createdAt,
        scheduledStart: START,
        timers: DEFAULT_MEETING_TIMERS,
      });
      expect(due).toBeNull();
    }
  });

  it('drops every checkpoint before createdAt (start-180 … start-15)', () => {
    for (const offset of [-180, -60, -30, -15]) {
      const due = dueVenueRepair({
        now: at(offset),
        createdAt,
        scheduledStart: START,
        timers: DEFAULT_MEETING_TIMERS,
      });
      expect(due).toBeNull();
    }
  });
});

describe('dueVenueRepair — booked 3 weeks out', () => {
  const createdAt = new Date(START.getTime() - 21 * 24 * 60 * MS_PER_MINUTE);
  const timers = DEFAULT_MEETING_TIMERS;

  it('is due at every after-booking checkpoint (created+2m … created+960m)', () => {
    for (const m of [2, 5, 15, 30, 60, 120, 240, 480, 960]) {
      const now = new Date(createdAt.getTime() + minutes(m));
      const due = dueVenueRepair({ now, createdAt, scheduledStart: START, timers });
      expect(due, `not due at created+${m}m`).not.toBeNull();
    }
  });

  it('is due once per day thereafter (created+1d, +2d, …)', () => {
    for (const days of [1, 2, 5, 10]) {
      const now = new Date(createdAt.getTime() + days * 24 * 60 * MS_PER_MINUTE);
      const due = dueVenueRepair({ now, createdAt, scheduledStart: START, timers });
      expect(due, `not due at created+${days}d`).not.toBeNull();
    }
  });

  it('is due at every start-anchored checkpoint (start-180 … start+6)', () => {
    for (const m of AROUND_START_MINUTES) {
      const now = at(m);
      const due = dueVenueRepair({ now, createdAt, scheduledStart: START, timers });
      expect(due, `not due at start${m >= 0 ? '+' : ''}${m}m`).not.toBeNull();
    }
  });

  it('final only for bucket(start+6)', () => {
    const due = dueVenueRepair({ now: at(6), createdAt, scheduledStart: START, timers });
    expect(due).toMatchObject({ final: true });

    const notFinal = dueVenueRepair({ now: at(4), createdAt, scheduledStart: START, timers });
    expect(notFinal).toMatchObject({ final: false });
  });

  it('is NOT due two or more buckets after any checkpoint', () => {
    // Two buckets after `start` (a real checkpoint) with nothing due at start+1 or start+2's
    // neighbourhood collapsed by the one-tick rule: pick an instant strictly between two
    // finite checkpoints with a >1 tick gap, e.g. start+45 (between start+6 and the next daily
    // checkpoint, which is a day away).
    const due = dueVenueRepair({ now: at(45), createdAt, scheduledStart: START, timers });
    expect(due).toBeNull();
  });
});

describe('dueVenueRepair — one-tick catch-up, general property', () => {
  it('due at bucket(c) and bucket(c)+1 for an isolated checkpoint, not bucket(c)+2', () => {
    // `createdAt` is far enough before `start-180` that no after-booking or daily checkpoint
    // lands anywhere near the window under test — isolating the property to ONE checkpoint,
    // `start-60` (whose neighbours in AROUND_START_MINUTES are 30+ minutes away).
    const createdAt = at(-2000);
    const c = at(-60);
    const cBucket = bucketOf(c.getTime());

    const dueAtC = dueVenueRepair({
      now: c,
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(dueAtC).toEqual({ checkpointBucket: cBucket, final: false });

    const oneTickLater = new Date(c.getTime() + VENUE_REPAIR_TICK_MS);
    const dueOneTickLater = dueVenueRepair({
      now: oneTickLater,
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(dueOneTickLater).toEqual({ checkpointBucket: cBucket, final: false });

    const twoTicksLater = new Date(c.getTime() + 2 * VENUE_REPAIR_TICK_MS);
    const dueTwoTicksLater = dueVenueRepair({
      now: twoTicksLater,
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(dueTwoTicksLater).toBeNull();
  });
});

describe('dueVenueRepair — reschedule re-derives the start series', () => {
  it('a meeting rescheduled after its start-15 checkpoint has passed is due at the NEW start-15', () => {
    const createdAt = at(-200);
    // Five ticks past the ORIGINAL start-15 — outside even the one-tick catch-up window, and
    // not near any other original checkpoint (the next is start-8).
    const now = at(-10);
    const dueAgainstOriginal = dueVenueRepair({
      now,
      createdAt,
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(dueAgainstOriginal).toBeNull();

    // Reschedule: the new start is 15 minutes after `now`, so `now` is now EXACTLY the new
    // start-15 — the start series is re-derived from the CURRENT scheduledStart, for free.
    const newStart = new Date(now.getTime() + minutes(15));
    const dueAgainstNew = dueVenueRepair({
      now,
      createdAt,
      scheduledStart: newStart,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(dueAgainstNew).not.toBeNull();
    expect(dueAgainstNew?.checkpointBucket).toBe(bucketOf(now.getTime()));
  });
});

describe('dueVenueRepair — two series colliding in one bucket yields one due result', () => {
  it('created+15 and start+6 coincide (booked 9 minutes before start)', () => {
    const due = dueVenueRepair({
      now: at(6),
      createdAt: at(-9),
      scheduledStart: START,
      timers: DEFAULT_MEETING_TIMERS,
    });
    expect(due).not.toBeNull();
    expect(due?.checkpointBucket).toBe(bucketOf(at(6).getTime()));
  });
});

describe('dueVenueRepair — a shortened missedCallTerminationMs shrinks the cutoff', () => {
  const shortTimers: MeetingTimers = {
    ...DEFAULT_MEETING_TIMERS,
    missedCallTerminationMs: minutes(5),
  };
  const createdAt = at(-9);

  it('drops start+4 / start+6 and moves final to start+2', () => {
    expect(venueRepairCutoff(START, shortTimers)).toEqual(at(3));

    for (const offset of [4, 6]) {
      const due = dueVenueRepair({
        now: at(offset),
        createdAt,
        scheduledStart: START,
        timers: shortTimers,
      });
      expect(due, `start+${offset} should be past the shortened cutoff`).toBeNull();
    }

    const dueAtFinal = dueVenueRepair({
      now: at(2),
      createdAt,
      scheduledStart: START,
      timers: shortTimers,
    });
    expect(dueAtFinal).toEqual({ checkpointBucket: bucketOf(at(2).getTime()), final: true });
  });

  it('refuses to fire AT the cutoff even though the final checkpoint (start+2) sits inside the one-tick catch-up window', () => {
    // ⚠ MUTATION-PROOF TARGET for the `now >= cutoff` early return: at `now === cutoff`
    // exactly, `catchUpBucket` is bucket(start+2) — the FINAL checkpoint — which genuinely
    // exists. Without the early return, the catch-up mechanism would fire it AT the cutoff,
    // racing the sweep's `venue_unavailable` end. The guard must win regardless.
    const due = dueVenueRepair({
      now: venueRepairCutoff(START, shortTimers),
      createdAt,
      scheduledStart: START,
      timers: shortTimers,
    });
    expect(due).toBeNull();
  });
});

describe('dueVenueRepair — booked after the start', () => {
  it('no checkpoint at or before createdAt; the cutoff is still respected', () => {
    const createdAt = at(1);

    // Nothing due at createdAt itself (checkpoints require strictly > createdAt).
    expect(
      dueVenueRepair({
        now: createdAt,
        createdAt,
        scheduledStart: START,
        timers: DEFAULT_MEETING_TIMERS,
      })
    ).toBeNull();

    // But start+2 (> createdAt, < cutoff start+8) is still due.
    expect(
      dueVenueRepair({
        now: at(2),
        createdAt,
        scheduledStart: START,
        timers: DEFAULT_MEETING_TIMERS,
      })
    ).toEqual({ checkpointBucket: bucketOf(at(2).getTime()), final: false });

    // And the cutoff still applies.
    expect(
      dueVenueRepair({
        now: at(8),
        createdAt,
        scheduledStart: START,
        timers: DEFAULT_MEETING_TIMERS,
      })
    ).toBeNull();
  });
});
