export interface WeeklyRange {
  /** Wall-clock start, `HH:mm`. */
  startTime: string;
  /** Wall-clock end, `HH:mm`. Earlier than `startTime` when the range crosses midnight. */
  endTime: string;
}

interface WeeklyRuleLike {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** `HH:mm:ss` (a `time` column) and `HH:mm` both normalise to `HH:mm`. */
function toHourMinute(time: string): string {
  return time.slice(0, 5);
}

function compareRanges(a: WeeklyRange, b: WeeklyRange): number {
  if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
  if (a.endTime !== b.endTime) return a.endTime < b.endTime ? -1 : 1;
  return 0;
}

/**
 * The range that best summarises a weekly schedule, for a sentence like "Your 9:00 am – 5:00 pm
 * hours". It is the (start, end) pair worked on the most distinct days, provided that is at
 * least two days; ties go to the earlier start, then the earlier end. When every day differs
 * there is no "usual" range, so it falls back to the earliest-starting one. An empty schedule
 * has none.
 */
export function mostCommonWeeklyRange(rules: readonly WeeklyRuleLike[]): WeeklyRange | null {
  const daysByRange = new Map<string, { range: WeeklyRange; days: Set<number> }>();
  for (const rule of rules) {
    const range: WeeklyRange = {
      startTime: toHourMinute(rule.startTime),
      endTime: toHourMinute(rule.endTime),
    };
    const key = `${range.startTime}-${range.endTime}`;
    const entry = daysByRange.get(key);
    if (entry) {
      entry.days.add(rule.dayOfWeek);
    } else {
      daysByRange.set(key, { range, days: new Set([rule.dayOfWeek]) });
    }
  }

  const entries = [...daysByRange.values()].sort(
    (a, b) => b.days.size - a.days.size || compareRanges(a.range, b.range)
  );
  const [top] = entries;
  if (top === undefined) return null;
  if (top.days.size >= 2) return top.range;

  const earliest = entries.map((e) => e.range).sort(compareRanges)[0];
  return earliest ?? null;
}
