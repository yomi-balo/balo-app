import { pgTable, uuid, index, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { caseEngagements } from './case-engagements';
import { products } from './verticals';
import { timestamps, softDelete } from './helpers';

/**
 * case_engagement_products (BAL-400 / plan DECISION 2) — the junction from a CASE
 * engagement to the shared `products` taxonomy. The client tags "what is this about"
 * on the booking confirm step, and it is the ONLY structured signal the delivering
 * expert gets beyond the free-text description.
 *
 * MIRRORS `project_request_products` (schema/project-requests.ts) — same two-FK shape,
 * same on-delete pair, same `timestamps` + `softDelete` spread — so the two taxonomies
 * are attached the same way at both grains. Copy-adapted deliberately, NOT invented.
 *
 * ⚠⚠ ONE DELIBERATE DIVERGENCE FROM THE TEMPLATE, AND IT IS A BUG FIX, NOT A STYLE
 * CHOICE. `project_request_product_unique_idx` is a NON-PARTIAL unique on
 * `(project_request_id, product_id)` while the table also carries `deleted_at`. That is
 * exactly the `reference_softdelete_nonpartial_unique_recreate` failure mode: once a link
 * is soft-deleted its row keeps occupying the unique, so re-adding the SAME product to the
 * SAME parent fails `23505` forever — a silent, permanent "you cannot re-tag this" with no
 * user-visible cause. The unique here is PARTIAL on `deleted_at IS NULL`, so a soft-deleted
 * link frees its slot. DO NOT "align" it back to the template.
 *
 * ⚠ THE PARENT FK POINTS AT `case_engagements.engagement_id` — THE CHILD'S PK, NOT THE
 * SUPERTYPE `engagements.id`. A product link is therefore structurally impossible for a
 * non-case engagement: there is no `case_engagements` row to point at. (`case_engagements`
 * itself pins `engagement_type='case'` by CHECK + composite FK, so the guarantee is
 * transitive and needs no CHECK here.)
 *
 * ON DELETE, same rationale as the template: parent `cascade` (links die with the case),
 * `products` `restrict` (never hard-delete a taxonomy row that is in use — deactivate via
 * `products.is_active`). ⚠ `products` carries NO `deleted_at` (schema/verticals.ts —
 * `...timestamps` only), so `restrict` is the only coherent choice: there is no soft-delete
 * to fall back on.
 *
 * NO RLS, matching every delivery-domain table in this package (`engagements`,
 * `case_engagements`, `meetings`, `credit_sessions`, `transcripts`, `action_items`, and
 * the sibling `project_request_products`). `stripe_webhook_events` is the ONLY table in
 * the schema that declares policies. Access is gated at the application layer, and adding
 * policies to a leaf junction whose parent chain has none would be theatre rather than
 * defence in depth. Stated explicitly because the `drizzle-schema` skill's default is
 * "every table gets RLS" — this follows the shipped house posture instead, deliberately.
 *
 * ⚠ NO REPOSITORY FILE. These rows are written ONLY inside
 * `caseEngagementsRepository.create`'s existing transaction (a case and its tags commit
 * or roll back together) and read only through the `products` relation. A standalone
 * repository would be a seam with one caller. If a later ticket needs one — an
 * edit-tags-after-the-fact surface, say — it MUST ship
 * `case-engagement-products.integration.test.ts` in the same PR (CLAUDE.md).
 */
export const caseEngagementProducts = pgTable(
  'case_engagement_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The CASE this tag belongs to. Declared WITHOUT an inline `.references()` — the
     * explicit `foreignKey` below carries the reference so the constraint can be NAMED.
     * Drizzle's auto-generated name for this pair would be
     * `case_engagement_products_engagement_id_case_engagements_engagement_id_fk` (71
     * chars), which Postgres SILENTLY TRUNCATES to 63 — leaving the snapshot and the
     * database disagreeing about the constraint's name forever, and every later
     * `drizzle-kit generate` free to "notice" the difference.
     */
    engagementId: uuid('engagement_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // PARTIAL on `deleted_at IS NULL` — see the divergence note in the file docblock.
    // Predicate references ONLY `deleted_at`, never an enum literal (the ADD-VALUE
    // one-transaction migration hazard).
    uniqueIndex('case_engagement_product_unique_idx')
      .on(t.engagementId, t.productId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('case_engagement_product_engagement_idx').on(t.engagementId),
    index('case_engagement_product_product_idx').on(t.productId),
    foreignKey({
      columns: [t.engagementId],
      foreignColumns: [caseEngagements.engagementId],
      name: 'case_engagement_product_case_fk',
    }).onDelete('cascade'),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const caseEngagementProductsRelations = relations(caseEngagementProducts, ({ one }) => ({
  caseEngagement: one(caseEngagements, {
    fields: [caseEngagementProducts.engagementId],
    references: [caseEngagements.engagementId],
  }),
  product: one(products, {
    fields: [caseEngagementProducts.productId],
    references: [products.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CaseEngagementProduct = typeof caseEngagementProducts.$inferSelect;
export type NewCaseEngagementProduct = typeof caseEngagementProducts.$inferInsert;
