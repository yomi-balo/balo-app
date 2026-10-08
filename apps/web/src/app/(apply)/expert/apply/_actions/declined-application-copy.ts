/**
 * BAL-549 WEB-REVIEW FIX ROUND (W1) — THE ONE HONEST MESSAGE FOR A DECLINED APPLICATION.
 *
 * ⚠⚠ A DECLINED APPLICANT CANNOT RE-SUBMIT TODAY. `expertsRepository.submitApplication`'s WHERE
 * is `and(eq(id, …), eq(applicationStatus, 'draft'))`, so a `'rejected'` profile matches no row;
 * BAL-549's own "Out of scope" excluded the `rejected → submitted` transition and a FOLLOW-UP
 * TICKET owns it. Until that ships, the wizard is reachable for a declined applicant (the page
 * renders it with their own answers) but both writes refuse.
 *
 * `submit-application.ts` used to answer that refusal with "Application already submitted",
 * which is not merely unhelpful but FALSE for a declined applicant — their application was
 * reviewed and declined, not "already submitted". `save-draft.ts` did not check the status at
 * all, so edits saved happily and only the submit failed: the worst possible order.
 *
 * ONE string for both call sites, because the applicant is being told the same fact either way
 * ("this application is closed, here is a person to talk to"), and two spellings of it would
 * drift. Toast-length, warm, gender-neutral, no promise of a re-application — pending-MJ.
 */
export const DECLINED_APPLICATION_ERROR =
  "We've already reviewed this application, so it can't be changed or submitted again. Email support@getbalo.com and a person will pick it up from there.";

/**
 * BAL-593 H1 — the honest refusal for every OTHER closed status: a later `submitted`,
 * `under_review`, or `approved` row. `rejected` keeps `DECLINED_APPLICATION_ERROR` above; this is
 * the sibling message for an application that is closed because it was ACCEPTED into review or
 * approved, not declined. Toast-length, warm, gender-neutral — pending-MJ.
 */
export const SUBMITTED_APPLICATION_ERROR =
  "This application has already been submitted, so changes here aren't saved. If something needs correcting, email support@getbalo.com and a person will update it for you.";
