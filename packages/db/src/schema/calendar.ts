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
 * ADR-1021, amendment 18 Aug 2026 (BAL-467), §1 — "A calendar connection is per
 * (expert, provider). Each connected provider is a distinct Apiroc End User Account,
 * stored as its own `calendar_connections` row, unique on `(expertId, provider)`. An
 * expert may hold connections to multiple providers at once; availability is the union
 * of busy blocks across all of the expert's connections; connect, disconnect, and
 * reconnect are per-provider. `targetCalendarId` is per connection."
 *
 * THIS TABLE IS DUAL-TENANTED FOR ONE RELEASE. Cronofy still writes it (live) and Apiroc
 * will (BAL-396). The two vendors store DIFFERENT identities, which is why every
 * vendor-identity column below is nullable: a Cronofy row carries `cronofy_sub` + the
 * three encrypted-token columns and NO `end_user_account_id`; an Apiroc row carries
 * `end_user_account_id` and NONE of the four — Balo holds no provider tokens for Apiroc
 * (apiroc skill, Constraint 1). Making either arm `NOT NULL` makes the other unwritable.
 * BAL-396 removes the Cronofy arm and decides whether `end_user_account_id` tightens.
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

    // ── Apiroc (ADR-1021): the ONLY vendor identity Balo stores. Nullable during the
    //    transition because the live Cronofy writer cannot populate it (dropping the
    //    Cronofy writer is BAL-396, not this ticket).
    endUserAccountId: text('end_user_account_id'),

    // ── Cronofy-era, ALL nullable as of BAL-467. These die with BAL-396. An Apiroc row
    //    leaves every one of them NULL. They are RELAXED rather than DROPPED so the live
    //    Cronofy connect path stays byte-identical on the merge commit.
    cronofySub: text('cronofy_sub'),
    accessToken: text('access_token'), // encrypted AES-256-GCM (Cronofy only)
    refreshToken: text('refresh_token'), // encrypted AES-256-GCM (Cronofy only)
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),

    provider: text('provider').notNull(), // 'google' | 'microsoft' — PRE-EXISTING (mig 0016)
    providerEmail: text('provider_email'),
    // ⚠ UNCHANGED BY BAL-467, deliberately. The credential-status lifecycle
    // (`ACTIVE | EXPIRED | REVOKED`) and the `status` → `credential_status` rename are
    // BAL-396 §2/§9 — the slice that introduces the reconnect detection giving those
    // values meaning. `.default('connected')` already satisfies the CHECK for an Apiroc
    // insert that omits it, so nothing here blocks this ticket.
    status: text('status').notNull().default('connected'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    channelId: text('channel_id'), // Cronofy push channel; dies with BAL-396
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
     *     See `calendarRepository.upsertConnection`.
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
     * time. BAL-396 may tighten it if the vendor confirms otherwise.
     */
    endUserAccountIdx: index('cal_conn_end_user_account_idx')
      .on(table.endUserAccountId)
      .where(sql`${table.deletedAt} IS NULL`),
    cronofySubIdx: index('cal_conn_cronofy_sub_idx').on(table.cronofySub),
    channelIdIdx: index('cal_conn_channel_id_idx').on(table.channelId),
    statusCheck: check(
      'cal_conn_status_check',
      sql`${table.status} IN ('connected', 'sync_pending', 'auth_error')`
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
