import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const verticals = pgTable('verticals', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  description: text('description'),
  logoUrl: text('logo_url'),

  isActive: boolean('is_active').default(true).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),

    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),

    sortOrder: integer('sort_order').default(0),
    isActive: boolean('is_active').default(true).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('skill_vertical_slug_idx').on(table.verticalId, table.slug),
  })
);

export const supportTypes = pgTable('support_types', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  description: text('description'),
  iconUrl: text('icon_url'),

  sortOrder: integer('sort_order').default(0),
  isActive: boolean('is_active').default(true).notNull(),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const certifications = pgTable(
  'certifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),

    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    logoUrl: text('logo_url'),
    verificationUrl: text('verification_url'),

    isActive: boolean('is_active').default(true).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('cert_vertical_slug_idx').on(table.verticalId, table.slug),
  })
);

// Relations
export const verticalsRelations = relations(verticals, ({ many }) => ({
  skills: many(skills),
  certifications: many(certifications),
}));

export const skillsRelations = relations(skills, ({ one }) => ({
  vertical: one(verticals, {
    fields: [skills.verticalId],
    references: [verticals.id],
  }),
}));

export const certificationsRelations = relations(certifications, ({ one }) => ({
  vertical: one(verticals, {
    fields: [certifications.verticalId],
    references: [verticals.id],
  }),
}));

export type Vertical = typeof verticals.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type SupportType = typeof supportTypes.$inferSelect;
export type Certification = typeof certifications.$inferSelect;
