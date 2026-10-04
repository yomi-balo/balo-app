import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  uniqueIndex,
  index,
  unique,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { productAliasKindEnum } from './enums';
import { timestamps, softDelete } from './helpers';

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

    /**
     * BAL-592 — INTERNAL, PROMPT-ONLY, NEVER USER-VISIBLE. A one-line disambiguation hint the
     * AI brief parse renders next to the product in its `<products>` list (e.g. "Marketing Cloud
     * Engagement: email, SMS and push messaging and journeys"), for products whose bare name is
     * ambiguous. NOT `description`, which is user-facing copy.
     *
     * ⚠ Read ONLY by `referenceDataRepository.getProductsForBriefMapping`. Every other read that
     * hydrates a full `products` row into something a client can receive must exclude it
     * (`experts.ts`' competency hydrations do, via `columns: { aiHint: false }`).
     *
     * The CHECK below bounds it to 1–240 chars and forbids `<` / `>`: it is interpolated inside
     * the prompt's `<products>` delimiter, so an angle bracket could forge or close that tag.
     */
    aiHint: text('ai_hint'),

    ...timestamps,
  },
  (table) => ({
    verticalSlugIdx: uniqueIndex('product_vertical_slug_idx').on(table.verticalId, table.slug),
    categoryIdx: index('product_category_id_idx').on(table.categoryId),
    // The target of `product_aliases`' composite FK, which needs a UNIQUE CONSTRAINT (not an
    // index) on exactly these columns. Always satisfiable: the PK alone is already unique.
    idVerticalUq: unique('product_id_vertical_uq').on(table.id, table.verticalId),
    aiHintShape: check(
      'product_ai_hint_shape',
      sql`${table.aiHint} IS NULL OR (char_length(${table.aiHint}) BETWEEN 1 AND 240 AND strpos(${table.aiHint}, '<') = 0 AND strpos(${table.aiHint}, '>') = 0 AND strpos(${table.aiHint}, chr(10)) = 0 AND strpos(${table.aiHint}, chr(13)) = 0)`
    ),
  })
);

/**
 * product_aliases (BAL-592) — Balo-owned other names for a product: the FEATURES it includes
 * and the other names it is ALSO CALLED (`productAliasKindEnum`). Two consumers:
 *  - the AI brief parse renders them on the product's line in the `<products>` list, so the
 *    model can roll "Journey Builder" or "ExactTarget" up to `engagement`;
 *  - its resolver turns a model-reported unmatched product label (or a slug that missed the
 *    taxonomy) into a product id by an EXACT lookup of the label's `normalizeTaxonomyLabel`
 *    form (`@balo/shared/project-requests`) against active product names and these aliases.
 *
 * Seeded and changed by migrations only (no admin UI); the seed constant is
 * `reference-data/salesforce-taxonomy.ts`, rendered into SQL by `reference-data/taxonomy-seed.ts`.
 *
 * `vertical_id` is denormalised from the product so uniqueness can be per vertical. The
 * composite FK `(product_id, vertical_id)` → `products(id, vertical_id)` makes a mismatched pair
 * unrepresentable, and cascades: an alias dies with its product.
 *
 * ⚠ `lower(alias)` IS A COARSE GUARD, NOT THE DEFINITION OF "THE SAME ALIAS". The partial unique
 * below stops exact case-variants in one vertical; the real definition is the TypeScript
 * normaliser (NFKC, `&`→`and`, whitespace collapse, `salesforce ` prefix strip), and collisions
 * under it — alias vs alias AND alias vs product name — are enforced by
 * `reference-data/salesforce-taxonomy.test.ts`. Postgres cannot run that normaliser.
 *
 * The CHECK bounds an alias to 1–80 chars with no `<` / `>`: aliases are interpolated inside the
 * prompt's `<products>` delimiter.
 *
 * NO RLS, matching the house posture of every reference-data and delivery table in this package
 * (`products` itself has none; `case-engagement-products.ts` states the same deviation). Reads
 * go through `referenceDataRepository` on the server only. Stated explicitly because the
 * `drizzle-schema` skill's default is "every table gets RLS".
 */
export const productAliases = pgTable(
  'product_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Declared WITHOUT inline `.references()`: the named composite `foreignKey` below carries
     * both columns, so the constraint gets a short, stable name.
     */
    productId: uuid('product_id').notNull(),
    verticalId: uuid('vertical_id').notNull(),

    alias: text('alias').notNull(),
    kind: productAliasKindEnum('kind').notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    foreignKey({
      columns: [t.productId, t.verticalId],
      foreignColumns: [products.id, products.verticalId],
      name: 'product_alias_product_vertical_fk',
    }).onDelete('cascade'),
    // PARTIAL on `deleted_at IS NULL`, so a soft-deleted alias frees its slot. The predicate
    // references only `deleted_at`, never an enum literal.
    uniqueIndex('product_alias_vertical_alias_unique_idx')
      .on(t.verticalId, sql`lower(${t.alias})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index('product_alias_product_id_idx').on(t.productId),
    check(
      'product_alias_shape',
      sql`char_length(${t.alias}) BETWEEN 1 AND 80 AND strpos(${t.alias}, '<') = 0 AND strpos(${t.alias}, '>') = 0 AND strpos(${t.alias}, chr(10)) = 0 AND strpos(${t.alias}, chr(13)) = 0`
    ),
  ]
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

export const productsRelations = relations(products, ({ one, many }) => ({
  vertical: one(verticals, {
    fields: [products.verticalId],
    references: [verticals.id],
  }),
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  aliases: many(productAliases),
}));

export const productAliasesRelations = relations(productAliases, ({ one }) => ({
  product: one(products, {
    fields: [productAliases.productId],
    references: [products.id],
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
export type ProductAlias = typeof productAliases.$inferSelect;
export type NewProductAlias = typeof productAliases.$inferInsert;
export type ProductAliasKind = (typeof productAliasKindEnum.enumValues)[number];
export type SupportType = typeof supportTypes.$inferSelect;
export type NewSupportType = typeof supportTypes.$inferInsert;
export type CertificationCategory = typeof certificationCategories.$inferSelect;
export type NewCertificationCategory = typeof certificationCategories.$inferInsert;
export type Certification = typeof certifications.$inferSelect;
export type NewCertification = typeof certifications.$inferInsert;
