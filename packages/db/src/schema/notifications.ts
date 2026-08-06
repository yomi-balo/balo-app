import { pgTable, uuid, varchar, text, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * `notification_log` — the best-effort, write-AFTER-the-send delivery audit.
 *
 * BAL-341 IS ABSORBED HERE (ADR-1047 Decision 8). Before this change an entire class of
 * deliveries was INVISIBLE, because `logNotification` swallows its errors:
 *
 *   · the ADMIN/OPS path set `recipient_id = OPS_NOTIFICATION_EMAIL` — a bare string into a
 *     `uuid NOT NULL` column → `22P02`, swallowed. There was NO record that Balo's own ops
 *     inbox had ever been emailed.
 *   · the EXTERNAL path used the invite row's uuid as `recipient_id` — a valid uuid that is
 *     not a `users.id` → `23503`, swallowed.
 *   · `correlation_id uuid NOT NULL` rejected every COMPOSITE key publishers actually mint
 *     (`${session.id}:settled`, `u1:onboarding_reminder:1`,
 *     `wallet-1:dormancy_reminder:60:2027-07-12`) → `22P02`, swallowed. The 17 SERVER-ONLY
 *     events bypass the `z.uuid()`-validated publish route, so that is exactly the set
 *     minting composites.
 *
 * ⚠ SHARP EDGE, stated because `logNotification` still swallows (deliberately — a
 * best-effort audit write must NEVER fail a send): a code path that sets BOTH or NEITHER
 * recipient column now trips the CHECK **invisibly**. The three delivery shapes are proven
 * by test rather than trusted to review.
 *
 * WHY WIDENING ALONE DOES NOT CREATE SEND-ONCE: this table is written AFTER the Brevo send
 * and is never read before one, and `correlation_id` carries a plain index, not a unique
 * constraint. A delivered-once guarantee needs a unique dedup tuple, a claim-before-send
 * write and a reconcile path — that is `scheduled_notifications`, not this table.
 */
export const notificationLog = pgTable(
  'notification_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    event: varchar('event', { length: 100 }).notNull(),
    /**
     * `text`, NOT `uuid` (BAL-341). Publishers legitimately mint composite string keys, and
     * a `uuid` column rejected every one of them. The widening is safe: plain non-unique
     * index, no joins anywhere, and `findByCorrelationId` uses `eq()` only.
     */
    correlationId: text('correlation_id').notNull(),
    /**
     * NULLABLE since BAL-341. Set for an ordinary platform user; NULL for the ops inbox and
     * for external (non-user) email recipients, which carry `recipient_email` instead.
     */
    recipientId: uuid('recipient_id').references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The literal address a delivery went to when the recipient is NOT a platform user:
     * Balo's ops inbox (`recipient: 'admin'`) or an external invitee (`email_address`).
     * 320 = the RFC 5321 maximum, matching `users.email`.
     */
    recipientEmail: varchar('recipient_email', { length: 320 }),
    channel: varchar('channel', { length: 20 }).notNull(),
    template: varchar('template', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(), // 'sent' | 'failed' | 'skipped'
    error: text('error'),
    metadata: jsonb('metadata'),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('notification_log_correlation_id_idx').on(table.correlationId),
    index('notification_log_recipient_id_idx').on(table.recipientId),
    /** New column, new WHERE clause (`findByRecipientEmail`) → new index. */
    index('notification_log_recipient_email_idx').on(table.recipientEmail),
    index('notification_log_created_at_idx').on(table.createdAt),
    index('notification_log_event_status_idx').on(table.event, table.status),
    /**
     * EXACTLY ONE recipient identity per row. `<>` on two booleans is XOR, so this rejects
     * both-set and neither-set while permitting either alone. Without it, dropping
     * `NOT NULL` from `recipient_id` would silently admit rows that name no recipient at
     * all — an audit table whose rows cannot say who was audited.
     */
    check(
      'notification_log_recipient_exactly_one',
      sql`(${table.recipientId} IS NULL) <> (${table.recipientEmail} IS NULL)`
    ),
  ]
);

export type NotificationLog = typeof notificationLog.$inferSelect;
export type NewNotificationLog = typeof notificationLog.$inferInsert;
