import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// TYPE-ONLY. `@balo/db` already depends on `@balo/shared`; the reverse is forbidden (a client
// component that value-imports `@balo/db` drags the `postgres` driver into the bundle), which
// is why the evidence shape lives on the shared side and is imported here as a type.
import type { AdminAlertDetail } from '@balo/shared/admin-alerts';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * admin_alerts (BAL-548 / ADR-1055) — THE PENDING-ACTIONS QUEUE. One open row per thing that
 * needs a person, carrying the evidence as it was when the problem was found.
 *
 * ── LEVEL-TRIGGERED, NOT EDGE-TRIGGERED ───────────────────────────────────────────────
 * Most kinds are found by a SWEEP that re-runs a bounded finder read every tick: a finding
 * that is still true bumps the existing row, a finding that has gone away RESOLVES it. That
 * self-closing property is the whole design — an alert nobody can clear becomes an alert
 * nobody reads. The remaining kinds are event-driven (`finder: null` in the registry) and
 * close only with a person's note.
 *
 * ⚠ READS NEVER WRITE (ADR-1055 D3). No approve / pay / repair path anywhere may resolve a
 * row as a side effect: the sweep closes finder kinds, a person closes event-driven ones, and
 * nothing else touches `resolved_at`. Two source-scanning invariants fence this.
 *
 * ⚠ A RESOLVED ROW IS NEVER REOPENED. Recurrence is a NEW row — which is exactly what the
 * partial-unique arbiter below buys: resolving frees the (kind, entity) slot.
 *
 * ── POLYMORPHIC: `entity_id` HAS NO FOREIGN KEY, DELIBERATELY ─────────────────────────
 * `entity_type` decides which of six tables `entity_id` points at, and Postgres cannot
 * express that. Same FK-less seam shape as `meeting_contexts.context_id` and
 * `internal_notes.entity_id`, with the same consequence: a deleted parent leaves an orphan
 * row, which is acceptable because a finder kind's next tick resolves it and an event-driven
 * kind is closed by a person reading it.
 *
 * ⚠ `entity_id` IS NOT NULL, AND THAT IS LOAD-BEARING. A NULL is never equal to another NULL,
 * so a nullable column DEFEATS the partial-unique arbiter — every sweep-scoped raise would
 * insert a fresh row instead of bumping the incumbent. Rows that are about the SWEEP rather
 * than about an entity carry the registry's fixed sentinel uuid.
 *
 * ── `kind` IS `text`, NOT A pgEnum ────────────────────────────────────────────────────
 * Kinds change often, and an `ALTER TYPE … ADD VALUE` per kind is exactly the migration tax
 * the registry exists to avoid. `@balo/shared/admin-alerts` validates at every write site;
 * the database does not. It also lets a `<kind>.storm` row exist without a second vocabulary.
 *
 * ── NO RLS — A KNOWING DEVIATION, RECORDED ────────────────────────────────────────────
 * NOT ONE schema file in this package CALLS `.enableRLS()` or `pgPolicy()`. Balo
 * authenticates with WorkOS + iron-session, so `auth.uid()` is always null and a
 * Supabase-shaped policy would be decoration; every reader is the admin `db` client (which
 * bypasses RLS anyway) and the boundary is the application layer (ADR-1029 / ADR-1035 —
 * every read and write here gates on a PLATFORM capability). ⚠ This is a conscious deviation
 * from the `drizzle-schema` skill, which lists "Forgetting RLS on new tables" under What NOT
 * to Do — flagged in the PR body, as `representations.ts` and `internal-notes.ts` both do.
 *
 * ── NO `relations()` BLOCK ────────────────────────────────────────────────────────────
 * Nothing needs a relational `with:`, and a hydration of `users` for `resolved_by_user_id`
 * would pull `workos_id` and the full PII row (memory
 * `reference_drizzle_with_hydration_leaks_secrets`). The BAL-541 call, verbatim: if a surface
 * ever needs the closer's name it LEFT JOINs `users` with an explicit three-column
 * projection. The Home page cannot need it at all — it lists OPEN rows, where
 * `resolved_by_user_id` is NULL by construction.
 */
export const adminAlerts = pgTable(
  'admin_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** A registry key (`@balo/shared/admin-alerts`) or a derived `<base>.storm`. See above. */
    kind: text('kind').notNull(),

    /** Which table `entity_id` names — `expert` | `company` | … | `sweep`. See above. */
    entityType: text('entity_type').notNull(),

    /** ⚠ NEVER NULLABLE — a NULL defeats the arbiter. Sweep-scoped rows use the sentinel. */
    entityId: uuid('entity_id').notNull(),

    /**
     * ⚠ THE EVIDENCE SNAPSHOT, AND THE ROW'S WHOLE VISIBLE CONTENT — see
     * `AdminAlertDetail`. REPLACED wholesale on every raise/bump (newest evidence wins),
     * never merged.
     *
     * ⚠ THE `'{}'::jsonb` DEFAULT DOES NOT SATISFY `AdminAlertDetail`, AND NOTHING MAY RELY
     * ON IT. It is a belt for a hand-written repair row, not an insert path: both writers
     * (`raise`, `reconcileKind`) take a required `detail` and always name the column. A row
     * that reached `{}` would render blank, which is the reading, not a crash.
     */
    detail: jsonb('detail')
      .$type<AdminAlertDetail>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * ⚠ THE SORT KEY. The queue is oldest-FIRST on `first_seen_at`, NEVER on `last_seen_at` —
     * a bump must not push a row that has been waiting a week back to the bottom.
     */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),

    /** Advanced by every raise and by every sweep tick that still finds the condition. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),

    /**
     * ⚠ INCREMENTS ONLY ON `raise()` — an EVENT happened again. A sweep tick that re-finds a
     * standing condition is not a new occurrence and leaves this untouched; incrementing it
     * per tick would turn "raised 3×" into "the sweep has run 4,000 times".
     */
    occurrences: integer('occurrences').notNull().default(1),

    /** NULL ⇒ open. The queue's whole "open" predicate; there is no `status` column. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    /**
     * WHO closed it — NULL when the SWEEP did (the condition went away), set when a person
     * did. ATTRIBUTION ⇒ `restrict`, the dominant `users` reference in this schema
     * (36 restrict / 6 cascade / 3 set null) and the ADR-1030 rule `internal_notes`'
     * `author_user_id` and `project_requests.closed_by_user_id` already follow.
     */
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    /** The person's "what I did about it" line. NULL ⇔ the sweep closed it (CHECK below). */
    resolutionNote: text('resolution_note'),

    ...timestamps,

    /**
     * ⚠ v1 SHIPS NO WRITER FOR `deleted_at`, AND THAT IS DELIBERATE, NOT AN OVERSIGHT.
     *
     * ADR-1055 criticises `user_notifications` for carrying a `deleted_at` nothing writes.
     * THIS one is load-bearing anyway, for two reasons the criticised one cannot claim:
     *  1. it is half the ARBITER PREDICATE below (which must name TIMESTAMP COLUMNS ONLY),
     *     so it is read on every single upsert; and
     *  2. it is the escape hatch a future scrub path needs to hide a row WITHOUT colliding
     *     with the unique index — soft-deleting frees the (kind, entity) slot exactly the way
     *     resolving does.
     */
    ...softDelete,
  },
  (t) => [
    /**
     * ⚠⚠ THE ARBITER. ONE OPEN ROW PER (kind, entity). `adminAlertsRepository.raise` upserts
     * onto this index and `reconcileKind` reads through it — a second open row for the same
     * pair is the failure mode the whole queue is built to avoid.
     *
     * ⚠⚠ THE PREDICATE NAMES TIMESTAMP COLUMNS ONLY. That is the in-repo house rule, stated
     * emphatically at `meeting-recordings.ts` (the `capture_ended_at` docblock): an index
     * predicate references COLUMNS, never an enum literal, because a label added later by
     * `ALTER TYPE … ADD VALUE` may not be used in the same migration transaction. Here there
     * is no `status` column to be tempted by at all — "open" IS `resolved_at IS NULL`,
     * exactly as `meetings.ended_at` stands beside `status = 'ended'`.
     *
     * ⚠ `entity_id` IS NOT NULL, so this is NOT the two-clause `<col> IS NOT NULL AND
     * deleted_at IS NULL` shape `meeting_recording_daily_id_idx` uses for a NULLABLE key.
     * Both clauses here are STATE clauses: a row occupies the slot only while it is BOTH
     * unresolved AND live.
     *
     * ⚠⚠ ANY `ON CONFLICT` NAMING THIS INDEX MUST RESTATE THIS PREDICATE, AS RAW SQL. See
     * `adminAlertsRepository.raise` — Postgres answers 42P10 at RUNTIME otherwise, invisible
     * to `tsc` and to any test that never exercises the conflict path.
     */
    uniqueIndex('admin_alerts_open_uidx')
      .on(t.kind, t.entityId)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.deletedAt} IS NULL`),

    /**
     * THE HOME READ: open rows, OLDEST FIRST, keyset-paged over `(first_seen_at, id)`. Same
     * predicate as the arbiter, so both live in the same partial space and one bloat-free
     * index serves the list while the other serves the upsert.
     */
    index('admin_alerts_open_keyset_idx')
      .on(t.firstSeenAt, t.id)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.deletedAt} IS NULL`),

    /**
     * The `restrict` FK's delete-time scan (drizzle-schema skill: index every FK column). On
     * the `internal_notes_author_idx` reasoning: a restrict FK whose scan can actually run
     * needs an index, and `admin-dev/_actions/delete-user.ts` proves users really are
     * hard-deleted. NOT partial — the scan Postgres runs on delete ignores `deleted_at`.
     */
    index('admin_alerts_resolved_by_idx').on(t.resolvedByUserId),

    /**
     * ⚠⚠ A PERSON CLOSED IT ⇔ THERE IS A NOTE. The sweep closes with NEITHER (it stamps
     * `resolved_at` alone), a person closes with BOTH. Written as an equality of two
     * `IS NULL` tests, so it is TOTAL — no three-valued-logic hole, and no enum literal.
     */
    check(
      'admin_alerts_manual_close_carries_a_note',
      sql`(${t.resolvedByUserId} IS NULL) = (${t.resolutionNote} IS NULL)`
    ),

    /**
     * A resolver implies the row is resolved. Left disjunct is `IS NULL` (total) ⇒ the CHECK
     * is never NULL. Enum-literal-free.
     */
    check(
      'admin_alerts_resolution_attribution',
      sql`${t.resolvedByUserId} IS NULL OR ${t.resolvedAt} IS NOT NULL`
    ),

    /** `occurrences` starts at 1 and only ever grows. */
    check('admin_alerts_occurrences_positive', sql`${t.occurrences} >= 1`),
  ]
);

/**
 * admin_sweep_ticks (BAL-548 / ADR-1055) — ONE ROW PER SWEEP CADENCE, carrying the instant
 * that cadence last completed a tick. It is what the Home page's "swept Ns ago" staleness
 * disclosure reads, and it is what makes an EMPTY queue distinguishable from a DEAD sweep.
 *
 * ⚠⚠ WHY A TABLE AND NOT REDIS. `apps/web` HAS NO REDIS: no `ioredis` dependency, no
 * `REDIS_URL`, no client. A key written by `apps/api` would be unreadable by its only
 * consumer. (`repositories/audit-events.ts`'s `countByActorAndActionSince` docblock records
 * the same constraint, which is why `audit_events` doubles as a web-side rate-limit counter.)
 * A row also works on an EMPTY queue — which a `max(last_seen_at)` derivation does not — and
 * distinguishes the three cadences, which one Redis key does not.
 *
 * ── ⚠⚠ THREE DELIBERATE DEVIATIONS FROM THE HOUSE TABLE RULES, ALL RECORDED ───────────
 * CLAUDE.md says "Every table: `id` (UUID), `created_at`, `updated_at`" and "Soft deletes via
 * `deleted_at` — every table gets it". This table breaks THREE of those on purpose. Read them
 * as choices; do not "fix" any of them. FLAG ALL THREE IN THE PR BODY.
 *
 *  1. **`cadence` IS THE PRIMARY KEY — the codebase's FIRST non-uuid PK.** There are exactly
 *     three rows, ever (`'1m' | '5m' | '15m'`), and the cadence IS the identity. The payoff is
 *     concrete: the upsert's arbiter is a PRIMARY KEY, i.e. TOTAL, so it structurally cannot
 *     hit the 42P10 parameterised-partial-arbiter trap that `admin_alerts.raise` has to work
 *     around. `mux_webhook_events`' docblock makes the same "a non-partial arbiter is safe
 *     BECAUSE there is no soft-delete" argument.
 *
 *  2. **NO `id` COLUMN.** It follows from (1): a surrogate uuid beside a unique index on
 *     `cadence` would add a column nothing reads, nothing joins on and nothing can order by
 *     meaningfully. The `drizzle-schema` skill's "Always UUID" rule is about ENTITY tables
 *     with external references; nothing references a heartbeat.
 *
 *  3. **NO `...softDelete`.** The `mux_webhook_events` / `fx_display_rates` exception. A
 *     heartbeat row is last-write-wins and has no meaningful deleted state — and a
 *     soft-deletable one would be actively harmful: hiding the row would silently REMOVE the
 *     Home page's staleness disclosure, turning "the sweep died 40 minutes ago" into "no
 *     information", which is the one failure this table exists to make visible. ADR-1055's
 *     own critique of `user_notifications` is precisely "a `deleted_at` with no writer"; this
 *     is the version of that critique taken seriously rather than copied.
 *
 * `...timestamps` IS spread: `updated_at` is a second, free liveness signal, and `created_at`
 * records when a cadence first ran.
 */
export const adminSweepTicks = pgTable('admin_sweep_ticks', {
  /** `'1m' | '5m' | '15m'` — mirrors `AdminAlertCadence` in `@balo/shared/admin-alerts`. */
  cadence: text('cadence').primaryKey(),
  /** When this cadence last COMPLETED a tick (stamped at the end, never at the start). */
  lastTickAt: timestamp('last_tick_at', { withTimezone: true }).defaultNow().notNull(),
  ...timestamps,
});

// ── Type exports ───────────────────────────────────────────────────────

export type AdminAlert = typeof adminAlerts.$inferSelect;
export type NewAdminAlert = typeof adminAlerts.$inferInsert;
export type AdminSweepTick = typeof adminSweepTicks.$inferSelect;
export type NewAdminSweepTick = typeof adminSweepTicks.$inferInsert;
