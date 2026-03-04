import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
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

export const skillCategories = pgTable(
  'skill_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id, { onDelete: 'cascade' })
      .notNull(),

    name: text('name').notNull(),
    slug: text('slug').notNull(),
    iconUrl: text('icon_url'),

    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('skill_cat_vertical_slug_idx').on(table.verticalId, table.slug),
    verticalIdx: index('skill_cat_vertical_id_idx').on(table.verticalId),
    sortIdx: index('skill_cat_sort_idx').on(table.verticalId, table.sortOrder),
  })
);

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),
    categoryId: uuid('category_id').references(() => skillCategories.id, { onDelete: 'set null' }),

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
    categoryIdx: index('skill_category_id_idx').on(table.categoryId),
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

export const certificationCategories = pgTable(
  'certification_categories',
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
    slugIdx: uniqueIndex('cert_cat_slug_idx').on(table.slug),
    sortIdx: index('cert_cat_sort_idx').on(table.sortOrder),
  })
);

export const certifications = pgTable(
  'certifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),
    categoryId: uuid('category_id').references(() => certificationCategories.id, {
      onDelete: 'set null',
    }),

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
    categoryIdx: index('cert_category_id_idx').on(table.categoryId),
  })
);

// Relations
export const verticalsRelations = relations(verticals, ({ many }) => ({
  skills: many(skills),
  skillCategories: many(skillCategories),
  certifications: many(certifications),
}));

export const skillCategoriesRelations = relations(skillCategories, ({ one, many }) => ({
  vertical: one(verticals, {
    fields: [skillCategories.verticalId],
    references: [verticals.id],
  }),
  skills: many(skills),
}));

export const skillsRelations = relations(skills, ({ one }) => ({
  vertical: one(verticals, {
    fields: [skills.verticalId],
    references: [verticals.id],
  }),
  category: one(skillCategories, {
    fields: [skills.categoryId],
    references: [skillCategories.id],
  }),
}));

export const certificationCategoriesRelations = relations(certificationCategories, ({ many }) => ({
  certifications: many(certifications),
}));

export const certificationsRelations = relations(certifications, ({ one }) => ({
  vertical: one(verticals, {
    fields: [certifications.verticalId],
    references: [verticals.id],
  }),
  category: one(certificationCategories, {
    fields: [certifications.categoryId],
    references: [certificationCategories.id],
  }),
}));

export type Vertical = typeof verticals.$inferSelect;
export type NewVertical = typeof verticals.$inferInsert;
export type SkillCategory = typeof skillCategories.$inferSelect;
export type NewSkillCategory = typeof skillCategories.$inferInsert;
export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
export type SupportType = typeof supportTypes.$inferSelect;
export type NewSupportType = typeof supportTypes.$inferInsert;
export type CertificationCategory = typeof certificationCategories.$inferSelect;
export type NewCertificationCategory = typeof certificationCategories.$inferInsert;
export type Certification = typeof certifications.$inferSelect;
export type NewCertification = typeof certifications.$inferInsert;
