import { z } from 'zod';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

/**
 * `POST /sessions` — the acting member comes from auth; the wallet is resolved by the service.
 * `estimatedMinutes` is capped at `MAX_SESSION_MINUTES` (the reaper's safety bound) so an absurd
 * estimate can't over-size the pre-connect hold. `companyId` (BAL-401) is the OPTIONAL chosen
 * billing company — capability-gated in the service (only a company the caller holds
 * CONSUME_CREDITS on is honoured), never an arbitrary wallet selector.
 */
export const openSessionBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  estimatedMinutes: z.number().int().positive().max(MAX_SESSION_MINUTES),
  companyId: z.string().uuid().optional(),
});
export type OpenSessionBody = z.infer<typeof openSessionBodySchema>;

/** The `:id` path param for every per-session route. */
export const sessionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * BAL-399 — `POST /internal/sessions/:id/finalize-duration` (the BAL-133 consumer seam; system-
 * authed internal route, same posture as the internal `/credit` routes — NOT client-callable).
 * `minutes` is the confirmed billable duration (drawn in full, no ceiling clamp); `path` records
 * which BAL-133 outcome finalized it; `settledByUserId` is optional audit context.
 */
export const finalizeDurationBodySchema = z.object({
  minutes: z.number().int().min(0).max(MAX_SESSION_MINUTES),
  path: z.enum(['confirmed', 'disputed', 'auto_confirmed']),
  settledByUserId: z.string().uuid().optional(),
});
export type FinalizeDurationBody = z.infer<typeof finalizeDurationBodySchema>;
