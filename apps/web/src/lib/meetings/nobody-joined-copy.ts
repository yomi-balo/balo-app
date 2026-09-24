/**
 * The ONE wording for a finished meeting that NOBODY attended — the `nobody_joined` case
 * state: `missed_call` (the delivering expert never joined) with no client-side presence
 * either (`summarisePresence(...).clientSideEverPresent === false`).
 *
 * Shared by the case-surface consultation row and the recap's not-held panel so the two
 * cannot drift: the row's "View recap" link lands on that panel.
 *
 * Both lenses read the same words. Nobody was wronged, so nobody is named — never the
 * expert, never the reader, never second person. "Neither side" rather than "nobody" in the
 * sentence because an observer (Balo staff, a link guest) can have been in the room; the
 * client side and the delivering expert are exactly the two it speaks for.
 *
 * ⚠ MJ COPY CHECKPOINT — pending MJ sign-off (flagged in the PR body).
 */

/** The status pill. */
export const NOBODY_JOINED_LABEL = 'Nobody joined';

/** The one-line explanation — the consultation-row note, and the recap body with a period. */
export const NOBODY_JOINED_NOTE = 'Neither side joined this call';
