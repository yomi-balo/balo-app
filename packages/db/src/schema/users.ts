import { pgTable, uuid, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { userModeEnum, userStatusEnum, platformRoleEnum, signupIntentEnum } from './enums';
import { companies, companyMembers } from './companies';
import { timestamps, softDelete } from './helpers';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Auth (WorkOS)
    workosId: text('workos_id').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),

    // Profile
    firstName: text('first_name'),
    lastName: text('last_name'),
    avatarUrl: text('avatar_url'),
    platformRole: platformRoleEnum('platform_role').default('user').notNull(),
    phone: text('phone'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),

    // Preferences
    activeMode: userModeEnum('active_mode').default('client').notNull(),
    timezone: text('timezone').default('UTC'),
    currency: text('currency').default('AUD'),
    country: text('country'),
    countryCode: text('country_code'),
    onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),
    signupIntent: signupIntentEnum('signup_intent'), // nullable -- null for OAuth or pre-existing users
    /**
     * BAL-494 / ADR-1053 — the user's STORED active COMPANY workspace. NULL = "no explicit
     * choice yet" (every pre-BAL-494 row), which resolves to the default company workspace.
     * The workspace itself is the PAIR (`active_mode`, `active_company_id`): `active_mode='expert'`
     * selects the expert workspace; otherwise this column selects the company.
     *
     * `set null` (NOT cascade -- that would delete the USER; NOT restrict -- that would make a
     * company hard-delete fail 23503). `companies` has no `deleted_at`, so a hard delete is the
     * only removal path and SET NULL degrades cleanly to "no stored choice" -> fallback rule.
     * Nullable with no default and no backfill, so the migration is a PG catalog-only ADD COLUMN
     * (no table rewrite) and the FK validation scan is trivial (every existing value is NULL).
     * ⚠ A value here is NEVER trusted without revalidating it against the derived list.
     */
    activeCompanyId: uuid('active_company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),

    // Status
    status: userStatusEnum('status').default('active').notNull(),

    // Timestamps
    ...timestamps,
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    ...softDelete,
  },
  (t) => [
    // BAL-360: PARTIAL unique on `deleted_at IS NULL` (mirrors
    // `party_domains_domain_unique_idx`) so a soft-deleted user's email/identity
    // slot is freed for re-use (WorkOS delete→recreate with same email). Live rows
    // are still uniquely constrained. Reuses the former constraint names so the
    // migration is a clean drop-constraint + create-index with no dangling objects.
    uniqueIndex('users_workos_id_unique')
      .on(t.workosId)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('users_email_unique')
      .on(t.email)
      .where(sql`${t.deletedAt} IS NULL`),
    // BAL-494: FK columns get an index (drizzle-schema skill). Also serves the
    // reverse lookup "which users have this company as their active workspace",
    // which PG uses when validating the ON DELETE SET NULL on a company delete.
    index('users_active_company_id_idx').on(t.activeCompanyId),
  ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  companyMemberships: many(companyMembers),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
