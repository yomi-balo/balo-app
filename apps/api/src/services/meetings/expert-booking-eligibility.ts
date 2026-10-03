/**
 * BAL-591 (Part B) — whether an expert can be booked at all, asked of `POST /meetings` before
 * any booking write.
 *
 * It answers from `findNewWorkEligibility`, the one "eligible for new work" read, but refuses
 * on only two of its reasons, for EVERY context type:
 *
 *   · `not_found`      — no such expert profile.
 *   · `owner_not_live` — the owning user is suspended or deleted.
 *
 * `not_available` (the expert paused new work), `not_approved` and `not_searchable` PASS here.
 * The API cannot tell opening a new case from attaching to an open one (the case row is
 * written before the meeting hop), and a pause blocks only a NEW case, so follow-ups,
 * intro calls on a submitted request, kickoffs and package sessions must keep booking. The
 * new-case pause gate sits on the web create path, `book-consultation.ts`.
 */
import { expertsRepository, type NewWorkIneligibleReason } from '@balo/db';
import type { MeetingBookingContextType } from '@balo/shared/meetings';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('expert-booking-eligibility');

/** The only reasons that refuse a booking. Every other ineligibility reason passes. */
const REFUSING_REASONS: ReadonlySet<NewWorkIneligibleReason> = new Set([
  'not_found',
  'owner_not_live',
]);

export type ExpertBookingEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: NewWorkIneligibleReason };

export interface ExpertBookingEligibilityInput {
  readonly contextType: MeetingBookingContextType;
  readonly expertProfileId: string;
}

export async function checkExpertBookingEligibility(
  input: ExpertBookingEligibilityInput
): Promise<ExpertBookingEligibility> {
  const eligibility = await expertsRepository.findNewWorkEligibility(input.expertProfileId);
  if (eligibility.eligible || !REFUSING_REASONS.has(eligibility.reason)) {
    return { ok: true };
  }
  // The reason goes to the log only; the wire answer is one non-leaking literal.
  log.warn(
    {
      contextType: input.contextType,
      expertProfileId: input.expertProfileId,
      reason: eligibility.reason,
    },
    'Booking refused — expert not bookable'
  );
  return { ok: false, reason: eligibility.reason };
}
