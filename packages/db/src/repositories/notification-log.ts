import { eq, and, isNull, desc } from 'drizzle-orm';
import { db } from '../client';
import { notificationLog, type NotificationLog, type NewNotificationLog } from '../schema';

export const notificationLogRepository = {
  /**
   * Insert a notification log entry
   */
  insert: async (data: NewNotificationLog): Promise<NotificationLog> => {
    const [row] = await db.insert(notificationLog).values(data).returning();
    return row!;
  },

  /**
   * Find all notification logs for a correlation ID (excludes soft-deleted)
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
   * Find notification logs for a recipient (excludes soft-deleted)
   */
  findByRecipientId: async (recipientId: string, limit = 50): Promise<NotificationLog[]> => {
    return db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.recipientId, recipientId), isNull(notificationLog.deletedAt)))
      .orderBy(desc(notificationLog.createdAt))
      .limit(limit);
  },
};
