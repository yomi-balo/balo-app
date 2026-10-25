import { eq, and, isNull, isNotNull, desc, sql } from 'drizzle-orm';
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
   * Notifications for the panel: up to `unreadLimit` unread rows followed by up to `readLimit`
   * read rows, each newest first (excludes soft-deleted). Unread rows are selected independently
   * of read ones, so a burst of newer read items can never push an unread item out of the result.
   */
  findPanelByUserId: async (
    userId: string,
    { unreadLimit, readLimit }: { unreadLimit: number; readLimit: number }
  ): Promise<UserNotification[]> => {
    const forUser = and(eq(userNotifications.userId, userId), isNull(userNotifications.deletedAt));
    const [unreadRows, readRows] = await Promise.all([
      db
        .select()
        .from(userNotifications)
        .where(and(forUser, isNull(userNotifications.readAt)))
        .orderBy(desc(userNotifications.createdAt))
        .limit(unreadLimit),
      db
        .select()
        .from(userNotifications)
        .where(and(forUser, isNotNull(userNotifications.readAt)))
        .orderBy(desc(userNotifications.createdAt))
        .limit(readLimit),
    ]);
    return [...unreadRows, ...readRows];
  },

  /**
   * Count unread notifications and, among them, those created after `since` (excludes
   * soft-deleted), in one query. "Unseen" is unread items the user has not yet been told about;
   * it is 0 when `since` is null (cursor never initialised).
   * `created_at` has microsecond precision while the cursor round-trips through a
   * millisecond-precision JS Date, so the bound is `since + 1ms`: a row created within the
   * same millisecond as the cursor is the item the cursor was set from, not a new one.
   */
  countUnreadAndUnseenByUserId: async (
    userId: string,
    since: Date | null
  ): Promise<{ unread: number; unseen: number }> => {
    const unseen =
      since === null
        ? sql<number>`0`
        : sql<number>`(count(*) filter (where ${userNotifications.readAt} is null and ${userNotifications.createdAt} >= ${since.toISOString()}::timestamptz + interval '1 millisecond'))::int`;
    const [result] = await db
      .select({
        unread: sql<number>`(count(*) filter (where ${userNotifications.readAt} is null))::int`,
        unseen,
      })
      .from(userNotifications)
      .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.deletedAt)));
    return { unread: result?.unread ?? 0, unseen: result?.unseen ?? 0 };
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
