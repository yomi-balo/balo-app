/**
 * Call now copy (BAL-651). Verbatim from `.claude/design-references/call-now.jsx` `COPY`, as
 * functions of the name, time or rate where the reference interpolates. The strings marked NEW are
 * not in the reference or the copy sheet and are awaiting MJ's sign-off.
 *
 * Pure and dependency-free, so a server module and a client component can both import it. No
 * string here names a person: the callee label is a first name (client lens) or a company (expert
 * lens), and no string carries money except the client confirm's `rateLine`.
 */

import { CALL_NOW_SCHEDULED_MINUTES } from '@balo/shared/meetings';

export const CALL_NOW_COPY = {
  entry: 'Call now',
  busy: (name: string): string => `${name} is in another call`,
  lateNight: (name: string, time: string): string =>
    `It’s ${time} for ${name} — book a time instead`,
  confirmTitle: (name: string): string => `Call ${name} now?`,
  clientOnline: (name: string): string =>
    `${name} is online. We’ll let them know you’re calling and you’ll wait in the call room. If ${name} doesn’t pick up, nothing is charged.`,
  clientOffline: (name: string): string =>
    `${name} isn’t online right now. We’ll send a text, but they may not see it in time. If they don’t pick up, nothing is charged — booking a time is the surer way to talk.`,
  clientTerms: (rateLine: string): string => `${rateLine}. The timer starts when you’re both in.`,
  clientTermsNoRate: 'The timer starts when you’re both in.',
  expertConfirm: (name: string): string =>
    `We’ll let ${name} know you’re calling. They see your rate before they join, and the timer starts when you’re both in. Waiting isn’t counted on an unscheduled call.`,
  inPlace: (time: string): string => `Use this call in place of today’s ${time} consultation`,
  inPlaceHint: 'No extra credit is needed for this call, and the later slot is released.',
  notNow: 'Not now',
  callAnyway: 'Call anyway',
  bookInstead: 'Book a time',
  callingTitle: (name: string): string => `Calling ${name}`,
  callingClient: (name: string, sms: boolean): string => {
    const reached = sms ? `We’ve texted ${name}` : `We’ve let ${name} know`;
    return `${reached}. Nothing is charged while you wait — the timer starts once you’re both in.`;
  },
  callingExpert: (name: string): string =>
    `We’ve let ${name} know. Waiting isn’t counted on an unscheduled call — the timer starts once you’re both in.`,
  stop: 'Stop calling',
  noAnswerTitle: (name: string): string => `No answer from ${name}`,
  declinedTitle: (name: string): string => `${name} can’t talk right now`,
  noAnswerClient: (name: string): string =>
    `Nothing was charged. ${name} will see that you called.`,
  noAnswerExpert: (name: string): string =>
    `Nothing was counted or charged. ${name} will see that you called.`,
  backToCase: 'Back to the case',
  rowNote: 'Unscheduled call',
  rowNoteMoved: (bookedFor: string): string => `Started early — was booked for ${bookedFor}`,
  fundTitle: 'Add credit to start this call',
  /** NEW — the accessible name of the entry button (call-now-mobile.jsx). */
  entryAriaLabel: (name: string): string => `Call ${name} now`,
  /** NEW — the live countdown under the calling copy. */
  ringRemaining: (seconds: number): string =>
    `We’ll keep trying for ${seconds} more ${seconds === 1 ? 'second' : 'seconds'}.`,
  /** NEW — a member cannot top up, so the call panel asks them to find someone who can. */
  memberFundingTitle: 'A billing admin needs to add credit',
  /** NEW */
  memberFundingBody: (company: string): string =>
    `Calls need enough credit for the ${CALL_NOW_SCHEDULED_MINUTES}-minute minimum. Ask a billing admin at ${company} to add it, or book a time instead.`,
  /** NEW — the manager panel, when the top-up cannot run from the dialog. */
  panelFundingBody: 'Add credit to start this call.',
  /** NEW */
  addCredit: 'Add credit',
  /** NEW */
  stoppedToast: 'Call stopped — nothing was charged.',
  /** NEW — a Join or an answer that reached a ring which has already ended. */
  answerEndedToast: (name: string): string =>
    `${name}’s call has ended — nothing was charged. You can call them back from the case.`,
  /** NEW — the caller's room lost track of the ring (the ring read keeps failing). */
  ringLostToast: 'We lost track of this call — nothing was charged. Try again from the case.',
  /** NEW — credit was added, but the call still could not start. */
  fundedRetryToast: 'Your credit was added. The call didn’t start — try again.',
  /** NEW — the explicit answer control on the call room when the client must commit. */
  answerTitle: (name: string): string => `${name} is calling`,
  /** NEW */
  answerAction: 'Answer',
} as const;

/** Why a start or an answer failed, as one sentence the toast can show. */
export type CallNowFailureCode =
  | 'unavailable'
  | 'in_place_not_eligible'
  | 'funding_unavailable'
  | 'venue_unavailable'
  | 'rate_limited'
  | 'session_expired'
  | 'failed';

/** NEW — every string below, keyed by failure code. */
export const START_FAILURE_COPY: Readonly<Record<CallNowFailureCode, string>> = {
  unavailable: 'Call now isn’t available right now.',
  in_place_not_eligible: 'Today’s consultation can’t be used for this call any more.',
  funding_unavailable: 'We couldn’t check your credit just now. Try again in a moment.',
  venue_unavailable: 'We couldn’t set up the call room. Try again in a moment.',
  rate_limited: 'You’ve called a few times — try again in a minute.',
  session_expired: 'Please sign in again.',
  failed: 'Something went wrong. Try again.',
};
