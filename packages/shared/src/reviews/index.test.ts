import { describe, it, expect } from 'vitest';
import {
  LOW_RATING_THRESHOLD,
  RATING_LABELS,
  RATING_MAX,
  RATING_MIN,
  REVIEW_BODY_MAX,
  REVIEW_NUDGE_STEPS,
  REVIEW_NUDGE_WINDOW_MS,
  REVIEW_TOKEN_TTL_DAYS,
  isRating,
  parsePrefillRating,
  quantiseNudgeTick,
  resolveEndOfCallReviewState,
  reviewNudgeBands,
  type Rating,
  type ReviewNudgeBand,
  type ReviewNudgeStep,
} from './index';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const hours = (n: number): number => n * HOUR_MS;

/** Which steps' bands contain an anchor of the given age at `NOW`. */
function matchedSteps(ageMs: number, now: Date = NOW): ReviewNudgeStep[] {
  const anchor = new Date(now.getTime() - ageMs);
  return reviewNudgeBands(now)
    .filter(
      (band) => anchor.getTime() > band.after.getTime() && anchor.getTime() <= band.until.getTime()
    )
    .map((band) => band.step);
}

describe('constants (D2 — typed consts, NOT platform config)', () => {
  it('pins the rating range and the low-rating boundary', () => {
    expect(RATING_MIN).toBe(1);
    expect(RATING_MAX).toBe(5);
    expect(LOW_RATING_THRESHOLD).toBe(4);
  });

  it('pins the body cap and the token TTL (D8 — 30 days, comfortably past the +7d nudge)', () => {
    expect(REVIEW_BODY_MAX).toBe(2000);
    expect(REVIEW_TOKEN_TTL_DAYS).toBe(30);
    // The step-2 nudge fires at +7d; the token must still be live well past it.
    expect(REVIEW_TOKEN_TTL_DAYS * 24 * HOUR_MS).toBeGreaterThan(REVIEW_NUDGE_STEPS[1].ageMs);
  });

  it('labels every rating in the range, with no blanks', () => {
    const ratings: Rating[] = [1, 2, 3, 4, 5];
    expect(Object.keys(RATING_LABELS).map(Number).sort()).toEqual(ratings);
    for (const rating of ratings) {
      expect(RATING_LABELS[rating].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('parsePrefillRating', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
  ])('parses %s → %i', (raw, expected) => {
    expect(parsePrefillRating(raw)).toBe(expected);
  });

  it.each([
    ['0'],
    ['6'],
    ['9'],
    ['3.5'],
    [''],
    ['abc'],
    ['<script>'],
    ['1e0'],
    ['01'],
    [' 1'],
    ['1 '],
    ['+1'],
    ['-1'],
    ['constructor'],
    ['__proto__'],
    ['toString'],
  ])('rejects %j → null (a genuine empty state, never an error)', (raw) => {
    expect(parsePrefillRating(raw)).toBeNull();
  });

  it('rejects undefined (no `?r=` on the link at all)', () => {
    expect(parsePrefillRating(undefined)).toBeNull();
  });
});

describe('isRating', () => {
  it.each([1, 2, 3, 4, 5])('accepts %s', (value) => {
    expect(isRating(value)).toBe(true);
  });

  it.each([0, 6, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(isRating(value)).toBe(false);
  });

  it('is anchored to the range constants, not to five hard-coded literals', () => {
    expect(isRating(RATING_MIN)).toBe(true);
    expect(isRating(RATING_MAX)).toBe(true);
    expect(isRating(RATING_MIN - 1)).toBe(false);
    expect(isRating(RATING_MAX + 1)).toBe(false);
  });
});

describe('resolveEndOfCallReviewState (D3)', () => {
  it('returns `none` when nothing has been rated yet', () => {
    expect(resolveEndOfCallReviewState(null)).toEqual({ kind: 'none' });
  });

  it.each([1, 2, 3])('treats %i as rated_low against the default threshold', (rating) => {
    expect(resolveEndOfCallReviewState(rating)).toEqual({ kind: 'rated_low', rating });
  });

  it.each([4, 5])('treats %i as rated_ok against the default threshold', (rating) => {
    expect(resolveEndOfCallReviewState(rating)).toEqual({ kind: 'rated_ok', rating });
  });

  it('puts the boundary AT the threshold on the ok side', () => {
    expect(resolveEndOfCallReviewState(LOW_RATING_THRESHOLD)).toEqual({
      kind: 'rated_ok',
      rating: LOW_RATING_THRESHOLD,
    });
    expect(resolveEndOfCallReviewState(LOW_RATING_THRESHOLD - 1)).toEqual({
      kind: 'rated_low',
      rating: LOW_RATING_THRESHOLD - 1,
    });
  });

  it('shifts the boundary with an explicit threshold', () => {
    expect(resolveEndOfCallReviewState(3, 3)).toEqual({ kind: 'rated_ok', rating: 3 });
    expect(resolveEndOfCallReviewState(2, 3)).toEqual({ kind: 'rated_low', rating: 2 });
  });

  it('still returns `none` for null under an explicit threshold', () => {
    expect(resolveEndOfCallReviewState(null, 2)).toEqual({ kind: 'none' });
  });
});

describe('reviewNudgeBands', () => {
  it('produces exactly the two documented bands', () => {
    const bands = reviewNudgeBands(NOW);
    expect(bands).toHaveLength(2);
    expect(bands.map((b) => b.step)).toEqual([1, 2]);

    const [stepOne, stepTwo] = bands;
    if (stepOne === undefined || stepTwo === undefined) {
      throw new Error('reviewNudgeBands must return two bands');
    }

    // (now − 25h, now − 24h]
    expect(stepOne.until.toISOString()).toBe(new Date(NOW.getTime() - hours(24)).toISOString());
    expect(stepOne.after.toISOString()).toBe(new Date(NOW.getTime() - hours(25)).toISOString());
    // (now − 169h, now − 168h]
    expect(stepTwo.until.toISOString()).toBe(new Date(NOW.getTime() - hours(168)).toISOString());
    expect(stepTwo.after.toISOString()).toBe(new Date(NOW.getTime() - hours(169)).toISOString());
  });

  it('makes EVERY band exactly one window wide (the band-width == cron-period invariant)', () => {
    for (const band of reviewNudgeBands(NOW)) {
      expect(band.until.getTime() - band.after.getTime()).toBe(REVIEW_NUDGE_WINDOW_MS);
    }
    expect(REVIEW_NUDGE_WINDOW_MS).toBe(HOUR_MS);
  });

  it('never overlaps the two bands', () => {
    const [stepOne, stepTwo] = reviewNudgeBands(NOW);
    if (stepOne === undefined || stepTwo === undefined) {
      throw new Error('reviewNudgeBands must return two bands');
    }
    // Step 2 is strictly older than step 1.
    expect(stepTwo.until.getTime()).toBeLessThan(stepOne.after.getTime());
  });

  it('honours an explicit window width', () => {
    const [stepOne] = reviewNudgeBands(NOW, 2 * HOUR_MS);
    if (stepOne === undefined) {
      throw new Error('reviewNudgeBands must return two bands');
    }
    expect(stepOne.until.getTime() - stepOne.after.getTime()).toBe(2 * HOUR_MS);
  });

  it('shifts with `now` — it reads no clock of its own', () => {
    const later = new Date(NOW.getTime() + hours(5));
    const [base] = reviewNudgeBands(NOW);
    const [shifted] = reviewNudgeBands(later);
    if (base === undefined || shifted === undefined) {
      throw new Error('reviewNudgeBands must return two bands');
    }
    expect(shifted.until.getTime() - base.until.getTime()).toBe(hours(5));
  });
});

describe('quantiseNudgeTick — the ticks themselves must land one window apart', () => {
  it('floors a late tick down to the start of its hour', () => {
    expect(quantiseNudgeTick(new Date('2026-08-05T13:04:37.913Z')).toISOString()).toBe(
      '2026-08-05T13:00:00.000Z'
    );
    expect(quantiseNudgeTick(new Date('2026-08-05T13:59:59.999Z')).toISOString()).toBe(
      '2026-08-05T13:00:00.000Z'
    );
  });

  it('leaves an already-punctual tick untouched (a fixed point on the grid)', () => {
    const punctual = new Date('2026-08-05T14:00:00.000Z');
    expect(quantiseNudgeTick(punctual).toISOString()).toBe(punctual.toISOString());
    expect(quantiseNudgeTick(quantiseNudgeTick(punctual)).toISOString()).toBe(
      punctual.toISOString()
    );
  });

  it('honours an explicit window width', () => {
    expect(quantiseNudgeTick(new Date('2026-08-05T13:04:00.000Z'), 2 * HOUR_MS).toISOString()).toBe(
      '2026-08-05T12:00:00.000Z'
    );
  });

  /**
   * ⚠ THE CONTROL — this is the bug the quantiser exists for, asserted directly so nobody
   * "simplifies" `runReviewNudgeSweep` back to a raw `new Date()`. BullMQ fires late under
   * load; a 13:04 tick and the next on-time 14:00 tick produce step-1 bands that OVERLAP
   * over four minutes, and an anchor in that sliver is nudged twice (two magic-link tokens
   * minted, two `review_nudge_sent` events).
   */
  it('a RAW late tick and the next on-time tick overlap — and quantised they do not', () => {
    const late = new Date('2026-08-05T13:04:00.000Z');
    const onTime = new Date('2026-08-05T14:00:00.000Z');
    /** An anchor sitting inside the raw overlap: 24h + 2min before the on-time tick. */
    const anchor = new Date('2026-08-04T13:02:00.000Z');

    const stepOneMatches = (tick: Date): boolean => {
      const [band] = reviewNudgeBands(tick);
      if (band === undefined) throw new Error('reviewNudgeBands must return two bands');
      return anchor.getTime() > band.after.getTime() && anchor.getTime() <= band.until.getTime();
    };

    // Raw clock: BOTH ticks match the same anchor.
    expect(stepOneMatches(late)).toBe(true);
    expect(stepOneMatches(onTime)).toBe(true);

    // Quantised: exactly one does.
    expect(stepOneMatches(quantiseNudgeTick(late))).toBe(false);
    expect(stepOneMatches(quantiseNudgeTick(onTime))).toBe(true);
  });

  it('makes consecutive quantised ticks abut exactly — no overlap, per step', () => {
    const late = quantiseNudgeTick(new Date('2026-08-05T13:04:00.000Z'));
    const next = quantiseNudgeTick(new Date('2026-08-05T14:00:00.000Z'));

    const first = reviewNudgeBands(late);
    const second = reviewNudgeBands(next);
    expect(first).toHaveLength(2);

    for (const [index, band] of first.entries()) {
      const follower = second[index];
      if (follower === undefined) throw new Error('band count mismatch');
      expect(follower.step).toBe(band.step);
      // The earlier band's inclusive top IS the later band's exclusive floor: abutting,
      // not overlapping, and with nothing skipped between them.
      expect(follower.after.getTime()).toBe(band.until.getTime());
    }
  });
});

describe('the age table — which anchor ages match which step', () => {
  const table: Array<{ name: string; ageMs: number; expected: ReviewNudgeStep[] }> = [
    { name: '23h — too young for step 1', ageMs: hours(23), expected: [] },
    { name: '24h — exactly the step-1 inclusive edge', ageMs: hours(24), expected: [1] },
    { name: '24h + 1ms — inside step 1', ageMs: hours(24) + 1, expected: [1] },
    { name: '24h59m — still inside step 1', ageMs: hours(24) + 59 * 60_000, expected: [1] },
    {
      name: '25h — exactly the step-1 exclusive edge, so NOT matched',
      ageMs: hours(25),
      expected: [],
    },
    { name: '26h — past step 1, before step 2', ageMs: hours(26), expected: [] },
    { name: '100h — the dead zone between the steps', ageMs: hours(100), expected: [] },
    { name: '167h — one hour short of step 2', ageMs: hours(167), expected: [] },
    { name: '168h — exactly the step-2 inclusive edge', ageMs: hours(168), expected: [2] },
    { name: '168h30m — inside step 2', ageMs: hours(168) + 30 * 60_000, expected: [2] },
    {
      name: '169h — exactly the step-2 exclusive edge, so NOT matched',
      ageMs: hours(169),
      expected: [],
    },
    { name: '200h — past every band, forever', ageMs: hours(200), expected: [] },
    { name: '30d — past every band, forever', ageMs: hours(24 * 30), expected: [] },
    { name: '365d — past every band, forever', ageMs: hours(24 * 365), expected: [] },
  ];

  it.each(table)('$name', ({ ageMs, expected }) => {
    expect(matchedSteps(ageMs)).toEqual(expected);
  });

  it('matches NOTHING for any age beyond the step-2 band — the hard stop is window math', () => {
    for (let age = hours(169); age <= hours(24 * 60); age += hours(7)) {
      expect(matchedSteps(age)).toEqual([]);
    }
  });
});

describe('the 30-day hourly iteration — the definitive "no third nudge" proof', () => {
  it('matches a fixed anchor on exactly one tick per step, and never again', () => {
    const anchor = new Date('2026-08-05T09:17:23.000Z');
    const hits = new Map<ReviewNudgeStep, number>([
      [1, 0],
      [2, 0],
    ]);

    // 30 days of hourly ticks, starting one hour after the anchor.
    const TICKS = 30 * 24;
    for (let tick = 1; tick <= TICKS; tick++) {
      const now = new Date(anchor.getTime() + tick * HOUR_MS);
      for (const band of reviewNudgeBands(now)) {
        const inBand =
          anchor.getTime() > band.after.getTime() && anchor.getTime() <= band.until.getTime();
        if (inBand) {
          hits.set(band.step, (hits.get(band.step) ?? 0) + 1);
        }
      }
    }

    expect(hits.get(1)).toBe(1);
    expect(hits.get(2)).toBe(1);
  });

  it('leaves no gap — every anchor age in a 30-day span is covered at most once in total', () => {
    // Sweep the anchor across a full hour at minute resolution against a fixed tick
    // grid: each anchor is picked up by step 1 exactly once and step 2 exactly once,
    // so the half-open bands neither double-send nor drop.
    const gridOrigin = new Date('2026-08-05T00:00:00.000Z');
    for (let offsetMin = 0; offsetMin < 60; offsetMin++) {
      const anchor = new Date(gridOrigin.getTime() + offsetMin * 60_000);
      const totals = new Map<ReviewNudgeStep, number>([
        [1, 0],
        [2, 0],
      ]);

      for (let tick = 1; tick <= 30 * 24; tick++) {
        const now = new Date(gridOrigin.getTime() + tick * HOUR_MS);
        for (const band of reviewNudgeBands(now)) {
          if (anchor.getTime() > band.after.getTime() && anchor.getTime() <= band.until.getTime()) {
            totals.set(band.step, (totals.get(band.step) ?? 0) + 1);
          }
        }
      }

      expect(totals.get(1)).toBe(1);
      expect(totals.get(2)).toBe(1);
    }
  });
});

describe('REVIEW_NUDGE_STEPS', () => {
  it('is exactly two steps at +24h and +7d, in ascending age order', () => {
    expect(REVIEW_NUDGE_STEPS).toHaveLength(2);
    const [first, second] = REVIEW_NUDGE_STEPS;
    expect(first.step).toBe(1);
    expect(first.ageMs).toBe(hours(24));
    expect(second.step).toBe(2);
    expect(second.ageMs).toBe(hours(24 * 7));
    expect(second.ageMs).toBeGreaterThan(first.ageMs);
  });

  it('spaces the two steps further apart than one window, so they can never both fire', () => {
    const [first, second] = REVIEW_NUDGE_STEPS;
    expect(second.ageMs - first.ageMs).toBeGreaterThan(REVIEW_NUDGE_WINDOW_MS);
  });

  it('produces one band per declared step', () => {
    const bands: ReviewNudgeBand[] = reviewNudgeBands(NOW);
    expect(bands.map((b) => b.step)).toEqual(REVIEW_NUDGE_STEPS.map((s) => s.step));
  });
});
