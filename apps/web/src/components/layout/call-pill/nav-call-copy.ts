/**
 * BAL-636 — the top-nav call pill's NEW strings. Everything else reuses `up-next-copy.ts`
 * (`UP_NEXT_JOIN`, `upNextStartsIn`, `UP_NEXT_HAPPENING_NOW`) and `ROOM_SETTING_UP_SHORT_LABEL`.
 * Gender-neutral (CLAUDE.md). MJ copy sign-off is flagged in the PR body and does not block.
 */

export const NAV_CALL_LIST_TITLE = 'Calls you can join';

/** The sr-only announcement, spoken once per meeting. */
export const navCallReadyAnnouncement = (name: string): string =>
  `Your call with ${name} is ready to join.`;

export const navMoreCalls = (count: number): string =>
  count === 1 ? `${count} more call` : `${count} more calls`;

export const navMoreCallsAriaLabel = (count: number): string => `Show ${navMoreCalls(count)}`;
