import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { expertIndustries } from './experts';

export const industries = pgTable(
  'industries',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    slug: text('slug').notNull(),

    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: uniqueIndex('industries_slug_idx').on(table.slug),
    sortIdx: index('industries_sort_idx').on(table.sortOrder),
  })
);

// Relations
export const industriesRelations = relations(industries, ({ many }) => ({
  expertIndustries: many(expertIndustries),
}));

export type Industry = typeof industries.$inferSelect;
export type NewIndustry = typeof industries.$inferInsert;
