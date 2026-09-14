import { pgTable, uuid, text, integer, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// TYPE-ONLY. `@balo/db` already depends on `@balo/shared`; the reverse is forbidden (a client
// component that value-imports `@balo/db` drags the `postgres` driver into the browser bundle),
// which is why the contract lives on the shared side — the `admin-alerts.ts` posture exactly.
import type {
  ProjectBriefParseResult,
  ProjectBriefParseSourceDocument,
} from '@balo/shared/project-requests';
import { companies } from './companies';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * project_brief_parses (BAL-254 / ADR-1022 amendment) — ONE ROW PER "read my documents and
 * draft the brief" attempt. It is the async handoff between the web Server Action that
 * validates the uploads, the BullMQ worker that reads them and calls the model, and the panel
 * that polls for the answer.
 *
 * Rows are EPHEMERAL WORKING DATA, not a record of anything. Nothing downstream reads them
 * after the draft is populated; a submitted `project_requests` row carries no reference back.
 *
 * ── (1) NO `status` COLUMN AND NO pgEnum — D3 ─────────────────────────────────────────
 * State is THREE NULL FACTS, read in this order:
 *   `completed_at IS NULL`      ⇒ pending
 *   `result IS NOT NULL`        ⇒ succeeded
 *   `failure_reason IS NOT NULL`⇒ failed
 * and the two CHECKs below make that reading total. This is the `admin_alerts` precedent —
 * "open" IS `resolved_at IS NULL`, there is no status column there either — and it buys two
 * things. First, every constraint and index predicate stays ENUM-LITERAL-FREE, so nothing here
 * can trip the hazard memory `reference_enum_default_same_tx_migration_hazard` records: a
 * pgEnum created AND referenced inside one migration transaction fails from scratch. Second,
 * a fourth state — `timed_out` — is DERIVED at read from `created_at` + `PARSE_DEADLINE_MS`
 * and never stored, so no reaper job has to exist to keep the column honest.
 * The repository still hands callers a discriminated union, so nothing above the DB notices.
 *
 * ── (2) ⚠⚠ `source_documents` IS THE SECURITY-RELEVANT COLUMN (Ruling A) ──────────────
 * It is populated by the VALIDATED WRITE PATH AND NOTHING ELSE: `startProjectBriefParseAction`
 * writes it once, only after every `r2Key` has been re-derived against
 * `project-documents/{session.companyId}/{session.userId}/`. THE WORKER READS THE KEYS FROM
 * HERE, NEVER FROM A JOB PAYLOAD — which is precisely why the payload is `{ parseId }` alone
 * and why no R2 key ever crosses the wire. A second writer of this column would silently undo
 * the whole gate; there must not be one.
 *
 * ── (3) BOTH FKs CASCADE — `requested_by_user_id` DELIBERATELY SO ─────────────────────
 * A departure from this schema's dominant `users` reference (36 restrict / 6 cascade / 3 set
 * null). `admin_alerts.resolved_by_user_id` takes `restrict` because it is ATTRIBUTION on an
 * audit-shaped row. This is not attribution: it is a transient work item that should disappear
 * with its requester, and a hard user delete (which historically really happens) must not be
 * blocked by an abandoned draft parse. `company_id` cascades for the same reason.
 *
 * ── (4) NO RLS — A KNOWING DEVIATION, RECORDED ────────────────────────────────────────
 * NOT ONE schema file in this package CALLS `.enableRLS()` or `pgPolicy()`. Balo authenticates
 * with WorkOS + iron-session, so `auth.uid()` is always null and a Supabase-shaped policy would
 * be decoration; every reader is the admin `db` client (which bypasses RLS anyway) and the
 * boundary is the APPLICATION layer — here, the four gates in the plan's §12, of which Gate 4
 * lives in this package (`findForOwner` puts `company_id` AND `requested_by_user_id` in the
 * WHERE, so a cross-tenant `parseId` is a not-found). ⚠ This is a conscious deviation from the
 * `drizzle-schema` skill, which lists "Forgetting RLS on new tables" under What NOT to Do —
 * FLAG IT IN THE PR BODY, as `admin-alerts.ts` and `internal-notes.ts` both do.
 *
 * ── (5) NO `relations()` BLOCK ────────────────────────────────────────────────────────
 * Nothing needs a relational `with:`, and hydrating `users` for `requested_by_user_id` would
 * pull `workos_id` and the full PII row (memory
 * `reference_drizzle_with_hydration_leaks_secrets`). If a surface ever needs the requester's
 * name it LEFT JOINs `users` with an explicit three-column projection — but no surface can:
 * the only reader is the requester themselves.
 */
export const projectBriefParses = pgTable(
  'project_brief_parses',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The buyer org. Ephemeral working data ⇒ cascade with the org. Half of Gate 4's WHERE. */
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /**
     * Who asked for the parse. ⚠ CASCADE, NOT RESTRICT — see (3) in the table docblock. Also
     * the other half of Gate 4's WHERE, and the whole of Gate 5's (the API route resolves a
     * `userId` from the bearer and has no `companyId` to check).
     */
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * ⚠⚠ THE SECURITY-RELEVANT COLUMN (Ruling A) — see (2) in the table docblock. Written
     * ONCE, by `startProjectBriefParseAction`, only after every `r2Key` has been validated
     * against `project-documents/{session.companyId}/{session.userId}/`. The worker reads its
     * keys from HERE, never from a job payload.
     *
     * ⚠ HOLDS NO DATES, AND MUST NOT ACQUIRE ONE (memory `reference_jsonb_date_type_lie`: a
     * `Date` written into jsonb reads back as an ISO STRING while still typed `Date`).
     */
    sourceDocuments: jsonb('source_documents').$type<ProjectBriefParseSourceDocument[]>().notNull(),

    /**
     * The parse's answer. NULL ⇒ not succeeded (either still running or failed).
     * ⚠ HOLDS NO DATES either, for the same reason.
     */
    result: jsonb('result').$type<ProjectBriefParseResult>(),

    /**
     * A FIXED literal from `PROJECT_BRIEF_FAILURE_REASONS` (`@balo/shared/project-requests`).
     * ⚠ NEVER A MODEL OR VENDOR MESSAGE. `text`, not a pgEnum — see (1); the write sites
     * validate, Postgres does not, and `narrowToProjectBriefFailureReason` guards every read.
     * Never holds `'timed_out'` or `'not_found'`: those two are derived at read.
     */
    failureReason: text('failure_reason'),

    /**
     * ⚠ THE STATE COLUMN. NULL ⇒ pending. Both `mark*` writes are CAS-guarded on
     * `completed_at IS NULL`, so a duplicate BullMQ delivery cannot overwrite a terminal row.
     */
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // ── Provenance + budget observability (ADR-1013 audit parity; the ticket's cost budget) ──
    /** All six are NULL on a row that never reached the model (e.g. `enqueue_failed`). */
    modelId: text('model_id'),
    modelVersion: text('model_version'),
    promptId: text('prompt_id'),
    promptVersion: text('prompt_version'),
    /** D10 — the budget is ENFORCED as a byte ceiling and OBSERVED as these two counts. */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * THE OWNER READ (Gate 4's `findForOwner`, and `findForRequester`) plus the web-side abuse
     * counter `countCreatedSince`, which is a `(requested_by_user_id, created_at >= …)` count —
     * the `audit_events`-as-counter shape. Partial on `deleted_at IS NULL` because every read
     * in the repository carries that term.
     */
    index('project_brief_parses_owner_idx')
      .on(t.requestedByUserId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * The `company_id` cascade FK's delete-time scan (drizzle-schema skill: index every FK
     * column). ⚠ NOT PARTIAL — the scan Postgres runs on a company delete ignores `deleted_at`,
     * so a partial index could not serve it. Same reasoning as `admin_alerts_resolved_by_idx`.
     * `requested_by_user_id`'s own cascade scan rides the leading column of the owner index
     * above, but that one IS partial — a user hard-delete therefore still seq-scans for
     * soft-deleted rows, which is acceptable on a table this size and on a path this rare.
     */
    index('project_brief_parses_company_idx').on(t.companyId),

    /**
     * ⚠ A ROW IS NEVER BOTH SUCCEEDED AND FAILED. Written as a disjunction of two `IS NULL`
     * tests, so it is TOTAL — no three-valued-logic hole — and ENUM-LITERAL-FREE.
     */
    check(
      'project_brief_parses_single_outcome',
      sql`${t.result} IS NULL OR ${t.failureReason} IS NULL`
    ),

    /**
     * ⚠ COMPLETION ⇔ AN OUTCOME. A completed row carries exactly one (the CHECK above makes it
     * exactly one rather than at least one); a pending row carries neither. Written as an
     * equality of two boolean tests, so it is total, and it is what makes "`completed_at IS
     * NULL` ⇒ pending" a safe reading rather than a convention.
     */
    check(
      'project_brief_parses_completion_carries_an_outcome',
      sql`(${t.completedAt} IS NOT NULL) = (${t.result} IS NOT NULL OR ${t.failureReason} IS NOT NULL)`
    ),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type ProjectBriefParse = typeof projectBriefParses.$inferSelect;
export type NewProjectBriefParse = typeof projectBriefParses.$inferInsert;
