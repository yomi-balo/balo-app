import { formatInTimeZone } from 'date-fns-tz';

/**
 * "Today" / "tomorrow" for a forward-looking instant, resolved in a named time zone.
 *
 * ⚠ Not elapsed time. `LocalDateTime` rules that a record never says "2 hours ago" — phrasing
 * that decays and hides the instant. A day word does neither: the exact clock time is still
 * named, only the calendar date is replaced. For appointments only; the record keeps its date,
 * which is also why there is no "yesterday".
 *
 * ⚠ Calendar days in the viewer's zone, not a 24-hour window: 11:40 pm tonight is "today" and
 * 12:20 am is "tomorrow" though the second is nearer. Hence day keys, not instant subtraction.
 */
export type RelativeDay = 'today' | 'tomorrow' | null;

/** `yyyy-MM-dd` for an instant, as that calendar day reads in `timeZone`. */
function dayKeyIn(instant: Date, timeZone: string): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd');
}

/**
 * The calendar day after `key`.
 *
 * ⚠ Key arithmetic, not `+ 24 hours`: adding a day of milliseconds lands on the wrong date
 * twice a year — a 23-hour spring-forward day can leave you inside the same date, a 25-hour
 * autumn day can skip one.
 */
function nextDayKey(key: string): string {
  const [year, month, day] = key.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`nextDayKey: invalid day key "${key}"`);
  }
  const walker = new Date(Date.UTC(year, month - 1, day));
  walker.setUTCDate(walker.getUTCDate() + 1);
  return walker.toISOString().slice(0, 10);
}

/**
 * `'today'` or `'tomorrow'` when `iso` falls on one of those calendar days in `timeZone`,
 * otherwise `null`. `now` is a parameter so the caller controls when it is read — the component
 * reads it only after mount, which keeps server and client renders identical.
 */
export function relativeDay(iso: string, timeZone: string, now: Date): RelativeDay {
  const target = dayKeyIn(new Date(iso), timeZone);
  const today = dayKeyIn(now, timeZone);
  if (target === today) return 'today';
  if (target === nextDayKey(today)) return 'tomorrow';
  return null;
}
