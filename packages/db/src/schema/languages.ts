import { pgTable, uuid, text, integer, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { expertLanguages } from './experts';
import { timestamps } from './helpers';

export const languages = pgTable(
  'languages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    code: text('code').notNull(),
    flagEmoji: text('flag_emoji'),

    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),

    ...timestamps,
  },
  (table) => ({
    codeIdx: uniqueIndex('languages_code_idx').on(table.code),
    sortIdx: index('languages_sort_idx').on(table.sortOrder),
  })
);

// Relations
export const languagesRelations = relations(languages, ({ many }) => ({
  expertLanguages: many(expertLanguages),
}));

export type Language = typeof languages.$inferSelect;
export type NewLanguage = typeof languages.$inferInsert;
