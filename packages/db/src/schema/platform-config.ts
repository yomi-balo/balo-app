import { pgTable, integer, timestamp, uuid, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { BILLING_FLOOR_MINUTES } from '@balo/shared/pricing'; // SSOT for the column default

/**
 * platform_config (BAL-398 / ADR-1044) — the FIRST platform-wide config storage in the
 * codebase. A SINGLETON row (id = 1) holding Balo-admin-editable global settings; the
 * first is `min_consultation_minutes` (whole minutes, default = the billing floor).
 *
 * DELIBERATE deviation from the every-table conventions (documented, not an oversight):
 *  - INTEGER singleton PK fixed at 1 (NOT a `uuid().defaultRandom()`): there is exactly
 *    ONE config row for the whole platform; a random UUID would let a second row exist and
 *    make "the config" ambiguous. The `platform_config_singleton` CHECK (`id = 1`) makes a
 *    second row structurally impossible — the singleton is enforced by the DB, not a
 *    convention. This is the one table where a non-UUID PK is correct.
 *  - NO `created_at`: a singleton config row is never "created" in a domain sense — it is
 *    seeded once with the migration and only ever updated; a creation timestamp carries no
 *    meaning.
 *  - NO `deleted_at` (no soft delete): the singleton config can never be deleted — deleting
 *    it would remove the platform's minimum. There is nothing to soft-delete, and a
 *    soft-delete column would be dead weight (and, with the singleton unique, a recreate
 *    footgun). Precedent for omitting `deleted_at`: `companies`
 *    (memory `reference_companies_table_no_deleted_at`) and `credit_wallets` (BAL-376) both
 *    deliberately have no `deleted_at`.
 *  - KEEPS only `updated_at` + `updated_by`: the config is a mutable projection whose ONLY
 *    interesting history is "when was it last changed and by whom" — `updated_at` (bumped
 *    via `$onUpdateFn`, matching the shared `timestamps` helper's semantics) and
 *    `updated_by` (nullable FK → the admin who last edited; the seed leaves it NULL).
 *
 * The `platform_config_min_ge_floor` CHECK uses the numeric literal `15`, kept in lockstep
 * with `BILLING_FLOOR_MINUTES` by the invariant test in `@balo/shared`
 * (`pricing/index.test.ts`, `BILLING_FLOOR_MINUTES === 15`). A numeric literal (not a `${}`
 * interpolation) matches every existing `check()` in the schema — e.g. `credit_wallets`'
 * `... >= 0` and `engagements`' bounds — so the CHECK is the structural money-floor backstop
 * while the imported constant drives the column DEFAULT + the app-layer Zod guard.
 */
export const platformConfig = pgTable(
  'platform_config',
  {
    id: integer('id').primaryKey().default(1), // singleton
    minConsultationMinutes: integer('min_consultation_minutes')
      .notNull()
      .default(BILLING_FLOOR_MINUTES),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('platform_config_singleton', sql`${t.id} = 1`),
    check('platform_config_min_ge_floor', sql`${t.minConsultationMinutes} >= 15`),
  ]
);

export type PlatformConfig = typeof platformConfig.$inferSelect;
export type NewPlatformConfig = typeof platformConfig.$inferInsert;
