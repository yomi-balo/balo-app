import { pgTable, uuid, integer, text, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { proposalClauseKindEnum } from './enums';
import { engagements } from './engagements';
import { proposalClauses } from './request-origination';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * engagement_clauses — the assumptions, exclusions and additional terms agreed in the accepted
 * proposal, SNAPSHOTTED onto the engagement at kickoff.
 *
 * A snapshot, not a view, exactly as `engagement_milestones` is. Kickoff approval copies the
 * accepted proposal's live `proposal_clauses` here (kind, per-kind order, body, provenance)
 * inside the transaction that materialises the engagement, and records one ADR-1030 audit row,
 * `engagement.clauses_snapshotted`. The rows then OUTLIVE their source:
 * `source_proposal_clause_id` is `ON DELETE SET NULL`.
 *
 * READ-ONLY AFTER KICKOFF. The one writer is `snapshotClausesFromProposalTx`, fenced by
 * `invariants/engagement-clauses-have-one-writer.test.ts`. Change orders never edit these rows
 * (ADR-1057 is unchanged): what a change order alters is shown under the change history, and
 * this table keeps saying what was agreed at the start.
 *
 * FK TARGET IS THE SUPERTYPE (`engagements.id`) with CASCADE, as for milestones.
 *
 * `created_by_user_id` is the approving admin. It is NULLABLE because the rows backfilled by
 * migrations 0128 and 0129 for engagements kicked off before this table existed have no actor; NULL
 * there means "copied by the migration", never a fabricated author. RESTRICT preserves
 * attribution.
 *
 * NO RLS, like `engagement_milestones`: every reader is the admin `db` client and the boundary
 * is the application layer. ⚠ This deviates from the `drizzle-schema` skill, as
 * `engagement-time-entries.ts` records.
 */
export const engagementClauses = pgTable(
  'engagement_clauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    sourceProposalClauseId: uuid('source_proposal_clause_id').references(() => proposalClauses.id, {
      onDelete: 'set null',
    }),
    kind: proposalClauseKindEnum('kind').notNull(),
    // The index within its kind, copied from the source clause. No unique, as for milestones.
    sortOrder: integer('sort_order').notNull(),
    // Plain text, copied verbatim from the source clause.
    body: text('body').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('engagement_clause_engagement_idx').on(t.engagementId),
    // Predicate names only `deleted_at`, never an enum literal (the ADD VALUE hazard).
    index('engagement_clause_order_idx')
      .on(t.engagementId, t.kind, t.sortOrder)
      .where(sql`${t.deletedAt} IS NULL`),
    index('engagement_clause_source_idx').on(t.sourceProposalClauseId),
    index('engagement_clause_created_by_idx').on(t.createdByUserId),
    check('engagement_clause_sort_nonneg', sql`${t.sortOrder} >= 0`),
    check('engagement_clause_body_not_blank', sql`btrim(${t.body}) <> ''`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementClausesRelations = relations(engagementClauses, ({ one }) => ({
  engagement: one(engagements, {
    fields: [engagementClauses.engagementId],
    references: [engagements.id],
  }),
  sourceProposalClause: one(proposalClauses, {
    fields: [engagementClauses.sourceProposalClauseId],
    references: [proposalClauses.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type EngagementClause = typeof engagementClauses.$inferSelect;
export type NewEngagementClause = typeof engagementClauses.$inferInsert;
