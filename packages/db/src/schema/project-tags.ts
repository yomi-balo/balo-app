import { pgTable, uuid, text, boolean, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { verticals } from './verticals';
import { timestamps, softDelete } from './helpers';

/**
 * Project-type tags — a vertical-scoped taxonomy of project intents (e.g. "New
 * Salesforce Implementation", "Data Migration / Cleanup") grouped into themes.
 * Mirrors the BAL-260 categories→products pattern (vertical-scoped FK, name,
 * slug, sortOrder, isActive) — see verticals.ts.
 *
 * Divergence from the legacy reference-data tables (verticals/categories/
 * products use `...timestamps` only): these tables ALSO carry `...softDelete`
 * per the CLAUDE.md "every table gets deleted_at" rule. Every read therefore
 * guards on `isNull(deletedAt)`.
 */
export const projectTagGroups = pgTable(
  'project_tag_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .notNull()
      .references(() => verticals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('project_tag_group_vertical_slug_idx').on(t.verticalId, t.slug),
    index('project_tag_group_vertical_id_idx').on(t.verticalId),
    index('project_tag_group_sort_idx').on(t.verticalId, t.sortOrder),
  ]
);

export const projectTags = pgTable(
  'project_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .notNull()
      .references(() => verticals.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => projectTagGroups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    uniqueIndex('project_tag_vertical_slug_idx').on(t.verticalId, t.slug),
    index('project_tag_group_id_idx').on(t.groupId),
    index('project_tag_vertical_id_idx').on(t.verticalId),
    index('project_tag_sort_idx').on(t.groupId, t.sortOrder),
  ]
);

export const projectTagGroupsRelations = relations(projectTagGroups, ({ one, many }) => ({
  vertical: one(verticals, { fields: [projectTagGroups.verticalId], references: [verticals.id] }),
  tags: many(projectTags),
}));

export const projectTagsRelations = relations(projectTags, ({ one }) => ({
  vertical: one(verticals, { fields: [projectTags.verticalId], references: [verticals.id] }),
  group: one(projectTagGroups, {
    fields: [projectTags.groupId],
    references: [projectTagGroups.id],
  }),
}));

export type ProjectTagGroup = typeof projectTagGroups.$inferSelect;
export type NewProjectTagGroup = typeof projectTagGroups.$inferInsert;
export type ProjectTag = typeof projectTags.$inferSelect;
export type NewProjectTag = typeof projectTags.$inferInsert;
