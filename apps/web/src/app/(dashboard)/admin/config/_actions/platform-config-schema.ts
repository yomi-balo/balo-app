import { z } from 'zod';
import { isValidMinConsultationMinutes } from '@balo/shared/pricing';

/**
 * Shared Zod schema + user-facing copy for the platform-config Server Action (BAL-398).
 * The validation predicate is the SSOT `isValidMinConsultationMinutes` from
 * `@balo/shared/pricing` — the same predicate the DB CHECK mirrors — so the form's inline
 * check, this Zod layer, and the DB can never drift (same posture as `promo-code-schema.ts`).
 *
 * The copy lives here as constants so the form (inline error + labels) and the action
 * (returned error strings) share one source — no duplicated string literals across the
 * client/server boundary (SonarCloud new-code duplication).
 */

/** The billing-floor rejection copy — inline in the form AND the action's `INVALID_INPUT`. */
export const MIN_LENGTH_ERROR =
  'Set 15 minutes or more. Consultations bill on a 15-minute floor, so a shorter minimum ' +
  'would under-collect on the booking and can’t be saved.';

/** Distinct inline copy for a non-integer entry (e.g. `15.5`) — a whole-minute mistake, not
 *  a below-floor one, so it reads differently from `MIN_LENGTH_ERROR` in the form. */
export const WHOLE_NUMBER_MESSAGE = 'Use a whole number of minutes.';

/** Field label + unit hint. */
export const FIELD_LABEL = 'Minimum consultation length';
export const FIELD_UNIT = 'minutes';

/** Helper text under the field (§10.7 — gender-neutral, warm-factual). */
export const FIELD_DESCRIPTION =
  'The shortest consultation a client can book, platform-wide. Keep it at 15 minutes or ' +
  'more — billing holds a 15-minute floor, so a smaller value wouldn’t cover the booking.';

/** Success toast copy — names the saved value so the confirmation is concrete (§10.7
 *  warm-factual). The single source for the success string across the form. */
export function successMessage(minutes: number): string {
  return `Minimum consultation length saved — ${minutes} minutes.`;
}

/** Auth-failure copy (unauthenticated or uncapable — no existence leak). */
export const PERMISSION_DENIED = 'You do not have permission to do this.';

/** Unexpected-failure copy. */
export const GENERIC_FAILURE = 'Could not save the setting. Please try again.';

export const setMinConsultationSchema = z.object({
  minutes: z.number().int().refine(isValidMinConsultationMinutes, { message: MIN_LENGTH_ERROR }),
});

export type SetMinConsultationSchemaInput = z.infer<typeof setMinConsultationSchema>;
