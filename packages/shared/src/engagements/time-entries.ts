/**
 * Time-and-materials time-entry helpers: billing periods, estimate crossing and hour labels.
 * Pure and client-safe. Time is stored and passed as whole minutes; hours appear only in labels.
 */

import { localIsoDate } from '../timezone';

/** A calendar date, 'YYYY-MM-DD'. */
export type IsoDate = string;

/** A billing window. `endOn` is exclusive and is also the next invoice date. */
export interface BillingPeriod {
  startOn: IsoDate;
  endOn: IsoDate;
  nextInvoiceOn: IsoDate;
}

/** Entries are logged in quarter-hour steps. */
export const TIME_ENTRY_MINUTES_STEP = 15;
/** One entry covers at most a day. */
export const TIME_ENTRY_MAX_MINUTES = 1440;
export const TIME_ENTRY_NOTE_MAX = 1000;

const MS_PER_DAY = 86_400_000;
const FORTNIGHT_DAYS = 14;

function toIsoDate(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Midnight UTC of the calendar day `date` falls on in `timeZone` (UTC when null). */
function dayStartIn(date: Date, timeZone: string | null): number {
  return Date.parse(localIsoDate(date, timeZone));
}

/** The start of the monthly period `monthOffset` months after the anchor, clamped to the month length. */
function monthlyStart(anchorMs: number, monthOffset: number): number {
  const anchor = new Date(anchorMs);
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + monthOffset;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay));
}

/**
 * The billing period containing `now`, anchored on the activation date. Both days are read in
 * `timeZone` (UTC when null), the same calendar time entries are dated in. Monthly periods
 * start on the anchor's day-of-month, clamped to short months without drifting the anchor;
 * fortnightly periods are 14-day blocks. Before activation the first period is returned.
 * Null when the project has no activation date or no cadence.
 */
export function currentBillingPeriod(
  activatedAt: Date | null,
  cadence: 'monthly' | 'fortnightly' | null,
  now: Date,
  timeZone: string | null = null
): BillingPeriod | null {
  if (activatedAt === null || cadence === null) return null;
  const anchorMs = dayStartIn(activatedAt, timeZone);
  const todayMs = Math.max(dayStartIn(now, timeZone), anchorMs);

  let startMs: number;
  let endMs: number;
  if (cadence === 'fortnightly') {
    const blocks = Math.floor((todayMs - anchorMs) / (FORTNIGHT_DAYS * MS_PER_DAY));
    startMs = anchorMs + blocks * FORTNIGHT_DAYS * MS_PER_DAY;
    endMs = startMs + FORTNIGHT_DAYS * MS_PER_DAY;
  } else {
    const anchor = new Date(anchorMs);
    const monthsApart =
      (new Date(todayMs).getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (new Date(todayMs).getUTCMonth() - anchor.getUTCMonth());
    let k = monthsApart;
    if (monthlyStart(anchorMs, k) > todayMs) k -= 1;
    startMs = monthlyStart(anchorMs, k);
    endMs = monthlyStart(anchorMs, k + 1);
  }

  const endOn = toIsoDate(endMs);
  return { startOn: toIsoDate(startMs), endOn, nextInvoiceOn: endOn };
}

/**
 * Whether a write moves a milestone's logged time from within its estimate to beyond it.
 * An estimate of 0 is real, so the first entry crosses it; a null estimate never crosses.
 */
export function estimateCrossed(
  beforeMinutes: number,
  afterMinutes: number,
  estimatedMinutes: number | null
): boolean {
  return (
    estimatedMinutes !== null &&
    beforeMinutes <= estimatedMinutes &&
    estimatedMinutes < afterMinutes
  );
}

/** Logged time as a whole percentage of the estimate; null when there is no estimate to divide by. */
export function percentOfEstimate(
  loggedMinutes: number,
  estimatedMinutes: number | null
): number | null {
  if (estimatedMinutes === null || estimatedMinutes === 0) return null;
  return Math.round((loggedMinutes / estimatedMinutes) * 100);
}

/** The value of logged time at the project rate, in cents, rounded up. Zero without a rate. */
export function loggedValueCents(loggedMinutes: number, rateCents: number | null): number {
  if (rateCents === null) return 0;
  return Math.ceil((loggedMinutes * rateCents) / 60);
}

/** Minutes as a label such as "1 hr" or "1.5 hrs" (two decimals at most). */
export function hoursLabel(minutes: number): string {
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours} ${hours === 1 ? 'hr' : 'hrs'}`;
}
