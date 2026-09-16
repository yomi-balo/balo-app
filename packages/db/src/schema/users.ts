import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { PlatformCapability } from '@balo/shared/authz';
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
    /**
     * BAL-560 / ADR-1035 Amendment 1 §A1.2 — this person's platform capabilities, REPLACING the
     * role bundle. THREE STATES:
     *   · NULL  ⇒ inherit `PLATFORM_ROLE_CAPABILITIES[platform_role]`. Every row today.
     *   · `[]`  ⇒ holds NOTHING. Meaningful, and NOT the same as NULL.
     *   · `[…]` ⇒ the resolved set VERBATIM — replaces the bundle, never extends it.
     *
     * `jsonb` because this schema has no PG array column anywhere; every list-valued column is
     * jsonb. The precedent is `representations.capabilities` (`schema/representations.ts:138`)
     * and `transcripts.extractedActionItems` — NOT `audit_events.metadata` /
     * `payouts.form_values`, which are OBJECT-valued and prove nothing about a jsonb ARRAY.
     *
     * ⚠ `$type<PlatformCapability[]>()` IS A COMPILE-TIME CLAIM POSTGRES DOES NOT ENFORCE. The
     * CHECK below pins the SHAPE (array-or-NULL) and the role pairing; the ELEMENTS are filtered
     * against `PLATFORM_CAPABILITIES` on the READ path by `resolvePlatformCapabilities`
     * (`@balo/shared/authz`) — the `representations.ts:130-137` rule — because a row can arrive
     * from a script or a hand edit, and narrowing the axis later must take effect immediately
     * rather than waiting for a backfill. Readers must treat the value as `unknown`.
     *
     * ⚠ NOTHING WRITES THIS COLUMN IN BAL-560. The writer is BAL-561.
     */
    platformCapabilities: jsonb('platform_capabilities').$type<PlatformCapability[]>(),
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
    /**
     * BAL-560 (D1 + D7) — ONE constraint pinning BOTH facts about `platform_capabilities`,
     * because either alone is insufficient.
     *
     * SHAPE (D7): `jsonb_typeof(...) = 'array'`. A bare `jsonb` column happily stores
     * `'null'::jsonb`, a scalar or an object, any of which would make the three-state encoding
     * ambiguous. ⚠ NOTE THIS IS THE **OPPOSITE** OF THE `representations` PRECEDENT
     * (`representation_capabilities_nonempty`, `schema/representations.ts:313-316`, which
     * requires NON-EMPTY): here `[]` MUST be allowed — it is the meaningful "holds nothing"
     * state.
     *
     * LENGTH (BAL-560 fix round 1, security F1): `jsonb_array_length(...) <= 17`. WITHOUT IT THE
     * COOKIE IS UNBOUNDED AND A LONG ARRAY IS A SILENT, NON-SELF-HEALING LOCKOUT — a browser
     * discards a `Set-Cookie` over 4096 bytes with no server-side error, and a measured 26-entry
     * override seals to 4289 bytes. Duplicates are what make that reachable: the axis has only
     * 17 distinct tokens, but nothing stops `['view_platform_admin', 'view_platform_admin', …]`.
     * The seal path de-duplicates and filters (`sealedPlatformCapabilities`), and this is the
     * database-side half of the same bound.
     *
     * ⚠⚠ **17 IS `Object.keys(PLATFORM_CAPABILITIES).length` TODAY, AND THIS CONSTRAINT DOES NOT
     * TRACK IT.** Adding an 18th platform token makes a legitimate full-axis override fail this
     * CHECK with a mystifying 23514. That is accepted — a new token already requires a
     * migration-era decision — but the next person adding one MUST bump this bound in a
     * migration at the same time. `packages/shared/src/authz/platform.test.ts` pins the axis
     * count, so the axis and this number are both written down; they are not linked by code.
     *
     * ⚠ THE `CASE` IS NOT STYLE — IT IS AN EVALUATION-ORDER GUARANTEE. `jsonb_typeof` is total
     * over any jsonb value, but `jsonb_array_length` on a non-array raises 22023 — a CRASH, not a
     * clean 23514 — so the length call must never reach a scalar. SQL does NOT guarantee that
     * `AND` short-circuits left-to-right, and Postgres explicitly reserves the right to reorder
     * the arms of an `AND` by estimated cost, so the bare
     * `jsonb_typeof(...) = 'array' AND jsonb_array_length(...) <= 17` form is a HAZARD rather
     * than a known failure.
     *
     * ⚠⚠ **DO NOT "VERIFY" THIS BY TRYING THE BARE FORM AND CONCLUDING THE `CASE` IS
     * UNNECESSARY** (fix round 2, V2). It was tried: on PG16 the bare form ALSO raised a clean
     * 23514, having happened to short-circuit. That is an observation about one planner's choice
     * on one query, NOT a guarantee — the whole point is that nothing in the contract stops it
     * choosing otherwise, and a 22023 here would surface as an opaque crash on a write path
     * rather than as a constraint violation the caller can handle. The `CASE` costs nothing and
     * removes the question. Leave it.
     *
     * PAIRING (D1): `platform_role <> 'user'`. A capability-only staff account must not exist:
     * `platformRoleIsStaff` (`@balo/shared/authz`) reads the ROLE ONLY and is a live gate in
     * `assignOwner`, in the impersonation staff-target refusal, and in the session-sync
     * promoted-target kill — a row with `platform_role='user'` and a non-NULL override would
     * make those three seams disagree with the capability seam about the same person. It is a
     * TABLE check over BOTH columns, not a column check, so it holds on INSERT *and* on a later
     * role DOWNGRADE (`UPDATE users SET platform_role='user'` on a row carrying an override
     * fails 23514 rather than silently orphaning it).
     *
     * ⚠ THAT SAFETY PROPERTY IS ALSO AN OBLIGATION ON EVERY ROLE-SETTER (security F4). A
     * demotion of a staff member who holds an override MUST clear the column in the SAME
     * statement — `UPDATE users SET platform_role='user', platform_capabilities=NULL` — or it
     * fails 23514 and the demotion does not happen at all. Nothing in production writes
     * `platform_role` today, so no shipped path can hit this; BAL-561, which introduces the
     * first writer for both columns, must do the pair atomically.
     *
     * ⚠ `<> 'user'` rather than `IN ('admin','super_admin')` is D1's exact spelling. Consequence
     * to know: a FUTURE non-staff `platform_role` value would be allowed to carry an override by
     * this constraint — `normalizePlatformOverride`'s `platformRoleIsStaff` guard
     * (`@balo/shared/authz`) is the resolver-side backstop for that case.
     *
     * ⚠ IT IS ALSO THE COOKIE BUDGET'S GUARANTEE. An impersonated session carrying a full
     * 17-token override seals to 3542 bytes — OVER the 3500-byte safe budget. That combination
     * is unreachable only because an impersonation target cannot be staff
     * (`lib/auth/actions/impersonation.ts:198`) AND a non-staff row cannot hold an override
     * (this constraint). Both halves are load-bearing; see the proof-of-the-reason test in
     * `apps/web/src/lib/auth/session-cookie-size.test.ts`.
     *
     * ⚠⚠ **ESCALATION (fix round 3, R2): `manage_staff_capabilities` MAY APPEAR ONLY ON A
     * `super_admin` ROW.** An override REPLACES the role bundle and is deliberately unclamped —
     * it is never intersected with what the role could hold, because an additive or clamped
     * reading makes "an admin, minus promo codes" inexpressible, which is the whole reason the
     * column exists. The direct consequence is that
     * `platform_capabilities = ['manage_staff_capabilities']` on a `platform_role='admin'` row
     * resolves to exactly that token, making a plain admin a latent `super_admin` who can then
     * write any token onto any staff row — a one-row privilege escalation, and a
     * self-perpetuating one. The RESOLVER deliberately does not special-case it (that would
     * reintroduce clamping), so the STORAGE rule is the place to refuse.
     *
     * ⚠ THE RULE IS "ONLY ON A `super_admin` ROW", **NOT** "never in an override". The narrower
     * form is the only one compatible with BAL-561's design: switching a super_admin to a Custom
     * override pre-fills from the current role bundle, which for a `super_admin` INCLUDES this
     * token, and BAL-561's floor rule 3 requires a sole super_admin to keep
     * `manage_staff_capabilities` while remaining a super admin. A blanket refusal would make a
     * sole super_admin unable to switch to Custom at all, and would silently strip staff
     * management from every other super_admin who did. The real hazard is narrow: the token on a
     * NON-super_admin row.
     *
     * ⚠ IT LIVES INSIDE THE EXISTING `CASE` ARM, deliberately, so `@>` can never evaluate against
     * a non-array — the same evaluation-order reasoning as the length bound above. A demotion
     * (`super_admin` → `admin`) on a row whose override still names the token therefore fails
     * 23514 rather than completing into an escalated state: an obligation on BAL-561's writer to
     * clear or re-state the override on ANY role change, not only on a demotion to `user`.
     */
    check(
      'users_platform_capabilities_staff_array',
      sql`${t.platformCapabilities} IS NULL OR (CASE WHEN jsonb_typeof(${t.platformCapabilities}) = 'array' THEN jsonb_array_length(${t.platformCapabilities}) <= 17 AND (${t.platformRole} = 'super_admin' OR NOT ${t.platformCapabilities} @> '["manage_staff_capabilities"]'::jsonb) ELSE false END AND ${t.platformRole} <> 'user')`
    ),
  ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  companyMemberships: many(companyMembers),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
