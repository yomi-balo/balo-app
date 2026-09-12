import { narrowToExpertDeclineReason, type ExpertDeclineReason } from '@balo/shared/experts';

/**
 * BAL-549 — the `expert_decline_reason` CATEGORY → its applicant-facing label. The union and its
 * narrowing both come from `@balo/shared/experts` — the ONE definition, shared with the
 * notification payload, the analytics event map and the web surfaces. This module owns only the
 * LABELS.
 *
 * ⚠ NEVER RENDERS `decline_note` — the note is staff-only and never leaves the DB. This is the
 * CATEGORY label only. (The payload carries no note field, so there is nothing here to leak; the
 * comment stands so a future widening has to argue with it.)
 *
 * TONE (CLAUDE.md): warm, never adversarial, gender-neutral. Each label completes the sentence
 * "This time round, {label}."
 */
export const EXPERT_DECLINE_REASON_LABEL: Record<ExpertDeclineReason, string> = {
  experience_depth: 'we were looking for deeper hands-on experience than the application showed', // pending-MJ
  credentials_unverified: 'we could not verify the certifications listed', // pending-MJ
  application_incomplete: 'the application was missing details we need to assess it properly', // pending-MJ
  not_a_fit: 'the skills on offer are not ones our clients are asking for right now', // pending-MJ
};

/** Narrow the merged payload's `reason`; anything unknown degrades to `'not_a_fit'`. */
export function readExpertDeclineReason(value: unknown): ExpertDeclineReason {
  return narrowToExpertDeclineReason(value) ?? 'not_a_fit';
}
