import { z } from 'zod';

/**
 * The proposal-draft enqueue route's body schema. A schema file stays a SIBLING of its route,
 * never inlined (the `routes/admin/schema.ts` house rule).
 */
export const enqueueProposalDraftBodySchema = z.object({ generationId: z.string().uuid() });

export type EnqueueProposalDraftBody = z.infer<typeof enqueueProposalDraftBodySchema>;
