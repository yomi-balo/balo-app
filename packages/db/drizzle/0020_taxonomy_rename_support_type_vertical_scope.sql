-- BAL-260 Taxonomy refactor: physical rename of the taxonomy tables + make
-- support_types vertical-scoped. Hand-authored (NOT drizzle DROP/CREATE) so the
-- three renames preserve existing data via ALTER TABLE ... RENAME TO, and every
-- constraint/index that embeds an old table name is renamed to the coherent new
-- name expected by the 0020 snapshot. The post-state matches drizzle/meta/0020_snapshot.json.

-- ── 1. Rename the three tables (data preserved) ─────────────────────────────
ALTER TABLE "skill_categories" RENAME TO "categories";--> statement-breakpoint
ALTER TABLE "skills" RENAME TO "products";--> statement-breakpoint
ALTER TABLE "expert_skills" RENAME TO "expert_competency";--> statement-breakpoint

-- ── 2. Rename primary-key constraints to match the new table names ──────────
ALTER TABLE "categories" RENAME CONSTRAINT "skill_categories_pkey" TO "categories_pkey";--> statement-breakpoint
ALTER TABLE "products" RENAME CONSTRAINT "skills_pkey" TO "products_pkey";--> statement-breakpoint
ALTER TABLE "expert_competency" RENAME CONSTRAINT "expert_skills_pkey" TO "expert_competency_pkey";--> statement-breakpoint

-- ── 3. Rename foreign-key constraints to the new auto-generated names ───────
-- (RENAME TABLE already repointed the FK targets; only the labels change here.)
ALTER TABLE "categories" RENAME CONSTRAINT "skill_categories_vertical_id_verticals_id_fk" TO "categories_vertical_id_verticals_id_fk";--> statement-breakpoint
ALTER TABLE "products" RENAME CONSTRAINT "skills_vertical_id_verticals_id_fk" TO "products_vertical_id_verticals_id_fk";--> statement-breakpoint
ALTER TABLE "products" RENAME CONSTRAINT "skills_category_id_skill_categories_id_fk" TO "products_category_id_categories_id_fk";--> statement-breakpoint
ALTER TABLE "expert_competency" RENAME CONSTRAINT "expert_skills_expert_profile_id_expert_profiles_id_fk" TO "expert_competency_expert_profile_id_expert_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "expert_competency" RENAME CONSTRAINT "expert_skills_skill_id_skills_id_fk" TO "expert_competency_skill_id_products_id_fk";--> statement-breakpoint
ALTER TABLE "expert_competency" RENAME CONSTRAINT "expert_skills_support_type_id_support_types_id_fk" TO "expert_competency_support_type_id_support_types_id_fk";--> statement-breakpoint

-- ── 4. Rename indexes to the new coherent names ─────────────────────────────
ALTER INDEX "skill_cat_vertical_slug_idx" RENAME TO "category_vertical_slug_idx";--> statement-breakpoint
ALTER INDEX "skill_cat_vertical_id_idx" RENAME TO "category_vertical_id_idx";--> statement-breakpoint
ALTER INDEX "skill_cat_sort_idx" RENAME TO "category_sort_idx";--> statement-breakpoint
ALTER INDEX "skill_vertical_slug_idx" RENAME TO "product_vertical_slug_idx";--> statement-breakpoint
ALTER INDEX "skill_category_id_idx" RENAME TO "product_category_id_idx";--> statement-breakpoint
ALTER INDEX "expert_skill_unique_idx" RENAME TO "expert_competency_unique_idx";--> statement-breakpoint

-- ── 5. support_types → vertical-scoped ──────────────────────────────────────
-- 5a. Add vertical_id NULLABLE first (existing rows have no value yet).
ALTER TABLE "support_types" ADD COLUMN "vertical_id" uuid;--> statement-breakpoint
-- 5b. Backfill existing support types to the Salesforce vertical. On a fresh DB
--     this is a no-op (no support_types rows + seeding happens after migrate).
UPDATE "support_types" SET "vertical_id" = (SELECT "id" FROM "verticals" WHERE "slug" = 'salesforce') WHERE "vertical_id" IS NULL;--> statement-breakpoint
-- 5c. Now enforce NOT NULL.
ALTER TABLE "support_types" ALTER COLUMN "vertical_id" SET NOT NULL;--> statement-breakpoint
-- 5d. Add the vertical FK (cascade on vertical delete).
ALTER TABLE "support_types" ADD CONSTRAINT "support_types_vertical_id_verticals_id_fk" FOREIGN KEY ("vertical_id") REFERENCES "public"."verticals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 5e. Drop the now-obsolete GLOBAL slug unique (replaced by a per-vertical one).
ALTER TABLE "support_types" DROP CONSTRAINT "support_types_slug_unique";--> statement-breakpoint
-- 5f. Per-vertical uniqueness + a vertical_id lookup index.
CREATE UNIQUE INDEX "support_type_vertical_slug_idx" ON "support_types" USING btree ("vertical_id","slug");--> statement-breakpoint
CREATE INDEX "support_type_vertical_id_idx" ON "support_types" USING btree ("vertical_id");
