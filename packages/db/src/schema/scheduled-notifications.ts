import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { scheduledNotificationStatusEnum, scheduledNotificationModeEnum } from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * The stored shape of `scheduled_notifications.payload`.
 *
 * ⚠ DELIBERATELY `Record<string, unknown>` WITH NO `Date` FIELD ANYWHERE. jsonb serialises
 * a `Date` to an ISO **string**, so a `$type<{ …: Date }>()` annotation LIES on read: the
 * value comes back a string while TypeScript insists it is a `Date`, and a null-only test
 * never catches it (memory `reference_jsonb_date_type_lie`; ADR-1047 R9). Type the column
 * as what is actually STORED and parse at the boundary. Every notification event payload in
 * this codebase already carries timestamps as ISO strings, so nothing is lost.
 */
export type ScheduledNotificationPayload = Record<string, unknown>;

/**
 * `scheduled_notifications` (BAL-420 / ADR-1047 Decision 4) — ONE durable row per
 * "publish this notification EVENT at time T, once, unless the reason has gone away".
 *
 * WHAT IS SCHEDULED IS THE EVENT, NOT THE DELIVERY (Decision 2). The row stores
 * `(event, payload)`; when it fires the dispatch tick calls the ordinary
 * `notificationEvents.publish(event, payload)` and the engine runs exactly as it does
 * today. So every `NotificationRule` stays `timing: 'immediate'` and that statement stays
 * literally true — the rules table is untouched by this feature.
 *
 * POSTGRES IS THE CLOCK; BullMQ is only the ticker (Decision 3). There is no
 * `queue.add(…, { delay })` anywhere. A 30-day promise is a Postgres guarantee, not a
 * Redis one; cancellation is an exact `UPDATE`; and BullMQ jobId eviction stops being
 * load-bearing.
 *
 * NO RLS — matches the as-built posture of every table in this schema (ADR-1040
 * Decision 4). This table is reached ONLY by `apps/api` through the admin `db` client,
 * which bypasses RLS anyway; a policy here would be both inconsistent and inert. There is
 * no user-facing surface: scheduling is API-internal, with no HTTP route for `schedule`
 * and — permanently — none for `cancel` (Decisions 10 and 11).
 *
 * NOT MERGED INTO `notification_log`. They share `correlation_id` as a soft join key and
 * nothing else (no FK either way):
 *   · this table is written BEFORE a send, as intent + claim; the log is written AFTER,
 *     as outcome;
 *   · this table is READ before a send — it IS the gate; the log never is;
 *   · this table's writes FAIL LOUD; the log's write swallows (best-effort audit).
 *
 * SYSTEM ACTOR (ADR-1030): a scheduled send has no acting user, so this table records
 * *what and when*, never *who*, and writes no `audit_events` row of its own — BAL-387's
 * system-actor attribution exemption.
 */
export const scheduledNotifications = pgTable(
  'scheduled_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * CALLER-OWNED dedup handle AND cancel handle. The caller is the only party that knows
     * what makes two schedules "the same one", so it mints the key (e.g.
     * `meeting_expert_absent:<meetingId>`). `text`, not `varchar` — keys are composed from
     * ids and verbs and must never be silently truncated.
     */
    dedupeKey: text('dedupe_key').notNull(),

    /** The notification event to publish at fire time. Mirrors `notification_log.event`. */
    event: varchar('event', { length: 100 }).notNull(),

    /**
     * The payload to publish. See `ScheduledNotificationPayload` for why there is no
     * `Date` in the type.
     *
     * CONTRACT ON SCHEDULED PAYLOADS (ADR Decision 4) — a promise held for up to 30 days
     * is not a job that runs in 200ms:
     *   · SELF-SUFFICIENT AT FIRE TIME — ids and facts, never request-scoped context.
     *   · NO PII BEYOND WHAT AN EVENT PAYLOAD ALREADY CARRIES. This row sits in Postgres
     *     for the life of the promise; the `email_address` recipient path's deliberate
     *     PII-in-payload exception must be re-justified per consumer before scheduling.
     */
    payload: jsonb('payload').$type<ScheduledNotificationPayload>().notNull(),

    /** When the promise becomes due. A time in the PAST is legal — the next tick fires it. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),

    status: scheduledNotificationStatusEnum('status').notNull().default('pending'),
    mode: scheduledNotificationModeEnum('mode').notNull().default('first_wins'),

    /**
     * NAME of the fire-time guard in `SCHEDULED_RECHECKS`, never a closure — the row lives
     * in Postgres for up to 30 days and must survive deploys, and a serialized function
     * cannot. `NULL` ⇒ publish the stored payload unconditionally. An unregistered name
     * FAILS LOUD (terminal `failed`), never a silent publish and never a silent skip
     * (ADR Decision 7).
     */
    recheck: varchar('recheck', { length: 100 }),

    /** Incremented BY THE CLAIM, so a send that dies mid-flight still consumes an attempt. */
    attempts: integer('attempts').notNull().default(0),

    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    /** Why a recheck declined to publish. A NORMAL outcome — must not read as a failure. */
    skipReason: text('skip_reason'),
    /** Why a dispatch FAILED. Deliberately a separate column from `skip_reason`. */
    lastError: text('last_error'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * THE DEDUP TUPLE — at most one PENDING row per key. PARTIAL ON BOTH halves, and both
     * halves are load-bearing:
     *
     *  · `deleted_at IS NULL` — the hard-learned house convention (`conversation_read_states`,
     *    `request_expert_relationships`): soft-delete plus a NON-partial unique makes any
     *    re-create silently fail.
     *  · `status = 'pending'` — this is what makes a key RE-SCHEDULABLE after it fires. A
     *    bare unique on `dedupe_key` would permit ONE notification per key, EVER; for a
     *    conversation-scoped key that is one new-message email per thread for the thread's
     *    entire lifetime.
     *
     * ⚠ THE `ON CONFLICT` ARBITER MUST REPEAT THIS PREDICATE EXACTLY (`targetWhere` in the
     * repository). Postgres cannot infer a partial index whose predicate is not implied by
     * the `ON CONFLICT … WHERE` clause, and the upsert then throws a raw `23505` on the
     * second schedule instead of folding. Same requirement the `conversation_read_states`
     * upsert already meets.
     */
    uniqueIndex('scheduled_notification_pending_key_idx')
      .on(t.dedupeKey)
      .where(sql`${t.status} = 'pending' AND ${t.deletedAt} IS NULL`),

    /** The tick's due-scan: pending rows whose `scheduled_for` has passed. */
    index('scheduled_notification_due_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} = 'pending' AND ${t.deletedAt} IS NULL`),

    /** The claim-TTL reconcile scan: rows stranded `claimed` by a send that died. */
    index('scheduled_notification_claimed_idx')
      .on(t.claimedAt)
      .where(sql`${t.status} = 'claimed' AND ${t.deletedAt} IS NULL`),

    /** Ops/debug lookups by key across ALL statuses ("why hasn't this fired?"). */
    index('scheduled_notification_key_idx').on(t.dedupeKey),

    check('scheduled_notification_dedupe_key_nonempty', sql`length(btrim(${t.dedupeKey})) > 0`),
    check('scheduled_notification_attempts_nonneg', sql`${t.attempts} >= 0`),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type ScheduledNotification = typeof scheduledNotifications.$inferSelect;
export type NewScheduledNotification = typeof scheduledNotifications.$inferInsert;
export type ScheduledNotificationStatus =
  (typeof scheduledNotificationStatusEnum.enumValues)[number];
export type ScheduledNotificationMode = (typeof scheduledNotificationModeEnum.enumValues)[number];
