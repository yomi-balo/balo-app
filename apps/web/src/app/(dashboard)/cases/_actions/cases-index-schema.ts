import { z } from 'zod';

/**
 * BAL-567 — the `/cases` "show more" Server Actions' input schemas.
 *
 * ⚠ A SIBLING FILE, NOT INLINED IN THE ACTION MODULE. A `'use server'` module may export ONLY
 * async functions (memory `reference_use_server_no_value_exports`), so a `const schema = …` there
 * breaks the build — the `capture-health-schema.ts` shape, verbatim.
 *
 * ⚠⚠ NEITHER CURSOR CARRIES A PARTY ID, AND THAT IS THE SECURITY PROPERTY, NOT A CONVENIENCE.
 * The actions re-derive the scope from the SEALED SESSION and re-run the participation gate on
 * every call. A `companyId` or `expertProfileId` accepted here would be a client-supplied
 * tenancy key, and `casesIndexRepository` makes no authorization decision of its own.
 *
 * ⚠ `.strict()` ON BOTH: an unexpected key is a rejected call, not a silently ignored one.
 */

/**
 * The OPEN list's keyset position. `bucket` is `0` (has an upcoming booking) or `1` (none) — the
 * repository's leading sort key — and `sortRank` is a signed epoch in seconds, NEGATED for the
 * unbooked bucket, so it is legitimately negative and must not be bounded at zero.
 */
export const casesIndexCursorSchema = z
  .object({
    bucket: z.number().int().min(0).max(1),
    sortRank: z.number(),
    id: z.uuid(),
  })
  .strict();

/** The RESOLVED list's keyset position: `extract(epoch from closed_at)` plus the id tiebreak. */
export const resolvedCasesCursorSchema = z
  .object({
    closedAtEpoch: z.number(),
    id: z.uuid(),
  })
  .strict();

export const loadMoreOpenCasesSchema = z.object({ cursor: casesIndexCursorSchema }).strict();

/**
 * `cursor: null` is the FIRST resolved page — the section is collapsed by default and loads
 * nothing until it is opened, so "give me page one" is a legitimate, cursor-less call.
 */
export const loadMoreResolvedCasesSchema = z
  .object({ cursor: resolvedCasesCursorSchema.nullable() })
  .strict();

export type LoadMoreOpenCasesInput = z.infer<typeof loadMoreOpenCasesSchema>;
export type LoadMoreResolvedCasesInput = z.infer<typeof loadMoreResolvedCasesSchema>;
