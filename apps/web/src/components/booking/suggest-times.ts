import type { AvailabilitySlotDto } from '@balo/shared/availability';

/** Up to four suggestions — the first view of both reschedule pickers. */
const SUGGESTION_COUNT = 4;

/** The BROWSER-LOCAL calendar day `iso` falls on, as a comparable/sortable number — exported so
 *  `ProposeTimesDialog` can filter a day already in its own `picked` list out of the candidate
 *  pool before this function ever sees it (see that dialog's own docblock). */
export function localDayKey(iso: string): number {
  const date = new Date(iso);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localMinutesOfDay(iso: string): number {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * ONE PER DAY, the slot nearest the ORIGINAL time of day, for the earliest four days that have
 * one. NOT "the first N": on a 15-minute grid, the first three
 * available slots are as likely to be 9:00, 9:15 and 9:30 pm on the SAME evening as they are to
 * be three different days — three ways of saying the same evening. Grouping by day first and
 * keeping only the closest-to-original candidate from each is the whole rule.
 *
 * Grouping and the time-of-day gap both use the BROWSER-LOCAL calendar day (plain `Date`
 * getters, no IANA zone threaded through). That is safe here specifically because every caller
 * mounts this inside a dialog that only ever opens from a click, never during SSR — unlike
 * `LocalDateTime` and `availability-day-keys.ts`, there is no server/client render to keep in
 * sync.
 *
 * Pure and synchronous: `slots` is whatever the caller already fetched and pre-filtered to a
 * long-enough `maxDuration`; this never fetches or filters by length itself.
 */
export function suggestTimes(
  slots: readonly AvailabilitySlotDto[],
  originalStartIso: string
): AvailabilitySlotDto[] {
  const originalDay = localDayKey(originalStartIso);
  const originalMinutes = localMinutesOfDay(originalStartIso);
  const bestByDay = new Map<number, AvailabilitySlotDto>();

  for (const slot of slots) {
    const day = localDayKey(slot.start);
    const minutes = localMinutesOfDay(slot.start);
    if (day === originalDay && minutes === originalMinutes) continue;

    const current = bestByDay.get(day);
    const gap = Math.abs(minutes - originalMinutes);
    if (!current || gap < Math.abs(localMinutesOfDay(current.start) - originalMinutes)) {
      bestByDay.set(day, slot);
    }
  }

  return [...bestByDay.entries()]
    .sort(([dayA], [dayB]) => dayA - dayB)
    .slice(0, SUGGESTION_COUNT)
    .map(([, slot]) => slot);
}
