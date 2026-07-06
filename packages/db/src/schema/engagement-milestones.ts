import { pgTable, uuid, integer, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagementMilestoneStatusEnum } from './enums';
import { engagements } from './engagements';
import { proposalMilestones } from './request-origination';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * engagement_milestones — the durable, SNAPSHOTTED delivery deliverables of an
 * engagement (BAL-330, first slice of the delivery epic BAL-329).
 *
 * Snapshot, not a view: at kickoff-approval the accepted proposal's live
 * `proposal_milestones` are COPIED into this table (title / description /
 * acceptance criteria / value / estimate + provenance) inside the same
 * transaction that materialises the engagement. The engagement milestone is
 * thereafter the durable delivery object and OUTLIVES its source — the proposal
 * milestone can be deleted (`source_proposal_milestone_id` is `ON DELETE SET
 * NULL`) without destroying the delivery record. A retainer/embedded engagement or
 * a D3 expert-added milestone has NO proposal origin, so the provenance FK is
 * nullable.
 *
 * `value_cents` (Fixed-only) and `estimated_minutes` (T&M-only) mirror
 * `proposal_milestones` exactly and are mutually exclusive by pricing method.
 * `value_cents` is immutable AFTER the snapshot — the repo's `editDescriptive`/
 * `add` signatures type-level EXCLUDE it (the money axis is fixed at materialize).
 *
 * Circular table import (engagements ↔ engagement_milestones) is fine — Drizzle
 * `references()` / `relations()` are lazy thunks (the codebase already cycles
 * proposals ↔ request-origination the same way).
 */
export const engagementMilestones = pgTable(
  'engagement_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Parent engagement — CASCADE (milestones die with the engagement).
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    // Provenance: the proposal milestone this was snapshotted from. NULLABLE
    // (retainer/embedded or a D3 expert-added milestone has no proposal origin).
    // SET NULL: the snapshot OUTLIVES its source (the engagement milestone is the
    // durable delivery object, not a view over the proposal).
    sourceProposalMilestoneId: uuid('source_proposal_milestone_id').references(
      () => proposalMilestones.id,
      { onDelete: 'set null' }
    ),

    // Best-effort ordering (copied from the source milestone's sort_order at
    // snapshot). NO unique on (engagement_id, sort_order) — same rationale as
    // proposal_milestones (reorders transiently collide). Ties broken by id.
    sortOrder: integer('sort_order').notNull(),

    // ── Snapshotted content (copied at materialize; descriptionHtml is sanitised
    //    in the WEB caller — house contract "sanitisation happens in the web
    //    caller, never in @balo/db"). ──
    title: text('title').notNull(),
    descriptionHtml: text('description_html'),
    acceptanceCriteria: text('acceptance_criteria'),
    valueCents: integer('value_cents'), // Fixed-only; nullable; NOT writable post-snapshot.
    estimatedMinutes: integer('estimated_minutes'), // T&M-only; nullable.

    // ── Delivery state ──
    status: engagementMilestoneStatusEnum('status').notNull().default('pending'),
    startedByUserId: uuid('started_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedByUserId: uuid('completed_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completionNote: text('completion_note'),

    // Snapshot author = approving admin (D0); D3 expert-add sets = expert. Nullable
    // to keep the seam open (a future system-inserted milestone need not carry a
    // user). RESTRICT — preserve attribution, never hard-delete an author.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('engagement_milestone_engagement_idx').on(t.engagementId),
    // Status counts per engagement — partial on live rows. Predicate references
    // ONLY deleted_at, never an enum literal (safe against the ADD-VALUE hazard).
    index('engagement_milestone_status_idx')
      .on(t.engagementId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('engagement_milestone_order_idx')
      .on(t.engagementId, t.sortOrder)
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      'engagement_milestone_value_nonneg',
      sql`${t.valueCents} IS NULL OR ${t.valueCents} >= 0`
    ),
    check(
      'engagement_milestone_estimated_minutes_nonneg',
      sql`${t.estimatedMinutes} IS NULL OR ${t.estimatedMinutes} >= 0`
    ),
    check('engagement_milestone_sort_nonneg', sql`${t.sortOrder} >= 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementMilestonesRelations = relations(engagementMilestones, ({ one }) => ({
  engagement: one(engagements, {
    fields: [engagementMilestones.engagementId],
    references: [engagements.id],
  }),
  sourceProposalMilestone: one(proposalMilestones, {
    fields: [engagementMilestones.sourceProposalMilestoneId],
    references: [proposalMilestones.id],
  }),
  startedBy: one(users, {
    fields: [engagementMilestones.startedByUserId],
    references: [users.id],
  }),
  completedBy: one(users, {
    fields: [engagementMilestones.completedByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type EngagementMilestone = typeof engagementMilestones.$inferSelect;
export type NewEngagementMilestone = typeof engagementMilestones.$inferInsert;
