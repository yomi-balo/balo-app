/**
 * BAL-390 — user-facing failure copy for the two review write paths.
 *
 * ⚠ WHY THIS FILE EXISTS, AND WHY THESE STRINGS MUST NOT MOVE BACK INTO THE ACTIONS.
 *
 * Next forbids a `'use server'` module from exporting anything that is not an async
 * function: *"Only async functions are allowed to be exported in a 'use server' file."*
 * A plain `export const` string in an action file therefore fails `next build` the
 * moment that module is pulled into the client graph.
 *
 * That failure is invisible to every other gate — `tsc`, `eslint` and `vitest` all pass,
 * because it is a bundler rule rather than a type or lint rule. It surfaced only in CI
 * on PR #191. Worse, it is *conditional*: `submit-engagement-review.ts` carried the same
 * violation and built green purely because it has no callers yet (BAL-389 mounts it), so
 * it was never in the client graph to be checked. Both are consolidated here so neither
 * can regress and BAL-389 does not inherit a latent build break.
 *
 * Type-only exports (`export type` / `export interface`) are erased at compile time and
 * remain fine in an action file — the rule applies to VALUE exports only.
 *
 * This module is deliberately dependency-free: pure string constants, no imports, no
 * `server-only`. Client components and Server Actions both import it directly.
 *
 * DRAFT COPY — all strings pending MJ sign-off.
 */

/**
 * The token path's single failure string. ONE message for every failure mode, and
 * deliberately not the design's "looks like the connection dropped": an expired token is
 * not a dropped connection, and because we refuse to distinguish the cases — refusing to
 * be an existence oracle — the copy has to be true of all of them. Warm, blameless, and
 * it promises the draft is intact, which it is: the form never clears on failure.
 */
export const REVIEW_SUBMIT_FAILED =
  "We couldn't save your review just now. Everything you've written is still here — please try again.";

/** Signed-in path: the session was missing or had expired by the time the write ran. */
export const REVIEW_NOT_SIGNED_IN = 'Please sign in and try again.';

/** Signed-in path: the payload failed the strict Zod parse. */
export const REVIEW_INVALID_REQUEST = 'Invalid request.';

/**
 * Signed-in path: no such engagement — and `forbidden` collapses to this same string, so
 * the action never becomes an existence oracle for engagements the caller cannot see.
 */
export const REVIEW_ENGAGEMENT_NOT_FOUND = 'This engagement could not be found.';

/** Signed-in path: anything unexpected. Never leaks the underlying error. */
export const REVIEW_GENERIC_FAILURE = 'Something went wrong. Please try again.';
