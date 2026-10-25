import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  check,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// TYPE-ONLY. `@balo/db` depends on `@balo/shared`, never the reverse (memory
// `reference_balo_db_client_bundle_footgun`) — the `project-brief-parses.ts` posture exactly.
import type { ProposalDraftOutput } from '@balo/shared/project-requests';
import { proposalDraftGenerationStatusEnum } from './enums';
import { requestExpertRelationships } from './request-origination';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * proposal_draft_generations (BAL-611) — ONE ROW PER AI DRAFT OF A PROPOSAL'S OVERVIEW AND
 * MILESTONES, at most one live row per relationship. It is the async handoff between the web
 * start action that opens it, the BullMQ worker that calls the model, and the composer that
 * polls for the answer.
 *
 * ── (1) ONE AUTOMATIC GENERATION PER RELATIONSHIP, ENFORCED HERE ──────────────────────
 * `proposal_draft_generations_relationship_live_idx` is a partial UNIQUE on `relationship_id`
 * over live rows. The start action is idempotent through it: a second start (another tab, a
 * StrictMode double mount, a revisit) gets the existing row back from
 * `createOrGetForRelationship` and makes no second model call. A soft-deleted row frees the
 * slot.
 *
 * ── (2) STATE IS A `status` LABEL, PINNED TO THREE NULL FACTS BY CHECK ────────────────
 *   pending   ⇔ `completed_at IS NULL`
 *   succeeded ⇔ `output IS NOT NULL`
 *   failed    ⇔ `failure_reason IS NOT NULL`
 * Each is a biconditional CHECK over a NOT NULL enum and an `IS [NOT] NULL` test, so it is
 * total (no three-valued-logic hole), and the three together make a contradictory row
 * unrepresentable. A timeout is not stored: a `pending` row older than `DRAFT_DEADLINE_MS`
 * (`@balo/shared/project-requests`) is derived as failed when the web reads it, so no reaper
 * job exists. See the enum-literal caveat on `proposalDraftGenerationStatusEnum`.
 *
 * ── (3) `output` IS RAW MODEL HTML, NEVER SENT TO A BROWSER AS STORED ─────────────────
 * The worker stores the model's schema-validated answer verbatim. The web poll sanitises it
 * before returning it (overview → `sanitizeProposalOverviewHtml`, each milestone description →
 * `sanitizeProjectHtml`). Nothing else reads this column.
 *
 * ── (4) FOREIGN KEYS ──────────────────────────────────────────────────────────────────
 * `relationship_id` CASCADES: the row is working data about one relationship's composer and
 * has no meaning without it. `requested_by_user_id` RESTRICTS, the schema's dominant `users`
 * reference. It adds no new blocker to a user hard delete: the requester is the relationship's
 * expert, and `expert_profiles.user_id` already refuses one.
 *
 * ── (5) NO RLS — A KNOWING DEVIATION, RECORDED ────────────────────────────────────────
 * NOT ONE schema file in this package CALLS `.enableRLS()` or `pgPolicy()`. Balo authenticates
 * with WorkOS + iron-session, so `auth.uid()` is always null and a Supabase-shaped policy would
 * be decoration; every reader is the admin `db` client (which bypasses RLS anyway) and the
 * boundary is the APPLICATION layer. Here that is the repository's scoped reads:
 * `findForRequester` puts the generation id, the relationship AND the requesting user in the
 * WHERE (the web poll), and `findForRelationshipExpert` joins through to
 * `expert_profiles.user_id` (the api re-check). ⚠ This is a conscious deviation from the
 * `drizzle-schema` skill, which lists "Forgetting RLS on new tables" under What NOT to Do —
 * FLAG IT IN THE PR BODY, as `project-brief-parses.ts`, `admin-alerts.ts` and
 * `internal-notes.ts` do.
 *
 * ── (6) NO `relations()` BLOCK ────────────────────────────────────────────────────────
 * Nothing needs a relational `with:`, and hydrating `users` for `requested_by_user_id` would
 * pull `workos_id` and the full PII row (memory
 * `reference_drizzle_with_hydration_leaks_secrets`).
 */
export const proposalDraftGenerations = pgTable(
  'proposal_draft_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The relationship whose composer this draft fills. CASCADE — see (4). The FK lives in the
     * table extras with an explicit name: Drizzle's default would exceed Postgres' 63-character
     * identifier limit and be silently truncated.
     */
    relationshipId: uuid('relationship_id').notNull(),

    /**
     * The expert who opened the composer. Scopes the web poll's read, and counts toward
     * `MAX_PROPOSAL_DRAFTS_PER_HOUR`. RESTRICT — see (4).
     */
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * pending → succeeded | failed. Both terminal writes compare-and-set on `pending`, so a
     * duplicate BullMQ delivery cannot overwrite a terminal row.
     */
    status: proposalDraftGenerationStatusEnum('status').notNull().default('pending'),

    /** The validated model answer, raw. NULL ⇔ not succeeded. See (3). */
    output: jsonb('output').$type<ProposalDraftOutput>(),

    /**
     * A FIXED literal from `PROPOSAL_DRAFT_FAILURE_REASONS` (`@balo/shared/project-requests`).
     * ⚠ NEVER A MODEL OR VENDOR MESSAGE. `text`, not a pgEnum: the write sites take the typed
     * union, Postgres does not check the value. NULL ⇔ not failed.
     */
    failureReason: text('failure_reason'),

    /** When the row reached a terminal status. NULL ⇔ pending. */
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // ── Provenance + budget observability (ADR-1013 audit parity) ──
    /** All four are NULL on a row that never reached the model (e.g. `enqueue_failed`). */
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * ⚠⚠ ONE LIVE GENERATION PER RELATIONSHIP — see (1). The arbiter of
     * `createOrGetForRelationship`'s upsert, which must restate this predicate inline
     * (memory `reference_pg_partial_index_arbiter_param_42p10`). Predicates on `deleted_at`
     * only — never an enum literal (house rule). Also serves `findLiveByRelationship` and
     * `hasSucceededForRelationship`.
     */
    uniqueIndex('proposal_draft_generations_relationship_live_idx')
      .on(t.relationshipId)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * The `relationship_id` cascade FK's delete-time scan. ⚠ NOT PARTIAL: the scan Postgres
     * runs on a relationship delete ignores `deleted_at`, so the partial unique above cannot
     * serve it (the `project_brief_parses_company_idx` reasoning).
     */
    index('proposal_draft_generations_relationship_idx').on(t.relationshipId),

    foreignKey({
      columns: [t.relationshipId],
      foreignColumns: [requestExpertRelationships.id],
      name: 'proposal_draft_generations_relationship_fk',
    }).onDelete('cascade'),

    /**
     * The `requested_by_user_id` FK, and `countCreatedSince`'s
     * `(requested_by_user_id, created_at >= …)` hourly count. Not partial, so it also serves
     * the FK's delete-time scan.
     */
    index('proposal_draft_generations_requester_idx').on(t.requestedByUserId, t.createdAt),

    /** succeeded ⇔ an output. Total: `status` is NOT NULL and `IS NOT NULL` never yields NULL. */
    check(
      'proposal_draft_generations_output_iff_succeeded',
      sql`(${t.status} = 'succeeded') = (${t.output} IS NOT NULL)`
    ),

    /** failed ⇔ a failure reason. Total, for the same reason. */
    check(
      'proposal_draft_generations_reason_iff_failed',
      sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`
    ),

    /**
     * pending ⇔ not completed. Total. With the two above it is what makes every terminal
     * write set `status`, its outcome and `completed_at` in ONE statement.
     */
    check(
      'proposal_draft_generations_completed_iff_terminal',
      sql`(${t.status} = 'pending') = (${t.completedAt} IS NULL)`
    ),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type ProposalDraftGeneration = typeof proposalDraftGenerations.$inferSelect;
export type NewProposalDraftGeneration = typeof proposalDraftGenerations.$inferInsert;
