/**
 * project-requests/brief-parse (BAL-254) — THE shared contract for the AI-assisted project
 * brief parse: its caps, its CLOSED failure vocabulary, and the two shapes that cross a
 * package boundary (`ProjectBriefParseSourceDocument`, `ProjectBriefParseResult`).
 *
 * ── WHY IT LIVES IN `@balo/shared` ────────────────────────────────────────────────────
 * ALL THREE of `apps/web`, `apps/api` and `@balo/db` need it. `@balo/db` owns the table, but
 * `@balo/shared` must not import `@balo/db` (a client island that value-imports `@balo/db`
 * drags the `postgres` driver into the browser bundle and fails `next build` — memory
 * `reference_balo_db_client_bundle_footgun`), and the panel's polling hook is a client island.
 * So the vocabulary lives here and `schema/project-brief-parses.ts` imports it **type-only**,
 * exactly as `schema/admin-alerts.ts` imports `AdminAlertDetail`.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER
 * (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 *
 * PURE. No I/O, no clock, no `server-only`.
 */

// ── Caps ───────────────────────────────────────────────────────────────────────────────

/**
 * Total bytes across ALL source documents for one parse (D10 — the cost budget is enforced
 * as a BYTE ceiling and merely OBSERVED as a token count).
 *
 * ⚠ ENFORCED TWICE, WEB-SIDE **AND** WORKER-SIDE. The web check is the fast refusal; the
 * worker check is the real one, because the worker reads the bytes and the row it reads them
 * for may have been written by an older deploy.
 */
export const MAX_PARSE_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * Per-user parses per rolling hour. Enforced web-side as a DB count
 * (`projectBriefParsesRepository.countCreatedSince`) AND api-side as a Redis rate limit —
 * two independent counters, because the web count is the one a user can see the effect of and
 * the Redis one is the one that survives a direct API call.
 */
export const MAX_PARSES_PER_HOUR = 12;

/**
 * A `pending` row older than this reads as `timed_out` (D3 — DERIVED at read, never stored,
 * so no reaper job exists). 3 min deliberately exceeds the client's 2 min poll cap, so the
 * client gives up before the derivation does and the two never disagree on screen.
 */
export const PARSE_DEADLINE_MS = 3 * 60 * 1000;

// ── Bounds on the model's structured output — display strings, not prose ───────────────

/** Matches `actions/schemas.ts`' `title` max, so a parsed title can never fail submit. */
export const MAX_BRIEF_TITLE_LENGTH = 120;
/** → ≤20000 HTML after conversion, comfortably inside `schemas.ts`' description cap. */
export const MAX_BRIEF_MARKDOWN_LENGTH = 8000;
/** How many "we saw this concept but it is not in the taxonomy" labels may reach a human. */
export const MAX_UNMATCHED_LABELS = 8;
/** Each such label is a short noun phrase, never a sentence the model wrote. */
export const MAX_UNMATCHED_LABEL_LENGTH = 60;
/** Matches `actions/schemas.ts`' `tagIds` max. */
export const MAX_BRIEF_TAG_SLUGS = 19;
/** Matches `actions/schemas.ts`' `productIds` max. */
export const MAX_BRIEF_PRODUCT_SLUGS = 50;

// ── The closed failure vocabulary ──────────────────────────────────────────────────────

/**
 * THE closed set of failure reasons.
 *
 * ⚠⚠ FIXED LITERALS — NEVER A MODEL OR VENDOR MESSAGE. A provider string in this column
 * would (a) leak vendor internals to a client screen and (b) make the failure banner's copy
 * unpredictable. Every write site picks one of these; anything it cannot classify is
 * `'unknown'`.
 *
 * ⚠ TWO OF THESE ARE **DERIVED AT READ AND NEVER STORED** — `'timed_out'` (a still-pending row
 * past `PARSE_DEADLINE_MS`) and `'not_found'` (no row for this owner). They are members of the
 * same union because the client renders one banner over all of them; the database's
 * `failure_reason` column will never hold either.
 */
export const PROJECT_BRIEF_FAILURE_REASONS = [
  /** The api hop did not land — the row exists but no job was ever enqueued. */
  'enqueue_failed',
  /** An R2 read failed, or a document had no extractable content. */
  'unreadable',
  /** Total bytes exceeded `MAX_PARSE_INPUT_BYTES`. */
  'too_large',
  /** The model returned a title/description below the usable floor. */
  'empty_extraction',
  /** The model's object failed Zod on receipt. */
  'invalid_output',
  /** `finishReason === 'length'` — a partial artifact is never persisted. */
  'truncated',
  /** `AiModelNotAllowedError`, or any provider/config failure. */
  'model_unavailable',
  /** ⚠ DERIVED at read from `created_at`; never stored. */
  'timed_out',
  /** ⚠ DERIVED at read; never stored. Also the answer for a cross-tenant `parseId` (Gate 4). */
  'not_found',
  /** Everything the write site could not classify. */
  'unknown',
] as const;

/** @see PROJECT_BRIEF_FAILURE_REASONS */
export type ProjectBriefFailureReason = (typeof PROJECT_BRIEF_FAILURE_REASONS)[number];

/**
 * THE narrowing, for the one place a reason arrives as `unknown`: `failure_reason` is `text`
 * in Postgres (D3 — no pgEnum anywhere on this table), so a row written by an older deploy, or
 * repaired by hand, can hold a string outside this tuple.
 *
 * Returns `null` rather than throwing — every caller is a display surface that renders the
 * generic banner for an unrecognised reason. Cast-free by construction: `Array.prototype.find`
 * over the literal tuple returns the union.
 */
export function narrowToProjectBriefFailureReason(
  value: unknown
): ProjectBriefFailureReason | null {
  if (typeof value !== 'string') return null;
  return PROJECT_BRIEF_FAILURE_REASONS.find((candidate) => candidate === value) ?? null;
}

// ── The two persisted shapes ───────────────────────────────────────────────────────────

/**
 * One validated source document.
 *
 * ⚠⚠ `r2Key` IS SESSION-VALIDATED **BEFORE** IT IS WRITTEN (Ruling A / §12 Gate 1). The
 * web Server Action re-derives `project-documents/{session.companyId}/{session.userId}/` and
 * refuses any key outside it; only then does the array reach
 * `project_brief_parses.source_documents`. Nothing else may populate that column, which is why
 * the job payload is `{ parseId }` alone and no key ever crosses the wire.
 *
 * `contentType` is the closed set the uploader accepts and the Anthropic provider can read as
 * a native document/image block.
 */
export interface ProjectBriefParseSourceDocument {
  readonly r2Key: string;
  readonly fileName: string;
  readonly contentType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
  readonly sizeBytes: number;
}

/**
 * The persisted parse result — what the panel writes into the draft.
 *
 * ⚠ `descriptionMarkdown` IS THE MODEL'S CONSTRAINED MARKDOWN SUBSET, NOT HTML (D4 / §12.9).
 * Model HTML is never trusted: the server converts this deterministically and the output
 * always passes through the existing `sanitizeProjectHtml` boundary before it reaches a client.
 *
 * ⚠ `tagIds` / `productIds` HOLD LIVE TAXONOMY IDS THE **SERVER** RESOLVED (D5). The model
 * emits slugs; an unrecognised slug is DROPPED and its human label appended to the matching
 * `unmatched*Labels`. An id can therefore never originate from the model — which matters
 * because submit REJECTS unknown ids rather than dropping them.
 */
export interface ProjectBriefParseResult {
  readonly title: string;
  readonly descriptionMarkdown: string;
  readonly tagIds: readonly string[];
  readonly productIds: readonly string[];
  readonly unmatchedTagLabels: readonly string[];
  readonly unmatchedProductLabels: readonly string[];
}
