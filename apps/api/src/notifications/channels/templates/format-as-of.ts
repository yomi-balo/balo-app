const AS_OF_TIME = new Intl.DateTimeFormat('en-GB', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'UTC',
});

const AS_OF_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * ISO instant → the date-and-time label that dates a money figure in a notice, e.g.
 * `'2026-09-23T14:05:00.000Z'` → `'2:05 pm UTC, 23 September 2026'`. Time first, then the long
 * date, always UTC (the label says so), with a lower-case `am` / `pm`.
 *
 * A figure in a notice can be read hours after it was sent, so every figure is stated "as of"
 * the instant it was read. An unparseable input degrades to `'the time of this notice'` rather
 * than rendering `Invalid Date`, so the sentence around it still reads.
 */
export function formatAsOfUtc(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return 'the time of this notice';
  }
  const time = AS_OF_TIME.format(instant).toLowerCase();
  return `${time} UTC, ${AS_OF_DATE.format(instant)}`;
}
