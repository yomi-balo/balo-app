/**
 * BAL-551 fix round R5 — the Lookup search caps, hoisted OUT of `@balo/db`'s
 * `platform-lookup.ts`.
 *
 * A client component must never value-import `@balo/db` — its barrel re-exports `postgres`
 * and breaks `next build` on an unresolvable `tls` (memory
 * `reference_balo_db_client_bundle_footgun`). `lookup-results-list.tsx`'s "Showing the first
 * 20 matches" copy could not read the real cap for exactly that reason, so it hardcoded a
 * literal `20`, free to drift from `LOOKUP_RESULT_CAP`.
 *
 * `platform-lookup.ts` re-exports all three so every existing caller
 * (`packages/db/src/repositories/index.ts`, `platform-lookup.test.ts`,
 * `platform-lookup.integration.test.ts`) keeps working on the old `@balo/db` path unchanged —
 * this file is now the single source of truth.
 *
 * ⚠ PURE NUMERIC CONSTANTS ONLY. No I/O, no `@balo/db`, matching this subpath's "pure types
 * and const tuples" rule (see `./types`'s header comment).
 */

/** The merged result ceiling. The UI says "showing the first N — refine" past it. */
export const LOOKUP_RESULT_CAP = 20;

/**
 * Per-arm `LIMIT` — the cap PLUS ONE PROBE ROW.
 *
 * ONE arm may legitimately fill the whole budget (30 companies matching "north" and
 * nothing else), so the per-arm limit cannot be smaller than the cap. It cannot be EQUAL
 * to it either: `truncated` is `Σ|arm| > cap`, so an arm capped at exactly the cap could
 * never report that a larger match had been trimmed — the single-arm overflow case, which
 * is the commonest one, would silently claim it showed everything. The extra row is fetched
 * and never rendered; it exists only to answer "was there more?".
 */
export const LOOKUP_ARM_LIMIT = LOOKUP_RESULT_CAP + 1;

/**
 * A one-character query is `%a%` against six tables. Refuse it — `search` returns
 * `{ results: [], truncated: false, tooShort: true }` and issues NO query at all.
 */
export const LOOKUP_MIN_QUERY_LENGTH = 2;
