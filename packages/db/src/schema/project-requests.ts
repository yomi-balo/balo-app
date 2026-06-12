import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  projectRequestStatusEnum,
  projectRequestSourceEnum,
  projectRequestSendToEnum,
} from './enums';
import { companies } from './companies';
import { expertProfiles } from './experts';
import { users } from './users';
import { products } from './verticals';
import { projectTags } from './project-tags';
import { requestExpertRelationships } from './request-origination';
import { timestamps, softDelete } from './helpers';

/**
 * Project requests — a buyer (company) sends a scoped project brief either
 * DIRECTLY to a target expert (`send_to = 'direct'`, from their public profile)
 * or to the platform to be MATCHED to an expert (`send_to = 'match'`, no expert
 * yet). Greenfield for BAL-253; realigned to Bubble parity + ADR-1022 rich text
 * in BAL-259.
 *
 * `description` holds server-side-sanitised HTML. Optional project-type tags,
 * products, and uploaded documents live in dedicated junction/child tables
 * below (one transactional multi-insert at submit).
 *
 * Designed so Quick Starts (BAL-254/255) instantiate the SAME row via
 * `source = 'quickstart'` — no second table, no fork.
 */
export const projectRequests = pgTable(
  'project_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Buyer org that owns the request.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    // Target expert. NULLABLE — `match` mode has no expert (the routing CHECK
    // below keeps the two modes mutually exclusive).
    expertProfileId: uuid('expert_profile_id').references(() => expertProfiles.id, {
      onDelete: 'cascade',
    }),

    // Creator (the user who submitted). Preserve attribution → restrict.
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // Routing: 'direct' (this expert) | 'match' (platform finds one). Default
    // 'direct' (the public-profile entry path).
    sendTo: projectRequestSendToEnum('send_to').notNull().default('direct'),

    status: projectRequestStatusEnum('status').notNull().default('requested'),
    source: projectRequestSourceEnum('source').notNull().default('manual'),

    title: text('title').notNull(),
    description: text('description').notNull(),

    // Optional budget range. Money as integer minor units + currency, mirroring
    // `proposals` (request-origination.ts) and `expert_profiles.rate_cents` —
    // never floats. Both amounts NULLABLE: either side may be omitted for a
    // one-sided ("from"/"up to") or empty budget. Currency NOT NULL DEFAULT 'aud'
    // (the platform default; a future picker fills it without a second migration).
    budgetMinCents: integer('budget_min_cents'),
    budgetMaxCents: integer('budget_max_cents'),
    budgetCurrency: text('budget_currency').notNull().default('aud'),

    // Optional free-text timeline — genuinely unstructured business input
    // ("Target go-live: end of Q3"), not a date. NULLABLE.
    timeline: text('timeline'),

    // Reserved cap — per-request max number of proposals. NULL = no cap.
    // Enforcement intentionally deferred (column only, no logic anywhere yet).
    proposalCap: integer('proposal_cap'),

    // Reserved for BAL-254/255 (a quick-start/package origin). No FK yet — the
    // packages table does not exist; add the FK in the package work to avoid a
    // forward dependency. Typed uuid so the future FK is a no-op type change.
    packageId: uuid('package_id'),

    // ── Kickoff gate state (BAL-291 / A6.5) ──────────────────────────────────
    // Two of the three kickoff gates are persisted here; the third (admin "settle
    // invoice + approve") is COLLAPSED into the status transition itself — the admin
    // gate is `done ⟺ status === 'kickoff_approved'`, so it needs no column. These
    // live on the request (not `engagements`) because the board renders during
    // `accepted`, BEFORE the engagement is materialised at approval. Nullable,
    // no default — NULL = outstanding; a timestamp is the "confirmed at" audit.
    clientBillingConfirmedAt: timestamp('client_billing_confirmed_at', { withTimezone: true }),
    expertTermsConfirmedAt: timestamp('expert_terms_confirmed_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('project_requests_company_idx').on(table.companyId),
    index('project_requests_expert_profile_idx').on(table.expertProfileId),
    index('project_requests_created_by_idx').on(table.createdByUserId),
    // Soft-delete-aware composite for the expert's future "incoming requests"
    // inbox: expert + status, partial predicate on live rows.
    index('project_requests_expert_status_idx')
      .on(table.expertProfileId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    // Routing invariant — two-sided so the modes are mutually exclusive at the
    // DB layer: direct ⇒ an expert is set; match ⇒ no expert leaks in.
    check(
      'project_requests_direct_requires_expert',
      sql`(${table.sendTo} = 'direct' AND ${table.expertProfileId} IS NOT NULL)
          OR (${table.sendTo} = 'match' AND ${table.expertProfileId} IS NULL)`
    ),
    // Budget money invariants (mirror proposals' `proposal_price_cents_nonneg`):
    // each amount non-negative when present, and a coherent range when BOTH are
    // present (either side may be NULL for a one-sided/empty budget).
    check(
      'project_requests_budget_min_nonneg',
      sql`${table.budgetMinCents} IS NULL OR ${table.budgetMinCents} >= 0`
    ),
    check(
      'project_requests_budget_max_nonneg',
      sql`${table.budgetMaxCents} IS NULL OR ${table.budgetMaxCents} >= 0`
    ),
    check(
      'project_requests_budget_range',
      sql`${table.budgetMinCents} IS NULL OR ${table.budgetMaxCents} IS NULL
          OR ${table.budgetMaxCents} >= ${table.budgetMinCents}`
    ),
  ]
);

/**
 * project_request_tags — junction to the project-type taxonomy (project_tags).
 * `projectRequestId` CASCADE (children die with the request); `projectTagId`
 * RESTRICT (never hard-delete a tag in use — deactivate via isActive/deletedAt).
 */
export const projectRequestTags = pgTable(
  'project_request_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    projectTagId: uuid('project_tag_id')
      .notNull()
      .references(() => projectTags.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('project_request_tag_unique_idx').on(t.projectRequestId, t.projectTagId),
    index('project_request_tag_request_idx').on(t.projectRequestId),
    index('project_request_tag_tag_idx').on(t.projectTagId),
  ]
);

/**
 * project_request_products — junction to the existing products taxonomy. Same
 * onDelete rationale as project_request_tags: request CASCADE, product RESTRICT.
 */
export const projectRequestProducts = pgTable(
  'project_request_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('project_request_product_unique_idx').on(t.projectRequestId, t.productId),
    index('project_request_product_request_idx').on(t.projectRequestId),
    index('project_request_product_product_idx').on(t.productId),
  ]
);

/**
 * project_request_documents — child rows for R2-uploaded attachments. A child
 * table (not jsonb) so each doc gets a real id for per-row soft-delete and R2
 * cleanup audit; the unique index on r2_key enforces "one R2 object referenced
 * once"; sizeBytes/contentType stay queryable for future quotas/analytics.
 */
export const projectRequestDocuments = pgTable(
  'project_request_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectRequestId: uuid('project_request_id')
      .notNull()
      .references(() => projectRequests.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('project_request_document_key_idx').on(t.r2Key),
    index('project_request_document_request_idx').on(t.projectRequestId),
  ]
);

export const projectRequestsRelations = relations(projectRequests, ({ one, many }) => ({
  company: one(companies, {
    fields: [projectRequests.companyId],
    references: [companies.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [projectRequests.expertProfileId],
    references: [expertProfiles.id],
  }),
  createdByUser: one(users, {
    fields: [projectRequests.createdByUserId],
    references: [users.id],
  }),
  tags: many(projectRequestTags),
  products: many(projectRequestProducts),
  documents: many(projectRequestDocuments),
  relationships: many(requestExpertRelationships),
}));

export const projectRequestTagsRelations = relations(projectRequestTags, ({ one }) => ({
  projectRequest: one(projectRequests, {
    fields: [projectRequestTags.projectRequestId],
    references: [projectRequests.id],
  }),
  projectTag: one(projectTags, {
    fields: [projectRequestTags.projectTagId],
    references: [projectTags.id],
  }),
}));

export const projectRequestProductsRelations = relations(projectRequestProducts, ({ one }) => ({
  projectRequest: one(projectRequests, {
    fields: [projectRequestProducts.projectRequestId],
    references: [projectRequests.id],
  }),
  product: one(products, {
    fields: [projectRequestProducts.productId],
    references: [products.id],
  }),
}));

export const projectRequestDocumentsRelations = relations(projectRequestDocuments, ({ one }) => ({
  projectRequest: one(projectRequests, {
    fields: [projectRequestDocuments.projectRequestId],
    references: [projectRequests.id],
  }),
}));

export type ProjectRequest = typeof projectRequests.$inferSelect;
export type NewProjectRequest = typeof projectRequests.$inferInsert;
export type ProjectRequestTag = typeof projectRequestTags.$inferSelect;
export type NewProjectRequestTag = typeof projectRequestTags.$inferInsert;
export type ProjectRequestProduct = typeof projectRequestProducts.$inferSelect;
export type NewProjectRequestProduct = typeof projectRequestProducts.$inferInsert;
export type ProjectRequestDocument = typeof projectRequestDocuments.$inferSelect;
export type NewProjectRequestDocument = typeof projectRequestDocuments.$inferInsert;

// NOTE: No `createInsertSchema` Zod export here. `drizzle-zod` is not a
// dependency of @balo/db and no existing schema file uses it — input validation
// for project requests lives in the Server Action's own Zod schema
// (apps/web/.../_actions/schemas.ts). Title/description constraints (min/max)
// are enforced there. The `notNull()` columns + DB-level types + the routing
// CHECK are the persistence-layer contract.
