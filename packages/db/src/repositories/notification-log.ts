import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '../client';
import { notificationLog, type NotificationLog, type NewNotificationLog } from '../schema';

export const notificationLogRepository = {
  /**
   * Insert a notification log entry.
   *
   * SINCE BAL-341 (ADR-1047 Decision 8) THE RECIPIENT IS ONE OF TWO SHAPES, never both and
   * never neither — the DB CHECK `notification_log_recipient_exactly_one` is the backstop:
   *
   *   | delivery shape           | recipientId | recipientEmail   |
   *   |--------------------------|-------------|------------------|
   *   | ordinary platform user   | user uuid   | (omit)           |
   *   | Balo ops inbox (`admin`) | (omit)      | the ops address  |
   *   | external invitee         | (omit)      | the invitee's    |
   *
   * The rule the caller applies: **a literal address present ⇒ use `recipientEmail` and
   * leave `recipientId` unset.** For the external case that drops the invite-row uuid the
   * old code jammed into `recipient_id` — no loss, because `dispatchExternalEmail` already
   * passes that same uuid as the `correlationId`, and it was never a valid `users.id` (it
   * threw `23503` and the write was silently swallowed).
   *
   * ⚠ THIS THROWS RATHER THAN VALIDATING IN-PROCESS, AND ITS CALLER SWALLOWS. `logNotification`
   * keeps its swallowing catch deliberately — a best-effort audit write must never fail a
   * send — so a code path that sets both or neither column fails INVISIBLY, as a logged
   * error rather than a broken delivery. That is the accepted trade (ADR R10); the three
   * shapes are pinned by test instead.
   */
  insert: async (data: NewNotificationLog): Promise<NotificationLog> => {
    const [row] = await db.insert(notificationLog).values(data).returning();
    return row!;
  },

  /**
   * Find all notification logs for a correlation ID (excludes soft-deleted).
   *
   * `correlationId` is a `string` because the column is now `text`, not `uuid` (BAL-341).
   * Publishers legitimately mint COMPOSITE keys — `${session.id}:settled`,
   * `u1:onboarding_reminder:1`, `wallet-1:dormancy_reminder:60:2027-07-12` — and every one
   * of them used to be rejected with `22P02` and swallowed. `eq()` on `text` is the only
   * read, so the widening changed no call site.
   */
  findByCorrelationId: async (correlationId: string): Promise<NotificationLog[]> => {
    return db
      .select()
      .from(notificationLog)
      .where(
        and(eq(notificationLog.correlationId, correlationId), isNull(notificationLog.deletedAt))
      )
      .orderBy(desc(notificationLog.createdAt));
  },

  /**
   * Find notification logs for a platform user (excludes soft-deleted).
   *
   * Only ever matches user-recipient rows: ops-inbox and external rows carry a NULL
   * `recipient_id` and are reachable through `findByRecipientEmail` instead.
   */
  findByRecipientId: async (recipientId: string, limit = 50): Promise<NotificationLog[]> => {
    return db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.recipientId, recipientId), isNull(notificationLog.deletedAt)))
      .orderBy(desc(notificationLog.createdAt))
      .limit(limit);
  },

  /**
   * Find notification logs delivered to a literal address (excludes soft-deleted) — the
   * ops inbox and external invitees, i.e. exactly the rows BAL-341 makes land for the first
   * time. Without this read, the new column would be write-only and "was our ops inbox
   * actually emailed about this?" would still be unanswerable.
   */
  findByRecipientEmail: async (recipientEmail: string, limit = 50): Promise<NotificationLog[]> => {
    return db
      .select()
      .from(notificationLog)
      .where(
        and(eq(notificationLog.recipientEmail, recipientEmail), isNull(notificationLog.deletedAt))
      )
      .orderBy(desc(notificationLog.createdAt))
      .limit(limit);
  },
};
