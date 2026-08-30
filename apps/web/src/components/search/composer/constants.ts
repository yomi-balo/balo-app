import { TIMEFRAME_VALUES, type TimeframeValue } from '@/lib/search/filters';
import type { PillOption } from './pill-row';

/** UI-only sentinel for the "no timeframe" pill — maps to `timeframe: null`. */
export const ANY_TIMEFRAME = 'any';

const TIMEFRAME_LABELS: Record<TimeframeValue, string> = {
  today: 'Today',
  '3days': 'Within 3 days',
  week: 'This week',
};

/** Timeframe pills, leading with the "Any time" sentinel. */
export const TIMEFRAME_OPTIONS: ReadonlyArray<PillOption> = [
  { value: ANY_TIMEFRAME, label: 'Any time' },
  ...TIMEFRAME_VALUES.map((tf) => ({ value: tf, label: TIMEFRAME_LABELS[tf] })),
];

/**
 * A$ per-minute bounds for the rate slider. Full span ⇒ "no rate filter".
 *
 * ⚠ **CLIENT-FACING DOLLARS, RAISED FROM 12 TO 15 BY BAL-493's D1.** Before D1 the slider's
 * numbers were the expert's raw rate, so `max: 12` reached an A$12/min expert. D1 made every
 * public surface display the fee-inclusive client rate, and `filtersToSearchRequest` now
 * divides that fee back out before it becomes the API bound — so a `max` of 12 would top out
 * at an expert rate of A$9.60/min and the most expensive experts would be unreachable at full
 * slider extension. 15 restores the previous expert-rate ceiling (A$12 expert × 1.25 = A$15
 * client). Raise both together if the ceiling ever moves again.
 */
export const RATE_BOUNDS = { min: 0, max: 15 } as const;

/** Dense-group cap: groups with more items collapse to one row + "+N more". */
export const DENSE_CAP = 4;
