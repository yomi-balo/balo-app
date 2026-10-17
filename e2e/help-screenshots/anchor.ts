const MS_PER_DAY = 86_400_000;
const MONDAY = 1;

/**
 * The next Monday strictly after `now`'s UTC date, as `YYYY-MM-DD`. The single source for both the
 * seed's `--anchor` argument and the frozen browser clock, so dated fixture rows and the clock
 * always agree.
 */
export function helpAnchor(now: Date = new Date()): string {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysUntilMonday = (MONDAY - new Date(midnight).getUTCDay() + 7) % 7 || 7;
  return new Date(midnight + daysUntilMonday * MS_PER_DAY).toISOString().slice(0, 10);
}
