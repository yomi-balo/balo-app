import { EXPERT_DECLINE_REASONS, type ExpertDeclineReason } from '@balo/shared/experts';

/**
 * decline-copy — BAL-549's pure, client-safe copy module for the decline-application sheet.
 * Hoists the reason cards and note copy so every string is stated ONCE, never copy-pasted
 * between the sheet and any future surface that needs the same vocabulary.
 *
 * NO `@balo/db` IMPORT AT ALL (not even type-only) and NO `server-only` — `decline-application-
 * sheet.tsx` is a client component that needs this copy in the browser bundle, and a client
 * component that value-imports `@balo/db` fails `next build`. `ExpertDeclineReason` comes from
 * `@balo/shared/experts`, which exists for exactly that reason.
 */

/** Minimum Balo-only note length the decline sheet requires — the `close-request-sheet` shape. */
export const DECLINE_NOTE_MIN_LENGTH = 8;

export interface DeclineReasonOption {
  key: ExpertDeclineReason;
  label: string;
  hint: string;
}

/**
 * The label for a reason, wherever only the label (not the hint/card) is needed. `Record<>`
 * makes an incomplete map a `tsc` error — every `EXPERT_DECLINE_REASONS` member must resolve.
 */
export const DECLINE_REASON_LABEL: Record<ExpertDeclineReason, string> = {
  experience_depth: 'Experience depth', // pending-MJ
  credentials_unverified: 'Credentials unverified', // pending-MJ
  application_incomplete: 'Application incomplete', // pending-MJ
  not_a_fit: 'Not a fit right now', // pending-MJ
};

const DECLINE_REASON_HINT: Record<ExpertDeclineReason, string> = {
  experience_depth: 'Looking for deeper hands-on experience than the application showed.', // pending-MJ
  credentials_unverified: 'The certifications listed could not be verified.', // pending-MJ
  application_incomplete: 'Missing details needed to assess it properly.', // pending-MJ
  not_a_fit: 'Not a skill set our clients are asking for at the moment.', // pending-MJ
};

/** The four reason cards, in `EXPERT_DECLINE_REASONS` order — one card per shared vocabulary member. */
export const DECLINE_REASONS: readonly DeclineReasonOption[] = EXPERT_DECLINE_REASONS.map(
  (key) => ({
    key,
    label: DECLINE_REASON_LABEL[key],
    hint: DECLINE_REASON_HINT[key],
  })
);

/** The Balo-only note textarea's placeholder — never shown to the applicant. */
export function declineNotePlaceholderFor(firstName: string): string {
  // pending-MJ
  return `What the next person at Balo should know about ${firstName}'s application — never shown to them`;
}
