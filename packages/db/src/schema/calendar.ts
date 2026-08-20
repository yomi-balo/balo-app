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

// ── Calendar Webhook Subscriptions ──────────────────────────────

/**
 * `calendar_subscriptions` (BAL-468) — ONE Apiroc `event` webhook registration per
 * (connection, calendar). ADR-1021 amendment 2026-08-15: the inbound webhook is a **bare
 * trigger** into `rebuildAvailabilityCache` — it carries no event id and Balo reads no event
 * content on that path — so nothing about the CHANGE is stored here. This table records only
 * the registration itself and the evidence needed to keep it alive.
 *
 * ⚠⚠ NOT TO BE CONFUSED WITH `calendar_sub_calendars`, which lives in this same file. That
 * table is the expert's LIST OF CALENDARS with its conflict-check toggle; this one is the
 * WEBHOOK REGISTRATION for a calendar Balo decided to watch. The index prefix here is
 * `cal_wsub_` (not `cal_sub_`) precisely so the two are never confused in a migration diff,
 * a query plan, or a `\di` listing.
 *
 * ⚠⚠ THERE IS DELIBERATELY **NO** UNIQUE ON `(connection_id, calendar_id)` (BAL-468 plan
 * ruling #5) — and that reverses the obvious instinct, so read this before "fixing" it.
 * Renewal is **create-then-delete**: the replacement subscription is registered at the vendor
 * and inserted here while the incumbent is still live and un-deleted, so **two live rows for
 * one (connection_id, calendar_id) is the LEGITIMATE steady state** for the width of a
 * renewal. A partial unique on that pair would reject the second INSERT with 23505 — the
 * exact failure it was meant to prevent, moved one statement earlier. The only ordering that
 * satisfies such an index is soft-delete-then-insert, which opens a window where the
 * connection has NO live row while the vendor is still delivering to the old URL (that URL
 * then 404s → non-2xx → Svix retries → endpoint disabled after ~5 days).
 *
 * So uniqueness lives on `webhook_subscription_id` — genuinely unique, vendor-minted, never
 * reused — and **canonicity is DERIVED, not stored**: the newest live row per
 * `(connection_id, calendar_id)` wins (`created_at desc, id desc`, see
 * `calendarSubscriptionsRepository.listLiveByConnectionId`), and every older live sibling is
 * a `superseded` delete target on the next reconciliation pass. That is what makes a renewal
 * whose delete failed self-healing rather than a leak.
 *
 * ⚠ NO `ON CONFLICT` STATEMENT ANYWHERE IN THIS TABLE'S REPOSITORY (plan ruling #6). Every
 * write is a plain INSERT, a keyed UPDATE, or a keyed soft delete — so the partial-arbiter
 * 42P10 hazard that forces `upsertApirocConnection` to restate its `targetWhere` cannot
 * arise here at all. Do not "add the missing targetWhere" to a statement that has no
 * conflict clause.
 *
 * ⚠ NO RLS, matching every other table in this package except `stripe_webhook_events`. It is
 * reached only through `calendarSubscriptionsRepository` on the admin `db` client, which
 * bypasses RLS anyway.
 */
export const calendarSubscriptions = pgTable(
  'calendar_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * ⚠ MINTED BY THE CALLER BEFORE THE VENDOR CALL is the id in `webhook_url` — see
     * `insertSubscription`'s docblock. The FK is `ON DELETE cascade`, matching
     * `calendar_sub_calendars`: identity survives a calendar RENAME (the vendor calendar id
     * is stable, the display name is not), and one hop reaches `expert_profile_id`, which is
     * what the webhook needs to enqueue the rebuild.
     */
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => calendarConnections.id, { onDelete: 'cascade' }),
    /**
     * The vendor calendar this subscription covers. `text`, not a bounded varchar: a
     * Microsoft Graph calendar id is ~152 chars of base64 (apiroc skill, Constraint 14).
     */
    calendarId: text('calendar_id').notNull(),
    /**
     * ⚠⚠ THE ID YOU PASS TO `calendarSubscriptions.delete` — and it is the LIST MODEL'S `id`
     * FIELD, **NOT** its field literally named `subscriptionId`. The list model carries BOTH:
     * `id` (= the create response's `webhookSubscriptionId`, e.g. `cmssoyzws1qs2oi2k08up0zjo`)
     * and `subscriptionId` (the PROVIDER channel uuid, e.g. `ebd61d9d-…`, a Google `watch`
     * ref). Passing the latter to `delete` is a SILENT NO-OP that leaves a live subscription
     * delivering for the full 7-day TTL. Store `id`; never store or read `subscriptionId` or
     * `resourceId`.
     */
    webhookSubscriptionId: text('webhook_subscription_id').notNull(),
    /**
     * The Svix verification secret for this endpoint. **ENCRYPTED AT REST** by
     * `apps/api/src/lib/calendar-encryption.ts` (AES-256-GCM under its OWN key — never
     * `PAYOUT_ENCRYPTION_KEY`). This repository never encrypts or decrypts; it stores the
     * ciphertext it is handed.
     *
     * ⚠ NEVER LOGGED, never an analytics property, never in an error body. The webhook is
     * the only reader: it decrypts, verifies, and discards.
     */
    endpointSecret: text('endpoint_secret').notNull(),
    /**
     * The exact URL registered at the vendor (`${base}/webhooks/apiroc/calendar/${id}`).
     * Load-bearing for the ORPHAN rule — `calendarSubscriptions.list` echoes it back
     * verbatim, so a vendor record whose url carries Balo's prefix but names a row id that is
     * live nowhere is a leaked registration to delete. Also the audit trail a human uses to
     * reconcile Balo's rows against the vendor's by eye.
     */
    webhookUrl: text('webhook_url').notNull(),
    /**
     * ⚠ READ FROM `calendarSubscriptions.list` ONLY. **The create response has no such key at
     * all** — not `null`, ABSENT — so `response.expiration` is `undefined` and a
     * `=== null` check on it never fires. It arrives as an ISO 8601 string; parse at the
     * boundary into this `timestamptz`. NULLABLE because it is genuinely unknown between the
     * create and the verification pass that follows it.
     */
    expiration: timestamp('expiration', { withTimezone: true }),
    /**
     * When `list` last CONFIRMED this row still exists at the vendor. Distinguishes "expiring"
     * from "we have not looked recently" — which is what lets the daily expiry monitor read
     * Balo's own column instead of making N vendor calls of its own, and closes the apiroc
     * skill's "if the vendor DOES auto-renew, a monitor reading only our column would alert
     * forever" hazard: the reconciler re-reads `list` and re-stamps roughly hourly, so this
     * column tracks the vendor's within one probe interval.
     */
    expirationSyncedAt: timestamp('expiration_synced_at', { withTimezone: true }),
    /**
     * Stamped by the webhook on a VERIFIED delivery. Liveness evidence: a subscription that
     * has never delivered while its sibling calendars have is a silent provider-channel death
     * that no expiry check can see. A read-only ops signal in this PR — nothing branches on it.
     */
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    ...timestamps,
    ...softDelete,
  },
  (table) => ({
    /**
     * UNIQUE on the VENDOR id, PARTIAL on `deleted_at IS NULL`.
     *
     * A vendor id is never reissued, so a non-partial unique would also be correct today.
     * Partial is chosen because this table DOES soft-delete and the house footgun
     * (`reference_softdelete_nonpartial_unique_recreate`) is that a soft-deleted row keeps
     * occupying a non-partial unique key forever. No `ON CONFLICT` statement targets this
     * index (see the table docblock), so making it partial costs nothing.
     *
     * ⚠ The migration SQL carries the `WHERE deleted_at IS NULL` predicate and is the SOURCE
     * OF TRUTH — verify the emitted `CREATE ... INDEX` after `db:generate`, exactly as
     * `availability_cache`'s docblock and `cal_conn_expert_provider_idx` (migration 0067)
     * record.
     */
    vendorIdIdx: uniqueIndex('cal_wsub_vendor_id_idx')
      .on(table.webhookSubscriptionId)
      .where(sql`${table.deletedAt} IS NULL`),
    /**
     * ⚠⚠ NON-UNIQUE, AND THAT IS RULING #5 — see the table docblock. Two live rows for one
     * pair is the legitimate create-then-delete renewal overlap. This index exists for the
     * reconciler's per-connection read and the canonicity grouping, not for uniqueness.
     * Partial on live rows because a soft-deleted subscription is never a plan input.
     */
    connCalendarIdx: index('cal_wsub_conn_calendar_idx')
      .on(table.connectionId, table.calendarId)
      .where(sql`${table.deletedAt} IS NULL`),
    /**
     * The daily monitor's `expiration < threshold` scan. Partial on live rows: a soft-deleted
     * subscription is never an expiry candidate, and including it would make every teardown
     * look like an outage.
     */
    expirationIdx: index('cal_wsub_expiration_idx')
      .on(table.expiration)
      .where(sql`${table.deletedAt} IS NULL`),
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
  /**
   * ⚠ `many`, and it can legitimately hold TWO live rows for one calendar during a
   * create-then-delete renewal overlap (see `calendarSubscriptions`' docblock). Any consumer
   * that wants "the" subscription for a calendar must take the NEWEST live row, not `[0]` of
   * an unordered hydration.
   *
   * ⚠ Relational `with:` hydrates FULL rows — including `endpoint_secret`. Never hydrate this
   * relation onto anything client-bound; use explicit `columns:` if you ever must
   * (`reference_drizzle_with_hydration_leaks_secrets`).
   */
  subscriptions: many(calendarSubscriptions),
}));

export const calendarSubscriptionsRelations = relations(calendarSubscriptions, ({ one }) => ({
  connection: one(calendarConnections, {
    fields: [calendarSubscriptions.connectionId],
    references: [calendarConnections.id],
  }),
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
export type CalendarSubscription = typeof calendarSubscriptions.$inferSelect;
export type NewCalendarSubscription = typeof calendarSubscriptions.$inferInsert;
export type AvailabilityCache = typeof availabilityCache.$inferSelect;
export type NewAvailabilityCache = typeof availabilityCache.$inferInsert;
