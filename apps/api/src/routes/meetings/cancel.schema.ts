import { z } from 'zod';

/**
 * BAL-410 — the `POST /meetings/:meetingId/cancel` body.
 *
 * ⚠⚠ DELIBERATELY EMPTY, AND IT MUST STAY EMPTY. There is no `reason`, no `initiatedBy` and no
 * `cancelledBy`, and their absence is the security property rather than an omission — the same
 * rule `join.schema.ts` and `guests.schema.ts` record for `party`/`accessScope`/`isOwner`:
 *
 *   · `initiatedBy` is WHICH AUTHORIZATION ARM MATCHED (`authorizeMeetingCancel`'s `actorRole`).
 *     Server-derived, so it cannot be spoofed. A body field would let a client stamp an audit
 *     row and an analytics event with `'admin'`.
 *   · `reason` is a SERVICE parameter, defaulted to `'requested'`. A wire-accepted reason would
 *     let a client trigger the `'expert_time_off'` copy variant — "your expert has taken time
 *     off" — on a cancellation the expert had nothing to do with.
 *
 * ⚠ `.strict()` MAKES THAT STRUCTURAL, AND THE DISTINCTION MATTERS. Zod's DEFAULT object
 * behaviour merely STRIPS unknown keys; `.strict()` REJECTS them with a 400. This is the
 * `openSessionBodySchema` G1 lesson verbatim (`routes/sessions/schema.ts`): "an absent
 * expectation is not an absent acceptance." Do not weaken this to `.passthrough()`, and do not
 * "helpfully" add a field here when the time-off cancel branch lands — that producer is
 * API-side and passes `reason` as a service parameter, never through this schema.
 */
export const cancelMeetingBodySchema = z.object({}).strict();

export type CancelMeetingBody = z.infer<typeof cancelMeetingBodySchema>;
