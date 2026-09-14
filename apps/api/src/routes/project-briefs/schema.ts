import { z } from 'zod';

/**
 * BAL-254 — the project-brief parse enqueue route's body schema. A schema file stays a SIBLING
 * of its route, never inlined (the `routes/admin/schema.ts` house rule).
 */
export const enqueueParseBodySchema = z.object({ parseId: z.string().uuid() });

export type EnqueueParseBody = z.infer<typeof enqueueParseBodySchema>;
