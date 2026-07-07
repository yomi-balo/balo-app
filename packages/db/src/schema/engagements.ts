import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  pricingMethodEnum,
  proposalCadenceEnum,
  engagementStatusEnum,
  engagementAcceptanceMethodEnum,
} from './enums';
import { companies } from './companies';
import { expertProfiles } from './experts';
import { proposals, requestExpertRelationships } from './request-origination';
import { projectRequests } from './project-requests';
import { users } from './users';
import { engagementMilestones } from './engagement-milestones';
import { timestamps, softDelete } from './helpers';

/**
 * engagements — the durable delivery object and the A6 forward seam (BAL-273 /
 * BAL-287). Kept in its OWN file (a delivery-domain object, separate from the
 * origination spine) so future retainer/embedded staff-aug products visibly
 * extend it.
 *
 * THE SEAM: an active engagement — a pricing method, payment terms, and a
 * billing/approval model — must be expressible WITHOUT a proposal or milestones
 * existing, because a future embedded/retainer product writes through the SAME
 * seam. That is why:
 *
 *   - `source_proposal_id` / `relationship_id` / `project_request_id` are ALL
 *     NULLABLE and ALL `ON DELETE SET NULL` — an engagement can be born with no
 *     origination row at all (a retainer inserts all three NULL), and it SURVIVES
 *     if its source proposal is later deleted (the engagement is the durable
 *     object, not a view over the proposal).
 *   - the commercial terms (`pricing_method`, `price_cents`, `currency`,
 *     `deposit_cents`, `rate_cents`, `cadence`) are SNAPSHOTTED at create, not read
 *     via FK — the engagement carries its own terms and never JOINs a proposal to
 *     know its price.
 *   - the parties (`company_id`, `expert_profile_id`) are the one universal truth
 *     across every engagement product ("a buyer org and a delivering expert") — the
 *     only NOT NULL relations.
 *   - milestones FK `proposals`, not `engagements`, so a retainer (no milestones)
 *     is fully expressible.
 *
 * `billing_model` / `approval_model` are `text` (not enums) deliberately — they are
 * the genuinely forward-looking axes; making them enums now would force an enum
 * migration the moment a retainer needs `'retainer'`/`'auto'`. A6.5 writes
 * `'proposal'`/`'admin_invoice'`. The value space is validated at the WRITE
 * BOUNDARY (the server action that creates engagements), not here — `@balo/db`
 * repos don't validate caller input, the same contract as rich-text sanitisation
 * ("sanitisation happens in the web caller, never in @balo/db").
 */
export const engagements = pgTable(
  'engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // ── Parties (always required — every engagement is a client↔expert deal) ──
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),

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
    currency: text('currency').notNull().default('aud'),
    depositCents: integer('deposit_cents'),
    rateCents: integer('rate_cents'),
    cadence: proposalCadenceEnum('cadence'),

    // ── Billing / approval model (the "how money flows" notion) ──
    billingModel: text('billing_model').notNull().default('proposal'),
    approvalModel: text('approval_model').notNull().default('admin_invoice'),

    status: engagementStatusEnum('status').notNull().default('active'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),

    // ── Delivery lifecycle (BAL-330). ALL additive columns below are NULLABLE with
    //    NO default → backfill-safe on the non-empty prod engagements table. ──

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
    // "completed on" display derives from `accepted_at` where status='completed'.
    // A duplicate `completed_at` would only invite the two to drift.
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
    ...softDelete,
  },
  (t) => [
    index('engagement_company_idx').on(t.companyId),
    index('engagement_expert_idx').on(t.expertProfileId),
    index('engagement_source_proposal_idx').on(t.sourceProposalId),
    index('engagement_relationship_idx').on(t.relationshipId),
    index('engagement_request_idx').on(t.projectRequestId),
    // At most ONE live engagement per project_request — defence-in-depth behind
    // `materializeFromKickoff`'s status-guard-under-lock (BAL-291 review follow-up):
    // any FUTURE writer that inserts an engagement outside that method still can't
    // duplicate a request's engagement. PARTIAL on both predicates deliberately:
    //   - `project_request_id IS NOT NULL` keeps the seam open — a retainer/embedded
    //     product writes engagements with NO origination row (all-NULL provenance),
    //     and multiple NULL `project_request_id` rows must coexist.
    //   - `deleted_at IS NULL` so a soft-deleted engagement never blocks re-creating
    //     one for the same request (non-partial unique + soft-delete = silent
    //     re-create failure).
    uniqueIndex('engagement_request_unique_idx')
      .on(t.projectRequestId)
      .where(sql`${t.projectRequestId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check('engagement_price_cents_nonneg', sql`${t.priceCents} >= 0`),
    check(
      'engagement_deposit_cents_nonneg',
      sql`${t.depositCents} IS NULL OR ${t.depositCents} >= 0`
    ),
    check('engagement_rate_cents_nonneg', sql`${t.rateCents} IS NULL OR ${t.rateCents} >= 0`),
    // Serves the D7 auto-accept sweep (status='pending_acceptance' AND
    // completion_requested_at <= cutoff → listPendingAutoAccept). The predicate
    // references ONLY deleted_at — NEVER the 'pending_acceptance' enum literal
    // (that would be the ADD-VALUE one-tx migration hazard, plan §5). The sweep
    // filters on the `status` COLUMN at query time, which is safe.
    index('engagement_status_completion_requested_idx')
      .on(t.status, t.completionRequestedAt)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementsRelations = relations(engagements, ({ one, many }) => ({
  company: one(companies, {
    fields: [engagements.companyId],
    references: [companies.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [engagements.expertProfileId],
    references: [expertProfiles.id],
  }),
  sourceProposal: one(proposals, {
    fields: [engagements.sourceProposalId],
    references: [proposals.id],
  }),
  relationship: one(requestExpertRelationships, {
    fields: [engagements.relationshipId],
    references: [requestExpertRelationships.id],
  }),
  projectRequest: one(projectRequests, {
    fields: [engagements.projectRequestId],
    references: [projectRequests.id],
  }),
  // Retrospective actor attribution for the delivery workspace (BAL-331): the
  // client person who accepted (NULL on the D7 auto path) and the client person
  // who requested changes. `restrict` FKs on both columns preserve the attribution.
  acceptedBy: one(users, {
    fields: [engagements.acceptedByUserId],
    references: [users.id],
  }),
  changeRequestedBy: one(users, {
    fields: [engagements.changeRequestedByUserId],
    references: [users.id],
  }),
  milestones: many(engagementMilestones),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;
