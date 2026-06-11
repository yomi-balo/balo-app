import { pgTable, uuid, integer, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { pricingMethodEnum, proposalCadenceEnum, engagementStatusEnum } from './enums';
import { companies } from './companies';
import { expertProfiles } from './experts';
import { proposals, requestExpertRelationships } from './request-origination';
import { projectRequests } from './project-requests';
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

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('engagement_company_idx').on(t.companyId),
    index('engagement_expert_idx').on(t.expertProfileId),
    index('engagement_source_proposal_idx').on(t.sourceProposalId),
    index('engagement_relationship_idx').on(t.relationshipId),
    index('engagement_request_idx').on(t.projectRequestId),
    check('engagement_price_cents_nonneg', sql`${t.priceCents} >= 0`),
    check(
      'engagement_deposit_cents_nonneg',
      sql`${t.depositCents} IS NULL OR ${t.depositCents} >= 0`
    ),
    check('engagement_rate_cents_nonneg', sql`${t.rateCents} IS NULL OR ${t.rateCents} >= 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementsRelations = relations(engagements, ({ one }) => ({
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
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Engagement = typeof engagements.$inferSelect;
export type NewEngagement = typeof engagements.$inferInsert;
