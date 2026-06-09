import { z } from 'zod';

/**
 * Canonical project-request contract.
 *
 * This is the file BAL-254 imports — it is the single source of truth for the
 * drawer payload. Discriminated union on `sendTo`:
 *  - `direct` — routed to a specific expert; `expertProfileId` is REQUIRED.
 *  - `match`  — unrouted brief for ops to match; `expertProfileId` is OMITTED.
 *
 * `description` carries RAW HTML from the editor. The length bound here is a DoS
 * guard, not the UX limit — the server sanitises it (the security boundary) in
 * `submit-project-request.ts` before persist. Tags/products are UUIDs; documents
 * are confirmed R2 refs. Tags/products/documents are all OPTIONAL — only `title`
 * and `description` gate submit.
 */

/** Content types accepted for project documents (mirrors the storage allow-list). */
export const PROJECT_DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

/** Max document size in bytes (mirrors `MAX_DOCUMENT_BYTES` in storage). */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Max number of documents per request. */
export const MAX_DOCUMENTS = 4;

export const documentRefSchema = z.object({
  r2Key: z.string().min(1),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(PROJECT_DOCUMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});

export type ProjectDocumentRef = z.infer<typeof documentRefSchema>;

/** Max length of the free-text timeline (a short phrase, e.g. "end of Q3"). */
export const MAX_TIMELINE_LENGTH = 120;

const baseProjectRequestFields = {
  title: z.string().trim().min(3, 'Give your project a title').max(120),
  // Raw HTML from the editor. Bounded generously; sanitised server-side before persist.
  description: z.string().trim().min(1, 'Add a few words about what you need').max(20000),
  tagIds: z.array(z.string().uuid()).max(19).default([]),
  productIds: z.array(z.string().uuid()).max(50).default([]),
  documents: z.array(documentRefSchema).max(MAX_DOCUMENTS).default([]),
  source: z.enum(['manual', 'ai', 'quickstart']).default('manual'),
  // Optional budget range in integer minor units (cents), fixed to AUD in the
  // action. Both nullable — either side may be omitted for a one-sided budget.
  budgetMinCents: z.number().int().nonnegative().nullable().default(null),
  budgetMaxCents: z.number().int().nonnegative().nullable().default(null),
  // Optional free-text timeline (empty string → null). Genuinely unstructured.
  timeline: z
    .string()
    .trim()
    .max(MAX_TIMELINE_LENGTH)
    .nullable()
    .default(null)
    .transform((v) => (v === null || v.length === 0 ? null : v)),
};

/**
 * When both budget amounts are present, max must be ≥ min (the range is
 * coherent). Either side may be null (one-sided/empty budget). Shared by both
 * union branches.
 */
function refineBudgetRange(
  data: { budgetMinCents: number | null; budgetMaxCents: number | null },
  ctx: z.RefinementCtx
): void {
  const { budgetMinCents, budgetMaxCents } = data;
  if (budgetMinCents !== null && budgetMaxCents !== null && budgetMaxCents < budgetMinCents) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Max budget must be at least the minimum.',
      path: ['budgetMaxCents'],
    });
  }
}

export const projectRequestInputSchema = z
  .discriminatedUnion('sendTo', [
    z.object({
      sendTo: z.literal('direct'),
      expertProfileId: z.string().uuid(),
      ...baseProjectRequestFields,
    }),
    z.object({
      sendTo: z.literal('match'),
      // expertProfileId intentionally omitted in match mode
      ...baseProjectRequestFields,
    }),
  ])
  .superRefine(refineBudgetRange);

export type ProjectRequestInput = z.infer<typeof projectRequestInputSchema>;
