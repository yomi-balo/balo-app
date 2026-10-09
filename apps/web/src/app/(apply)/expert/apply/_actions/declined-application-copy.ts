/**
 * BAL-549 WEB-REVIEW FIX ROUND (W1), AMENDED BY BAL-557 — THE ONE HONEST MESSAGE FOR A
 * DECLINED, STILL-`rejected` APPLICATION.
 *
 * ⚠⚠ THIS IS NOT THE RE-APPLICATION TRANSITION. A declined applicant CAN start a new application
 * (BAL-557) — but only through the explicit `startNewApplicationAction`, which transitions
 * `rejected → draft` under its own row lock and cooldown check. This string is the refusal for
 * every OTHER write against a still-`rejected` row: `saveDraftAction`'s first server-bound
 * keystroke on a stale tab, and `submitApplicationAction`'s refusal before that transition runs.
 * `classifyApplicantDraftWrite` keeps `rejected → 'declined'` for exactly this reason.
 *
 * `submit-application.ts` used to answer that refusal with "Application already submitted",
 * which is not merely unhelpful but FALSE for a declined applicant — their application was
 * reviewed and declined, not "already submitted". `save-draft.ts` did not check the status at
 * all, so edits saved happily and only the submit failed: the worst possible order.
 *
 * ONE string for both call sites. Toast-length, warm, gender-neutral, states the restart as a
 * fact rather than a promise withheld — pending-MJ.
 */
export const DECLINED_APPLICATION_ERROR =
  'This application was reviewed and closed. You can start a new application from your apply page once it reopens — your answers will still be there.';

/**
 * BAL-557 — copy for `DeclinedApplicationPanel`, the surface that REPLACES the wizard while the
 * application is `rejected`. All pending-MJ: gender-neutral, warm, the wait stated as a
 * helpful fact rather than a countdown.
 */
export interface DeclinedPanelCopy {
  heading: string;
  body: string;
  ctaLabel: string;
  /** The cooldown-arm line, given the pre-formatted date the application reopens. */
  availableFrom: (date: string) => string;
  /** The ready-arm line, once the wait has passed. */
  readyNow: string;
}

export const DECLINED_PANEL_COPY: DeclinedPanelCopy = {
  heading: 'This application was reviewed and closed', // pending-MJ
  body: "Thanks for applying. This one didn't move forward this time, but your answers are saved — once the wait below has passed you can start a new application and pick up where you left off.", // pending-MJ
  ctaLabel: 'Start a new application', // pending-MJ
  availableFrom: (date: string) => `You can start a new application from ${date} — no rush.`, // pending-MJ
  readyNow: "You're welcome to start a new application whenever you're ready.", // pending-MJ
};

/** The Sonner toast on a successful restart (`reopened` outcome, including `alreadyOpen`). */
export const REOPENED_TOAST = 'New application started — your earlier answers are still here.'; // pending-MJ

/** The refusal shown when the cooldown has not yet passed, given the pre-formatted date. */
export function reopenCooldownError(date: string): string {
  // pending-MJ
  return `You can start a new application from ${date}.`;
}

/** The generic refusal when starting a new application fails unexpectedly (not a cooldown). */
export const REOPEN_GENERIC_ERROR =
  'Something went wrong starting your new application. Please try again.'; // pending-MJ

/**
 * BAL-593 H1 — the honest refusal for every OTHER closed status: a later `submitted`,
 * `under_review`, or `approved` row. `rejected` keeps `DECLINED_APPLICATION_ERROR` above; this is
 * the sibling message for an application that is closed because it was ACCEPTED into review or
 * approved, not declined. Toast-length, warm, gender-neutral — pending-MJ.
 */
export const SUBMITTED_APPLICATION_ERROR =
  "This application has already been submitted, so changes here aren't saved. If something needs correcting, email support@getbalo.com and a person will update it for you.";
