/**
 * The Calendars card's iCloud line. Apple calendars are not a supported provider (Google and
 * Microsoft only), so this says so plainly and points at what still works — the weekly hours —
 * without promising a date. No hooks or handlers, so it stays a server component even though
 * it only ever renders inside the client tree.
 */
export function CalendarAppleNote(): React.JSX.Element {
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      On iCloud? Apple calendars can&apos;t be connected yet — your weekly hours still work on their
      own, and clients can book you as normal.
    </p>
  );
}
