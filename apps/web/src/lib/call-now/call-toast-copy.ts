/**
 * The call toast's copy (BAL-653). The strings are verbatim from `.claude/design-references/call-now.jsx`
 * `COPY` and `call-now-copy-sheet.md`, as functions of the label, count, time or case title.
 * The two strings marked NEW are not in the reference or the copy sheet and are awaiting MJ's
 * sign-off.
 *
 * Pure and dependency-free. `label` is the caller's short name: the expert's first name for a
 * client callee, the client company for an expert callee.
 */

/** `h:mm a` in the viewer's own time zone, e.g. `3:05 PM`. */
export function formatMissedTime(iso: string, locale: string = 'en-AU'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

export const CALL_TOAST_COPY = {
  incomingTitle: (label: string): string => `${label} is calling`,
  incomingAbout: (caseTitle: string): string => `About ${caseTitle}.`,
  missedTitle: (label: string): string => `You missed a call from ${label}`,
  missedTitleMany: (count: number, label: string): string => `${count} missed calls from ${label}`,
  missedBody: (time: string): string => `They tried to reach you at ${time}.`,
  /** The missed body when the call's start time could not be read. */
  missedBodyNoTime: 'They tried to reach you.',
  callBack: 'Call back',
  dismiss: 'Dismiss',
  joinAriaLabel: (label: string): string => `Join ${label}’s call`,
  browserTitle: (label: string): string => `${label} is calling`,
  browserBody: (caseTitle: string | null): string =>
    caseTitle === null ? 'Open Balo to join.' : `${caseTitle}. Open Balo to join.`,
  /** NEW — Sonner confirmation after "Not now". */
  declined: (label: string): string => `We’ve let ${label} know.`,
  /** NEW — Sonner error when "Not now" could not reach the caller. */
  declineFailed: (label: string): string =>
    `We couldn’t let ${label} know just now — they may keep trying.`,
} as const;
