import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagements } from './engagements';
import { engagementMilestones } from './engagement-milestones';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * project_change_requests — one row per client "Request changes" ROUND on a project
 * (BAL-621). Written in the same transaction as the `pending_acceptance → active` flip
 * (`projectEngagementsRepository.requestChanges`), so every round is kept, in order —
 * the legacy `project_engagements.change_request_*` columns are only the latest-round
 * projection, and `requestCompletion` nulls the note, so THIS table is the durable
 * history every "previous round" surface reads.
 *
 * FK TARGET IS THE SUPERTYPE (`engagements.id`), mirroring `engagement_milestones`: a
 * round CASCADES with its engagement. Rounds are PROJECT-only by writer, not by
 * constraint — the only writer locks the project pair first.
 *
 * ACTOR-FK INDEXING — `requested_by_user_id` is DELIBERATELY UNINDEXED, the same ruling
 * as the actor FKs on `project_engagements`: nothing filters or joins on it (it is
 * hydrated by id through a `one` relation over the `users` PK), and users are never
 * hard-deleted, so the `restrict` FK's delete-time scan never runs.
 *
 * FK INDEXING OF THE PARENT LINKS — the partial indexes below LEAD with the FK column
 * (`engagement_id` here, `change_request_id` on the tag table), so live reads are
 * served; a CASCADE scan only happens on a hard delete, which no repository performs
 * (soft delete everywhere). Same posture as `expression_of_interest_relationship_idx`.
 *
 * NO RLS — A KNOWING DEVIATION, RECORDED. NOT ONE schema file in this package CALLS
 * `.enableRLS()` or `pgPolicy()`. Balo authenticates with WorkOS + iron-session, so
 * `auth.uid()` is always null and a Supabase-shaped policy would be decoration; every
 * reader is the admin `db` client (which bypasses RLS anyway) and the boundary is the
 * application layer (ADR-1029 — the workspace read and the request-changes write both
 * gate on membership capabilities). ⚠ This is a conscious deviation from the
 * `drizzle-schema` skill, which lists "Forgetting RLS on new tables" under What NOT to
 * Do — flagged in the PR body, as `admin-alerts.ts` and `internal-notes.ts` both do.
 */
export const projectChangeRequests = pgTable(
  'project_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Parent engagement — CASCADE (rounds die with the engagement).
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    /** The client's feedback for this round. Emptiness is validated at the web boundary. */
    note: text('note').notNull(),

    // The client person who sent the work back. RESTRICT preserves attribution.
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * When the round was raised — the round ORDER key. The writer sets it to the same
     * instant it writes to `project_engagements.change_requested_at`, so the legacy
     * projection and the latest round never disagree.
     */
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // The workspace graph reads an engagement's live rounds oldest → newest. Predicate
    // references ONLY deleted_at.
    index('project_change_request_engagement_requested_idx')
      .on(t.engagementId, t.requestedAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

/**
 * project_change_request_milestones — the OPTIONAL milestone tags on a round (BAL-621).
 * Zero rows = an untagged round ("the expert works out what needs to change").
 *
 * SAME-ENGAGEMENT is enforced by the writer, not by a constraint: `requestChanges`
 * locks the tagged ids as LIVE milestones of the round's engagement under the
 * engagement lock and rolls the whole round back on any mismatch
 * (`ChangeRequestMilestoneMismatchError`).
 *
 * Both parent FKs CASCADE: a tag dies with its round or with its milestone (a
 * hard-deleted milestone leaves nothing to point at; a SOFT-deleted one keeps its tag
 * row and is filtered out by the readers).
 *
 * NO RLS — the same recorded deviation as `project_change_requests` above.
 */
export const projectChangeRequestMilestones = pgTable(
  'project_change_request_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    changeRequestId: uuid('change_request_id')
      .notNull()
      .references(() => projectChangeRequests.id, { onDelete: 'cascade' }),

    engagementMilestoneId: uuid('engagement_milestone_id')
      .notNull()
      .references(() => engagementMilestones.id, { onDelete: 'cascade' }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // A milestone is tagged at most once per round. PARTIAL on live rows so a
    // soft-deleted tag never blocks re-tagging the same pair (memory
    // `reference_softdelete_nonpartial_unique_recreate`). Predicate references ONLY
    // deleted_at.
    uniqueIndex('project_change_request_milestone_pair_uq')
      .on(t.changeRequestId, t.engagementMilestoneId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('project_change_request_milestone_milestone_idx').on(t.engagementMilestoneId),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const projectChangeRequestsRelations = relations(projectChangeRequests, ({ one, many }) => ({
  engagement: one(engagements, {
    fields: [projectChangeRequests.engagementId],
    references: [engagements.id],
  }),
  // ⚠ Hydrate with an explicit `columns:` projection — a bare `requestedBy: true`
  // pulls `workos_id` and the full PII row (memory
  // `reference_drizzle_with_hydration_leaks_secrets`).
  requestedBy: one(users, {
    fields: [projectChangeRequests.requestedByUserId],
    references: [users.id],
  }),
  taggedMilestones: many(projectChangeRequestMilestones),
}));

export const projectChangeRequestMilestonesRelations = relations(
  projectChangeRequestMilestones,
  ({ one }) => ({
    changeRequest: one(projectChangeRequests, {
      fields: [projectChangeRequestMilestones.changeRequestId],
      references: [projectChangeRequests.id],
    }),
    milestone: one(engagementMilestones, {
      fields: [projectChangeRequestMilestones.engagementMilestoneId],
      references: [engagementMilestones.id],
    }),
  })
);

// ── Type exports ───────────────────────────────────────────────────────

export type ProjectChangeRequest = typeof projectChangeRequests.$inferSelect;
export type NewProjectChangeRequest = typeof projectChangeRequests.$inferInsert;
export type ProjectChangeRequestMilestone = typeof projectChangeRequestMilestones.$inferSelect;
export type NewProjectChangeRequestMilestone = typeof projectChangeRequestMilestones.$inferInsert;
