import { pgTable, uuid, text, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamps, softDelete } from './helpers';

/**
 * platform_settings (BAL-557) — runtime configuration that changes without a build.
 *
 * A generic `key` → jsonb `value` store. Each key's type, parse and code default live in the
 * `@balo/shared/platform-settings` registry; `platformSettingsRepository.get` reads the live row
 * and parses it there, falling back to the default (and warning) when the row is missing or
 * invalid. Changing a value is a SQL `UPDATE`; there is no admin UI yet.
 *
 * Seeded by its creating migration (`expert_reapply_cooldown_days` = 60), so a missing row is
 * a real anomaly worth the repository's warning.
 *
 * ── NO RLS — A KNOWING DEVIATION, RECORDED ────────────────────────────────────────────
 * No schema file in this package calls `.enableRLS()` or `pgPolicy()`: Balo authenticates with
 * WorkOS + iron-session, so `auth.uid()` is always null and every reader is the admin `db`
 * client (which bypasses RLS). Same deviation as `admin-alerts.ts`. Nothing here is per-user
 * or secret — never store a credential in this table.
 */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** A `PlatformSettingKey` from `@balo/shared/platform-settings`. Text, not a pgEnum. */
    key: text('key').notNull(),

    /** Parsed per key by the shared registry; never trusted raw. */
    value: jsonb('value').$type<unknown>().notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * One LIVE row per key. Partial on `deleted_at`, so soft-deleting a row frees the key for
     * a replacement instead of colliding with it.
     */
    uniqueIndex('platform_settings_key_live_uidx')
      .on(t.key)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;
