import { z } from 'zod';
import { RESCHEDULE_PROPOSAL_MAX_OPTIONS } from '@balo/shared/meetings';

/**
 * BAL-411 — the Zod boundary for all four reschedule-proposal routes.
 *
 * ⚠ `.datetime()`, NOT `z.coerce.date()` — a malformed timestamp is a clean Zod 400 (the
 * `reschedule.schema.ts` precedent). ⚠ NO CLOCK-DEPENDENT `.refine` — the wall-clock checks
 * (`validateBookingWindow`, `resolveRescheduleRefusal`) run at request time, in the route.
 */

/** `:meetingId/:proposalId` — the three answer/withdraw routes. A bare `proposalId` is never
 *  a subject; every route proves `proposal.meetingId === meetingId`. */
export const meetingProposalIdParamsSchema = z.object({
  meetingId: z.string().uuid(),
  proposalId: z.string().uuid(),
});

export type MeetingProposalIdParams = z.infer<typeof meetingProposalIdParamsSchema>;

/**
 * `POST /meetings/:meetingId/reschedule-proposals` body. Only `scheduledStart` per option —
 * the end is ALWAYS server-pinned from the meeting's own duration (§D7 step 7's accept-time
 * rule applies equally at propose time: the picker never gets to imply a length).
 */
export const proposeRescheduleBodySchema = z
  .object({
    options: z
      .array(z.object({ scheduledStart: z.string().datetime() }).strict())
      .min(1)
      .max(RESCHEDULE_PROPOSAL_MAX_OPTIONS),
  })
  .strict();

export type ProposeRescheduleBody = z.infer<typeof proposeRescheduleBodySchema>;

/** `POST /meetings/:meetingId/reschedule-proposals/:proposalId/accept` body. */
export const acceptRescheduleProposalBodySchema = z
  .object({ optionId: z.string().uuid() })
  .strict();

export type AcceptRescheduleProposalBody = z.infer<typeof acceptRescheduleProposalBodySchema>;
