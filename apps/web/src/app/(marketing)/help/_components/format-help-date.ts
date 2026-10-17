const HELP_DATE_FORMAT = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `2026-10-17` to `17 October 2026`, in UTC so the day never shifts with the reader's zone. */
export function formatHelpDate(iso: string): string {
  return HELP_DATE_FORMAT.format(new Date(`${iso}T00:00:00Z`));
}
