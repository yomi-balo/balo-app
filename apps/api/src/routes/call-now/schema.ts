import { z } from 'zod';

/** `:engagementId` — the case routes. */
export const engagementIdParamsSchema = z.object({
  engagementId: z.uuid(),
});

/** `:ringId` — the three ring routes. */
export const ringIdParamsSchema = z.object({
  ringId: z.uuid(),
});

/**
 * BAL-649 — the `POST /cases/:engagementId/call-now` body.
 *
 * ⚠⚠ ONE OPTIONAL FIELD, AND NOTHING ELSE MAY BE ADDED. There is deliberately no `side`,
 * `callee`, `reachedBy` or `expiresAt`: the side is WHICH AUTHORIZATION ARM MATCHED, the callee
 * is resolved server-side, the reach is `app` until BAL-652 and the window is configuration. A
 * wire-accepted value for any of them would let a caller choose who is rung or for how long.
 *
 * `.strict()` REJECTS an unknown key with a 400 rather than silently stripping it — "an absent
 * expectation is not an absent acceptance".
 *
 * `inPlaceOfMeetingId` is a CLIENT-only choice (an expert caller sending it is refused by the
 * service, decision 9) and must name the case's same-day candidate booking.
 */
export const startCallNowBodySchema = z
  .object({
    inPlaceOfMeetingId: z.uuid().optional(),
  })
  .strict();

export type StartCallNowBody = z.infer<typeof startCallNowBodySchema>;

/**
 * BAL-651 — the `POST /cases/:engagementId/call-now` QUERY. `attemptId` is the web funnel's
 * per-tap id. It rides the query rather than the body because the body is `.strict()`: a new web
 * build calling an older API would otherwise get a 400 on every start, while an unknown query
 * parameter is ignored. A value that fails to parse is dropped, never a 400: analytics must never
 * block a call.
 */
export const startCallNowQuerySchema = z.object({ attemptId: z.uuid() }).partial();

export type StartCallNowQuery = z.infer<typeof startCallNowQuerySchema>;
