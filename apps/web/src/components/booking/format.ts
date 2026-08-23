/**
 * BAL-400 — small, self-contained formatting helpers for the booking flow. Deliberately NOT
 * reaching into `components/availability/availability-day-keys.ts` — that module is internal
 * to the `ExpertAvailabilityCalendar` implementation (only `ExpertAvailabilityCalendar` /
 * `AvailabilitySlotSelection` are the public barrel, D3) — so the booking flow keeps its own
 * tiny, pure formatters rather than reaching past that boundary.
 */

/** "{Weekday, Month Day} at {time}" in the given IANA zone, e.g. "Wed, Aug 26 at 2:00 PM". */
export function formatSlotDateTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  const datePart = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  }).format(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
  return `${datePart} at ${timePart}`;
}

/** Coarse relative-date label for case cards: "today", "3 days ago", "on Aug 12". */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  return `on ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(then)}`;
}

/** "1 consultation" / "3 consultations" — the shared singular/plural pluralization. */
export function pluralizeConsultations(count: number): string {
  return `${count} consultation${count === 1 ? '' : 's'}`;
}
