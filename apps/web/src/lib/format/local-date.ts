/**
 * local-date — pure, client-safe short-date formatters. Two flavours of the same
 * "12 Jun" label:
 *
 *   · `formatLocalShortDate` reads the date in the caller's LOCAL timezone (the
 *     viewer's browser zone when run client-side) — the label a distributed team
 *     across timezones should each see in their own frame.
 *   · `formatUtcShortDate` reads it in UTC — a stable value that is identical on the
 *     server and on the client's FIRST render, so the `<LocalDate>` component can
 *     paint it during SSR/hydration and swap to the local value after mount without
 *     a hydration mismatch.
 *
 * The month abbreviation is hand-rolled (not `Intl`) so it never drifts by shell
 * locale (`en-AU`'s `month: 'short'` renders June as "June", not "Jun").
 */

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "12 Jun" in the caller's LOCAL timezone (the browser zone client-side). */
export function formatLocalShortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()] ?? ''}`;
}

/** "12 Jun" in UTC — the stable SSR / first-client-render fallback. */
export function formatUtcShortDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()] ?? ''}`;
}

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * "13 August 2026" in UTC — the helpful-fact expiry label for shared proposal
 * links (BAL-386). Hand-rolled (not `Intl`) so it never drifts by shell locale,
 * and read in UTC so the server-formatted email value and the SSR-rendered footer
 * agree regardless of the viewer's timezone. Accepts a `Date` or an ISO string.
 */
export function formatUtcLongDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getUTCDate()} ${LONG_MONTHS[date.getUTCMonth()] ?? ''} ${date.getUTCFullYear()}`;
}
