import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  pricingMethodEnum,
  proposalCadenceEnum,
  projectDeliveryStatusEnum,
  engagementAcceptanceMethodEnum,
  engagementTypeEnum,
} from './enums';
import { engagements } from './engagements';
import { proposals, requestExpertRelationships } from './request-origination';
import { projectRequests } from './project-requests';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * project_engagements — the PROJECT subtype of the `engagements` supertype
 * (BAL-417 / ADR-1045 §1). Carries everything that is true of a PROJECT and of
 * nothing else: the snapshotted commercial terms, the origination provenance, and
 * the full delivery lifecycle (BAL-330) including the `pending_acceptance`
 * sub-status.
 *
 * PRIMARY KEY IS `engagement_id`, not a synthetic `id`. This is a deliberate,
 * documented deviation from the `drizzle-schema` "always a UUID `id` PK" rule: a
 * supertype/subtype child is a 1:1 EXTENSION OF ITS PARENT'S IDENTITY, and giving it
 * its own surrogate key would permit two project rows for one engagement — exactly
 * what the split must forbid. It is still a `uuid` PK.
 *
 * TYPE PAIRING IS STRUCTURAL. `engagement_type` is mirrored here, CHECKed to the
 * single value `'project'`, and `(engagement_id, engagement_type)` composite-FKs
 * `engagements(id, engagement_type)` via `engagement_id_type_uq`. Together with the
 * PK that makes three things impossible AT THE DATABASE, not by convention: a project
 * child under a `case`-typed parent, two project children for one parent, and a
 * parent carrying both a project child and a case child. Precedent:
 * `eoi_rel_request_match_fk` (request-origination.ts) — "these composite FKs reject
 * any divergent row from raw writes".
 *
 * THE A6 SEAM, PRESERVED: `source_proposal_id` / `relationship_id` /
 * `project_request_id` are ALL NULLABLE and ALL `ON DELETE SET NULL` — a project can
 * be born with no origination row at all (a retainer-shaped project inserts all three
 * NULL), and it SURVIVES if its source proposal is later deleted (the engagement is
 * the durable object, not a view over the proposal). The commercial terms are
 * SNAPSHOTTED at create, not read via FK.
 *
 * `billing_model` / `approval_model` are `text` (not enums) deliberately — they are
 * the genuinely forward-looking axes; making them enums now would force an enum
 * migration the moment a retainer needs `'retainer'`/`'auto'`. The value space is
 * validated at the WRITE BOUNDARY (the server action), not here — `@balo/db` repos
 * don't validate caller input, the same contract as rich-text sanitisation.
 *
 * ACTOR-FK INDEXING — explicit ruling (BAL-417). The four actor FKs below
 * (`completion_requested_by_user_id`, `accepted_by_user_id`,
 * `change_requested_by_user_id`, `cancelled_by_user_id`) are DELIBERATELY UNINDEXED,
 * inheriting the pre-split status quo on `engagements`. No query in the repo filters
 * or joins on an actor column (they are hydrated by id through a `one` relation, which
 * uses the `users` PK), and `users` rows are never hard-deleted in this application
 * (soft delete via `deleted_at`), so the `restrict` FK's delete-time scan never runs.
 * Adding unused indexes would cost write amplification for zero read benefit. IF A
 * FUTURE TICKET INTRODUCES A HARD USER DELETE, THESE NEED INDEXES AT THAT POINT.
 */
export const projectEngagements = pgTable(
  'project_engagements',
  {
    /**
     * PK and the parent link in one. Declared WITHOUT an inline `.references()` — the
     * composite FK below carries the reference and the `ON DELETE cascade`; declaring
     * both would produce two overlapping FKs.
     */
    engagementId: uuid('engagement_id').primaryKey(),

    /** Mirrored discriminator — pinned to `'project'` by CHECK + composite FK. */
    engagementType: engagementTypeEnum('engagement_type').notNull().default('project'),

    /**
     * The FINE-GRAINED project delivery lifecycle and the SSOT for a project's state.
     * `engagements.status` is its COARSE PROJECTION, written in the SAME transaction
     * by `projectDeliveryToEngagementStatus`. A project in `pending_acceptance`
     * projects to a parent status of `'active'` but is NOT mutable.
     */
    deliveryStatus: projectDeliveryStatusEnum('delivery_status').notNull().default('active'),

    // ── Origination provenance (ALL NULLABLE — the seam's whole point) ──
    // SET NULL (not cascade): the engagement OUTLIVES its origination proposal.
    sourceProposalId: uuid('source_proposal_id').references(() => proposals.id, {
      onDelete: 'set null',
    }),
    relationshipId: uuid('relationship_id').references(() => requestExpertRelationships.id, {
      onDelete: 'set null',
    }),
    projectRequestId: uuid('project_request_id').references(() => projectRequests.id, {
      onDelete: 'set null',
    }),

    // ── Snapshotted commercial terms (copied at create, NOT read via FK) ──
    pricingMethod: pricingMethodEnum('pricing_method').notNull(),
    priceCents: integer('price_cents').notNull(),
    depositCents: integer('deposit_cents'),
    rateCents: integer('rate_cents'),
    cadence: proposalCadenceEnum('cadence'),

    // ── Billing / approval model (the "how money flows" notion) ──
    billingModel: text('billing_model').notNull().default('proposal'),
    approvalModel: text('approval_model').notNull().default('admin_invoice'),

    // Completion request (active → pending_acceptance): the expert asks the client
    // to accept the delivered work. RESTRICT preserves attribution.
    completionRequestedByUserId: uuid('completion_requested_by_user_id').references(
      () => users.id,
      { onDelete: 'restrict' }
    ),
    completionRequestedAt: timestamp('completion_requested_at', { withTimezone: true }),

    // Acceptance (pending_acceptance → completed). NOTE — completed_at SEMANTICS:
    // there is deliberately NO `completed_at` column. `accepted_at` IS the single
    // completion-timestamp source of truth (client OR the D7 auto path); any later
    // "completed on" display derives from `accepted_at` where the delivery status is
    // `completed`. A duplicate `completed_at` would only invite the two to drift.
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }), // NULL for the auto path
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptanceMethod: engagementAcceptanceMethodEnum('acceptance_method'), // NULL until accepted

    // Change request (bounce pending_acceptance → active with a reason).
    changeRequestNote: text('change_request_note'),
    changeRequestedByUserId: uuid('change_requested_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    changeRequestedAt: timestamp('change_requested_at', { withTimezone: true }),

    // Cancellation (active | pending_acceptance → cancelled).
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),

    ...timestamps,
    // SOFT DELETE — the PARENT `engagements.deleted_at` is the SSOT; every read
    // filters on it. The two child `deleted_at` columns are MIRRORS, maintained so
    // the partial UNIQUE / partial indexes on the children are correct. THE ONLY
    // SANCTIONED WRITER IS `softDeleteEngagementTx(tx, engagementId)` in
    // repositories/_shared/engagement-supertype.ts — it stamps parent AND child in
    // one transaction under the parent lock. Never `.set({ deletedAt })` an
    // engagement or an engagement child directly: stamping the parent alone leaves
    // the child's `project_request_id` occupying `project_engagement_request_unique_idx`
    // and silently blocks re-materialisation (reference_softdelete_nonpartial_unique_recreate).
    ...softDelete,
  },
  (t) => [
    index('project_engagement_source_proposal_idx').on(t.sourceProposalId),
    index('project_engagement_relationship_idx').on(t.relationshipId),
    index('project_engagement_request_idx').on(t.projectRequestId),
    // At most ONE live project engagement per project_request — defence-in-depth behind
    // `materializeFromKickoff`'s status-guard-under-lock (BAL-291 review follow-up):
    // any FUTURE writer that inserts an engagement outside that method still can't
    // duplicate a request's engagement. PARTIAL on both predicates deliberately:
    //   - `project_request_id IS NOT NULL` keeps the seam open — a retainer/embedded
    //     product writes engagements with NO origination row (all-NULL provenance),
    //     and multiple NULL `project_request_id` rows must coexist.
    //   - `deleted_at IS NULL` so a soft-deleted engagement never blocks re-creating
    //     one for the same request (non-partial unique + soft-delete = silent
    //     re-create failure). This predicate references THIS table's own `deleted_at`
    //     (a partial index cannot reference the parent's), which is exactly why the
    //     child carries a MIRROR of the parent's soft-delete flag.
    uniqueIndex('project_engagement_request_unique_idx')
      .on(t.projectRequestId)
      .where(sql`${t.projectRequestId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    // Serves the D7 auto-accept sweep (delivery_status='pending_acceptance' AND
    // completion_requested_at <= cutoff → listPendingAutoAccept). The predicate
    // references ONLY deleted_at — NEVER the 'pending_acceptance' enum literal
    // (that would be the ADD-VALUE one-tx migration hazard). The sweep filters on the
    // `delivery_status` COLUMN at query time, which is safe. Because the sweep is now
    // rooted on THIS table, a Case can never be selected by it — structurally.
    index('project_engagement_delivery_completion_idx')
      .on(t.deliveryStatus, t.completionRequestedAt)
      .where(sql`${t.deletedAt} IS NULL`),
    check('project_engagement_type_is_project', sql`${t.engagementType} = 'project'`),
    check('project_engagement_price_cents_nonneg', sql`${t.priceCents} >= 0`),
    check(
      'project_engagement_deposit_cents_nonneg',
      sql`${t.depositCents} IS NULL OR ${t.depositCents} >= 0`
    ),
    check(
      'project_engagement_rate_cents_nonneg',
      sql`${t.rateCents} IS NULL OR ${t.rateCents} >= 0`
    ),
    foreignKey({
      columns: [t.engagementId, t.engagementType],
      foreignColumns: [engagements.id, engagements.engagementType],
      name: 'project_engagement_parent_type_fk',
    }).onDelete('cascade'),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const projectEngagementsRelations = relations(projectEngagements, ({ one }) => ({
  engagement: one(engagements, {
    fields: [projectEngagements.engagementId],
    references: [engagements.id],
  }),
  sourceProposal: one(proposals, {
    fields: [projectEngagements.sourceProposalId],
    references: [proposals.id],
  }),
  relationship: one(requestExpertRelationships, {
    fields: [projectEngagements.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  projectRequest: one(projectRequests, {
    fields: [projectEngagements.projectRequestId],
    references: [projectRequests.id],
  }),
  // Retrospective actor attribution across delivery surfaces (query-time only over
  // existing FK columns; `restrict` FKs preserve attribution): the person who accepted
  // (NULL on the D7 auto path — BAL-331), the person who cancelled (BAL-335 admin
  // oversight), and the person who requested changes (BAL-331). Consumers project
  // name-only (+ platformRole) columns.
  //
  // There is deliberately NO `completionRequestedBy` relation — that column has never
  // had one and no consumer needs it; adding it would be net-new API with zero callers.
  acceptedBy: one(users, {
    fields: [projectEngagements.acceptedByUserId],
    references: [users.id],
  }),
  cancelledBy: one(users, {
    fields: [projectEngagements.cancelledByUserId],
    references: [users.id],
  }),
  changeRequestedBy: one(users, {
    fields: [projectEngagements.changeRequestedByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type ProjectEngagement = typeof projectEngagements.$inferSelect;
export type NewProjectEngagement = typeof projectEngagements.$inferInsert;
