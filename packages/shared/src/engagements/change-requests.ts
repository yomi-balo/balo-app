/**
 * Change-request round helpers shared by the web action, the API templates and the
 * admin-alert detail builder, so the title list reads identically on every surface.
 */

/** The round ordinal from which the Balo team is alerted to a repeat change request. */
export const REPEAT_CHANGE_REQUEST_MIN_ROUND = 2;

/** Whether a change-request round of this ordinal is a repeat that warrants an admin alert. */
export function isRepeatChangeRequestRound(roundNumber: number): boolean {
  return roundNumber >= REPEAT_CHANGE_REQUEST_MIN_ROUND;
}

/**
 * Joins titles as prose: "A", "A and B", "A, B and C". Returns `''` for none.
 */
export function joinTitles(titles: readonly string[]): string {
  const [first, second] = titles;
  if (first === undefined) return '';
  if (second === undefined) return first;
  const last = titles.at(-1);
  if (titles.length === 2) return `${first} and ${last}`;
  return `${titles.slice(0, -1).join(', ')} and ${last}`;
}
