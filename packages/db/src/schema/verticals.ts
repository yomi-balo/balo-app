import { pgTable, uuid, text, boolean, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { timestamps } from './helpers';

export const verticals = pgTable('verticals', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  description: text('description'),
  logoUrl: text('logo_url'),

  isActive: boolean('is_active').default(true).notNull(),

  ...timestamps,
});

export const categories = pgTable(
  'categories',
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

    ...timestamps,
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('category_vertical_slug_idx').on(table.verticalId, table.slug),
    verticalIdx: index('category_vertical_id_idx').on(table.verticalId),
    sortIdx: index('category_sort_idx').on(table.verticalId, table.sortOrder),
  })
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id)
      .notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),

    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),

    sortOrder: integer('sort_order').default(0),
    isActive: boolean('is_active').default(true).notNull(),

    ...timestamps,
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('product_vertical_slug_idx').on(table.verticalId, table.slug),
    categoryIdx: index('product_category_id_idx').on(table.categoryId),
  })
);

export const supportTypes = pgTable(
  'support_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    verticalId: uuid('vertical_id')
      .references(() => verticals.id, { onDelete: 'cascade' })
      .notNull(),

    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),

    sortOrder: integer('sort_order').default(0),
    isActive: boolean('is_active').default(true).notNull(),

    ...timestamps,
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('support_type_vertical_slug_idx').on(table.verticalId, table.slug),
    verticalIdx: index('support_type_vertical_id_idx').on(table.verticalId),
  })
);

export const certificationCategories = pgTable(
  'certification_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    name: text('name').notNull(),
    slug: text('slug').notNull(),

    sortOrder: integer('sort_order').default(0).notNull(),
    isActive: boolean('is_active').default(true).notNull(),

    ...timestamps,
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

    ...timestamps,
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('cert_vertical_slug_idx').on(table.verticalId, table.slug),
    categoryIdx: index('cert_category_id_idx').on(table.categoryId),
  })
);

// Relations
export const verticalsRelations = relations(verticals, ({ many }) => ({
  products: many(products),
  categories: many(categories),
  supportTypes: many(supportTypes),
  certifications: many(certifications),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  vertical: one(verticals, {
    fields: [categories.verticalId],
    references: [verticals.id],
  }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one }) => ({
  vertical: one(verticals, {
    fields: [products.verticalId],
    references: [verticals.id],
  }),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
}));

export const supportTypesRelations = relations(supportTypes, ({ one }) => ({
  vertical: one(verticals, {
    fields: [supportTypes.verticalId],
    references: [verticals.id],
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
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type SupportType = typeof supportTypes.$inferSelect;
export type NewSupportType = typeof supportTypes.$inferInsert;
export type CertificationCategory = typeof certificationCategories.$inferSelect;
export type NewCertificationCategory = typeof certificationCategories.$inferInsert;
export type Certification = typeof certifications.$inferSelect;
export type NewCertification = typeof certifications.$inferInsert;
