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

/** A$ per-minute bounds for the rate slider. Full span ⇒ "no rate filter". */
export const RATE_BOUNDS = { min: 0, max: 12 } as const;

/** Dense-group cap: groups with more items collapse to one row + "+N more". */
export const DENSE_CAP = 4;
