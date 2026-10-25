import { eq, and, isNull, desc, sql, count, gte } from 'drizzle-orm';
import { db } from '../client';
import { userNotifications, type UserNotification, type NewUserNotification } from '../schema';

export const userNotificationsRepository = {
  /**
   * Insert a user notification
   */
  insert: async (data: NewUserNotification): Promise<UserNotification> => {
    const [row] = await db.insert(userNotifications).values(data).returning();
    return row!;
  },

  /**
   * Find unread notifications for a user (excludes soft-deleted)
   */
  findUnreadByUserId: async (userId: string, limit = 20): Promise<UserNotification[]> => {
    return db
      .select()
      .from(userNotifications)
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.deletedAt)
        )
      )
      .orderBy(desc(userNotifications.createdAt))
      .limit(limit);
  },

  /**
   * Find all notifications for a user (excludes soft-deleted)
   */
  findByUserId: async (userId: string, limit = 50, offset = 0): Promise<UserNotification[]> => {
    return db
      .select()
      .from(userNotifications)
      .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.deletedAt)))
      .orderBy(desc(userNotifications.createdAt))
      .limit(limit)
      .offset(offset);
  },

  /**
   * Count unread notifications for a user (excludes soft-deleted)
   */
  countUnreadByUserId: async (userId: string): Promise<number> => {
    const [result] = await db
      .select({ value: count() })
      .from(userNotifications)
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.deletedAt)
        )
      );
    return result!.value;
  },

  /**
   * Count unread notifications created after `since` (excludes soft-deleted).
   * Backs the "unseen" count: unread items the user has not yet been told about.
   * `created_at` has microsecond precision while the cursor round-trips through a
   * millisecond-precision JS Date, so the bound is `since + 1ms`: a row created within the
   * same millisecond as the cursor is the item the cursor was set from, not a new one.
   */
  countUnseenByUserId: async (userId: string, since: Date): Promise<number> => {
    const [result] = await db
      .select({ value: count() })
      .from(userNotifications)
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.deletedAt),
          gte(
            userNotifications.createdAt,
            sql`${since.toISOString()}::timestamptz + interval '1 millisecond'`
          )
        )
      );
    return result?.value ?? 0;
  },

  /**
   * Mark unread notifications whose `action_url` path (the text before the first `?`) equals
   * `path` as read. Exact match: `/projects/p1` does not match `/projects/p1/files` or
   * `/projects/p10`. A null `action_url` never matches. Returns the updated ids.
   */
  markReadByActionPath: async (userId: string, path: string): Promise<string[]> => {
    const rows = await db
      .update(userNotifications)
      .set({ readAt: sql`NOW()` })
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.deletedAt),
          sql`split_part(${userNotifications.actionUrl}, '?', 1) = ${path}`
        )
      )
      .returning({ id: userNotifications.id });
    return rows.map((row) => row.id);
  },

  /**
   * Mark a single notification as read (excludes soft-deleted)
   * Returns the updated row or null if not found / wrong user
   */
  markAsRead: async (id: string, userId: string): Promise<UserNotification | null> => {
    const [row] = await db
      .update(userNotifications)
      .set({ readAt: sql`NOW()` })
      .where(
        and(
          eq(userNotifications.id, id),
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.deletedAt)
        )
      )
      .returning();
    // If already read, return the existing notification instead of null
    if (!row) {
      const [existing] = await db
        .select()
        .from(userNotifications)
        .where(
          and(
            eq(userNotifications.id, id),
            eq(userNotifications.userId, userId),
            isNull(userNotifications.deletedAt)
          )
        );
      return existing ?? null;
    }
    return row;
  },

  /**
   * Mark all unread notifications as read for a user (excludes soft-deleted)
   * Returns the count of updated rows
   */
  markAllAsRead: async (userId: string): Promise<number> => {
    const rows = await db
      .update(userNotifications)
      .set({ readAt: sql`NOW()` })
      .where(
        and(
          eq(userNotifications.userId, userId),
          isNull(userNotifications.readAt),
          isNull(userNotifications.deletedAt)
        )
      )
      .returning();
    return rows.length;
  },
};
