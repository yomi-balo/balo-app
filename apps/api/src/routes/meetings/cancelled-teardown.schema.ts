import { z } from 'zod';

/**
 * BAL-540 — the `POST /meetings/cancelled-teardown` body. Internal-auth only (see the route's
 * docblock): a batch of meetings the `@balo/db` close cascade has ALREADY committed to
 * `status = 'cancelled'` in one transaction. This endpoint performs only the two POST-COMMIT,
 * best-effort effects (availability-cache rebuild + Daily room teardown) — see
 * `services/meetings/meeting-availability.ts`'s `tearDownCancelledMeetings`.
 *
 * `expertProfileId` is a REBUILD HINT, not an authority — the worst a wrong value can do is waste
 * one BullMQ job, so it needs no membership check. Bounded at 25 to match the cascade's realistic
 * upper bound (one `project_discovery` meeting + N per-relationship `request_interaction`
 * meetings) and to keep a caller holding `INTERNAL_API_SECRET` from fanning out unboundedly (the
 * `expertSearchabilityLostPayload` `.max()` reasoning, `routes/notifications/schema.ts:505-515`).
 */
export const cancelledTeardownBodySchema = z
  .object({
    meetings: z
      .array(
        z.object({
          meetingId: z.uuid(),
          /** Whose availability cache to rebuild. `null` = an admin meeting, nothing to rebuild. */
          expertProfileId: z.uuid().nullable(),
        })
      )
      .min(1)
      .max(25),
  })
  .strict();

export type CancelledTeardownBody = z.infer<typeof cancelledTeardownBodySchema>;
