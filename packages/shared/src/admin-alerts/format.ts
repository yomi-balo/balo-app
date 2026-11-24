/**
 * `en-GB`, UTC — e.g. `12 Jul 2027, 14:30 UTC`. Date AND time, because a same-day start or due
 * time matters to whoever reads an admin alert. Presentation only; never touches money math.
 */
export function formatDateTimeShortUtc(date: Date): string {
  return (
    date.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hour12: false,
    }) + ' UTC'
  );
}
