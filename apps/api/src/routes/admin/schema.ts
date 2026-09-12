import { z } from 'zod';
import { REDRIVE_KINDS } from '@balo/shared/capture-health';

/**
 * BAL-550 — the admin re-drive route's params schema. `'use server'`-adjacent house rule
 * mirrored here for Fastify: a schema file stays a SIBLING of its route, never inlined, so a
 * future route in this plugin does not tempt a second `z.object` shape for the same params.
 */
export const redriveParamsSchema = z
  .object({
    kind: z.enum(REDRIVE_KINDS),
    id: z.uuid(),
  })
  .strict();

export type RedriveParams = z.infer<typeof redriveParamsSchema>;
