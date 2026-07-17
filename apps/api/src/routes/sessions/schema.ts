import { z } from 'zod';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';

/**
 * `POST /sessions` — company + acting member come from auth; the wallet is resolved by the
 * service. `estimatedMinutes` is capped at `MAX_SESSION_MINUTES` (the reaper's safety bound)
 * so an absurd estimate can't over-size the pre-connect hold.
 */
export const openSessionBodySchema = z.object({
  expertProfileId: z.string().uuid(),
  estimatedMinutes: z.number().int().positive().max(MAX_SESSION_MINUTES),
});
export type OpenSessionBody = z.infer<typeof openSessionBodySchema>;

/** The `:id` path param for every per-session route. */
export const sessionIdParamsSchema = z.object({
  id: z.string().uuid(),
});
