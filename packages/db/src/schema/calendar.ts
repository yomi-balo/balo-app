import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { expertProfiles } from './experts';
import { timestamps, softDelete } from './helpers';

// ── Calendar Connections ────────────────────────────────────────

/**
 * ADR-1021 amendment 18 Aug 2026 (BAL-396) §3 — Balo's connection-health vocabulary.
 *
 * THREE of the four values MIRROR the vendor enum `EndUserAccountCredentialStatus`
 * (`ACTIVE | EXPIRED | REVOKED`, SDK `dist/index.d.ts:334-338`). `SYNC_PENDING` is
 * BALO-SIDE and has no vendor counterpart: it means "the credential is live at Apiroc but
 * Balo has not finished first provisioning (sub-calendar list + target calendar)". A
 * `SYNC_PENDING` connection stores no `calendarIds`, so it is UNREADABLE for free/busy —
 * which the booking gate must treat as fail-closed, not as "no calendar".
 *
 * ⚠ THIS REPLACES THE CRONOFY VOCABULARY (`connected | sync_pending | auth_error`)
 * WHOLESALE. `auth_error` collapsed to `EXPIRED` in migration 0068: a user-initiated
 * revoke surfaces as EXPIRED and REVOKED is unreachable on Google (apiroc skill,
 * credential-expiry table), and any non-ACTIVE value means the same thing to the expert —
 * "reconnect required" — with no distinct UX.
 */
export const CALENDAR_CREDENTIAL_STATUSES = [
  'ACTIVE',
  'SYNC_PENDING',
  'EXPIRED',
  'REVOKED',
] as const;
export type CalendarCredentialStatus = (typeof CALENDAR_CREDENTIAL_STATUSES)[number];

/**
 * ADR-1021, amendment 18 Aug 2026 (BAL-467), §1 — "A calendar connection is per
 * (expert, provider). Each connected provider is a distinct Apiroc End User Account,
 * stored as its own `calendar_connections` row, unique on `(expertId, provider)`. An
 * expert may hold connections to multiple providers at once; availability is the union
 * of busy blocks across all of the expert's connections; connect, disconnect, and
 * reconnect are per-provider. `targetCalendarId` is per connection."
 *
 * BAL-396 (ADR-1021 amendment 18 Aug 2026 §5) COMPLETED THE MIGRATION OFF CRONOFY. Migration
 * 0069 dropped every Cronofy identity column (`cronofy_sub`, `access_token`, `refresh_token`,
 * `token_expires_at`, `channel_id`) and made `end_user_account_id` — the only vendor identity
 * Balo stores — `NOT NULL`. It stays NON-unique — see `endUserAccountIdx`. Migration 0068 did
 * the credential-status lifecycle (the `status` → `credential_status` rename,
 * `credential_checked_at`, `reconnect_notified_at`, the new CHECK and the probe's scan index).
 *
 * ⚠ NO RLS, matching every other table in this package except `stripe_webhook_events`.
 * Balo authenticates at the application layer (WorkOS) and reads this table only through
 * `calendarRepository` on the admin client. Unchanged by this ticket.
 */
export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),

    // ── Apiroc (ADR-1021): the ONLY vendor identity Balo stores. `NOT NULL` since migration
    //    0069 (BAL-396) — a row without a pointer is unusable (§9.2's busy read skips it, so
    //    the expert would show as "connected" and be permanently unreadable). NON-unique: see
    //    `endUserAccountIdx` below.
    endUserAccountId: text('end_user_account_id').notNull(),

    provider: text('provider').notNull(), // 'google' | 'microsoft' — PRE-EXISTING (mig 0016)
    providerEmail: text('provider_email'),

    /**
     * ── replaces `status` (RENAMED in migration 0068, never dropped-and-re-added) ──
     *
     * ⚠⚠ `.$type<CalendarCredentialStatus>()` IS LOAD-BEARING, NOT DOCUMENTATION. Drizzle
     * types `eq(column, value)` from the column's data type, so with this annotation
     * `eq(calendarConnections.credentialStatus, 'connected')` is a COMPILE ERROR. Without
     * it, a query left on the Cronofy vocabulary would compile, run, and match ZERO ROWS
     * forever — silently. That is exactly how `findStaleConnections` would have died: the
     * 15-minute staleness cron (`jobs/availability-cache.ts`) would report nothing wrong
     * while no connection was ever resynced. A comment cannot buy that; a bare `text()`
     * column cannot either.
     *
     * Belt-and-braces on top of the type: `calendar.integration.test.ts` seeds a live
     * connection and asserts `findStaleConnections` returns it, so a vocabulary that
     * migrated one way and queried the other fails on real Postgres too.
     */
    credentialStatus: text('credential_status')
      .$type<CalendarCredentialStatus>()
      .notNull()
      .default('ACTIVE'),

    /** Last time the health probe (or any live data call) proved this credential works. */
    credentialCheckedAt: timestamp('credential_checked_at', { withTimezone: true }),

    /**
     * The sweep-over-sweep "already notified" marker. NULL = not notified since this
     * connection was last healthy, so the reconnect email fires at most once per breakage.
     * House precedent: `credit_receivables.last_dunning_at` + `markDunned()`, stamped
     * AFTER the publish. Cleared by `upsertApirocConnection` (reconnect) and by the health
     * probe when a credential heals — which is what lets a SECOND breakage notify again.
     */
    reconnectNotifiedAt: timestamp('reconnect_notified_at', { withTimezone: true }),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    targetCalendarId: text('target_calendar_id'), // PER CONNECTION (amendment §1)
    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    /**
     * ADR-1021 amendment 18 Aug 2026 §1 — one LIVE connection per (expert, provider).
     * Replaces `cal_conn_expert_profile_idx`, which was unique on `expert_profile_id`
     * ALONE and therefore made a second provider unrepresentable.
     *
     * ⚠⚠ PARTIAL ON `deleted_at IS NULL`, AND THAT IS LOAD-BEARING TWICE OVER:
     *  1. Disconnect soft-deletes (`softDeleteConnectionForProvider`). A NON-partial
     *     unique would make disconnect → reconnect fail with 23505 against a row the
     *     application cannot see. House footgun; house fix — same shape as
     *     `company_user_idx` / `agency_user_idx` / `review_engagement_reviewer_expert_live_idx`.
     *  2. THE REPOSITORY UPSERT MUST RESTATE THIS PREDICATE AS `targetWhere`. Postgres
     *     only selects a partial index as an ON CONFLICT arbiter when the statement
     *     repeats its predicate; omit it and EVERY upsert raises 42P10 at PLAN time —
     *     including the first, on an empty table. Typecheck stays green.
     *     See `calendarRepository.upsertApirocConnection`.
     *
     * ⚠ `deleted_at` belongs in the WHERE, NEVER in the key columns. Keying on
     * `(expert_profile_id, provider, deleted_at)` looks equivalent and is not: NULL is
     * not equal to itself in a unique index, so it would permit UNLIMITED live duplicate
     * rows — exactly the bug the predicate closes. Pinned by
     * `invariants/calendar-connection-cardinality.test.ts`.
     */
    expertProviderIdx: uniqueIndex('cal_conn_expert_provider_idx')
      .on(table.expertProfileId, table.provider)
      .where(sql`${table.deletedAt} IS NULL`),
    /**
     * The Apiroc pointer lookup (`findConnectionByEndUserAccountId`), which BAL-468's
     * webhook handler resolves an inbound End User Account against.
     *
     * ⚠ NON-UNIQUE, and that is a decision. The amendment rules cardinality on
     * `(expertProfileId, provider)` and on nothing else. Nothing in ADR-1021 or the
     * vendor docs establishes that one End User Account maps to at most one Balo
     * expert — two experts connecting the same Google account (routine in dev and seed
     * data) would collide on a unique index and surface as a confusing 23505 at connect
     * time.
     *
     * ⚠ BAL-396 LOOKED AND RULED IT STAYS NON-UNIQUE (ADR-1021 amendment 18 Aug 2026 §5).
     * The vendor keys End User Accounts by provider account, not by our `externalId`
     * (`UpsertEndUserAccountInput.externalId` is optional metadata, not the key), and a
     * revoke → reconnect cycle returns THE SAME id — so two Balo experts on one Google
     * account would very likely receive the same `endUserAccountId`. Do not re-litigate
     * this without vendor evidence; `invariants/calendar-connection-cardinality.test.ts`
     * asserts this table declares EXACTLY ONE unique index for that reason.
     */
    endUserAccountIdx: index('cal_conn_end_user_account_idx')
      .on(table.endUserAccountId)
      .where(sql`${table.deletedAt} IS NULL`),
    /**
     * The health probe's "oldest unchecked first" scan
     * (`listConnectionsDueForHealthCheck`). PARTIAL on `deleted_at IS NULL` because a
     * disconnected connection is never a probe candidate — probing it would spend a vendor
     * call to learn nothing and could email an expert about a calendar they unhooked.
     */
    credentialCheckIdx: index('cal_conn_credential_check_idx')
      .on(table.credentialCheckedAt)
      .where(sql`${table.deletedAt} IS NULL`),
    credentialStatusCheck: check(
      'cal_conn_credential_status_check',
      sql`${table.credentialStatus} IN ('ACTIVE', 'SYNC_PENDING', 'EXPIRED', 'REVOKED')`
    ),
  })
);

// ── Calendar Sub-Calendars ──────────────────────────────────────

export const calendarSubCalendars = pgTable(
  'calendar_sub_calendars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => calendarConnections.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    profileName: text('profile_name'),
    isPrimary: boolean('is_primary').notNull().default(false),
    conflictCheck: boolean('conflict_check').notNull().default(true),
    color: text('color'),
    ...timestamps,
  },
  (table) => ({
    connectionCalendarIdx: uniqueIndex('cal_sub_conn_calendar_idx').on(
      table.connectionId,
      table.calendarId
    ),
    connectionIdx: index('cal_sub_connection_idx').on(table.connectionId),
  })
);

// ── Availability Cache ──────────────────────────────────────────

export const availabilityCache = pgTable(
  'availability_cache',
  {
    expertProfileId: uuid('expert_profile_id')
      .primaryKey()
      .references(() => expertProfiles.id, { onDelete: 'cascade' }),
    earliestAvailableAt: timestamp('earliest_available_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // Serves the availability gate (earliest_available_at IS NOT NULL AND > now)
  // and the `soonest` ORDER BY. The migration hand-augments this to a PARTIAL
  // index (WHERE earliest_available_at IS NOT NULL) — drizzle-kit cannot express
  // the partial predicate, so this declaration only keeps drizzle-kit from
  // re-dropping the index; the migration is the source of truth.
  (table) => ({
    earliestIdx: index('availability_cache_earliest_idx').on(table.earliestAvailableAt),
  })
);

// ── Relations ───────────────────────────────────────────────────

export const calendarConnectionsRelations = relations(calendarConnections, ({ one, many }) => ({
  expertProfile: one(expertProfiles, {
    fields: [calendarConnections.expertProfileId],
    references: [expertProfiles.id],
  }),
  subCalendars: many(calendarSubCalendars),
}));

export const calendarSubCalendarsRelations = relations(calendarSubCalendars, ({ one }) => ({
  connection: one(calendarConnections, {
    fields: [calendarSubCalendars.connectionId],
    references: [calendarConnections.id],
  }),
}));

export const availabilityCacheRelations = relations(availabilityCache, ({ one }) => ({
  expertProfile: one(expertProfiles, {
    fields: [availabilityCache.expertProfileId],
    references: [expertProfiles.id],
  }),
}));

// ── Type exports ────────────────────────────────────────────────

export type CalendarConnection = typeof calendarConnections.$inferSelect;
export type NewCalendarConnection = typeof calendarConnections.$inferInsert;
export type CalendarSubCalendar = typeof calendarSubCalendars.$inferSelect;
export type NewCalendarSubCalendar = typeof calendarSubCalendars.$inferInsert;
export type AvailabilityCache = typeof availabilityCache.$inferSelect;
export type NewAvailabilityCache = typeof availabilityCache.$inferInsert;
