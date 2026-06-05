import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { projectRequestStatusEnum, projectRequestSourceEnum } from './enums';
import { companies } from './companies';
import { expertProfiles } from './experts';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * Project requests — a buyer (company) sends a scoped project brief to a target
 * expert from their public profile. Greenfield for BAL-253 (manual entry path).
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

    // Target expert.
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),

    // Creator (the user who submitted). Preserve attribution → restrict.
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    status: projectRequestStatusEnum('status').notNull().default('submitted'),
    source: projectRequestSourceEnum('source').notNull().default('manual'),

    title: text('title').notNull(),
    description: text('description').notNull(),

    focusArea: text('focus_area'),
    budget: text('budget'),
    timeline: text('timeline'),

    // Reserved for BAL-254/255 (a quick-start/package origin). No FK yet — the
    // packages table does not exist; add the FK in the package work to avoid a
    // forward dependency. Typed uuid so the future FK is a no-op type change.
    packageId: uuid('package_id'),

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
  ]
);

export const projectRequestsRelations = relations(projectRequests, ({ one }) => ({
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
}));

export type ProjectRequest = typeof projectRequests.$inferSelect;
export type NewProjectRequest = typeof projectRequests.$inferInsert;

// NOTE: No `createInsertSchema` Zod export here. `drizzle-zod` is not a
// dependency of @balo/db and no existing schema file uses it — input validation
// for project requests lives in the Server Action's own Zod schema
// (apps/web/.../_actions/schemas.ts, BAL-253 §4). Title/description constraints
// (min/max) are enforced there. The `notNull()` columns + DB-level types are the
// persistence-layer contract.
