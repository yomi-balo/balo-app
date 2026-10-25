import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { userNotifications } from '../schema';
import { userFactory } from '../test/factories';
import { userNotificationsRepository } from './user-notifications';

// ── insert ──────────────────────────────────────────────────────────

describe('userNotificationsRepository.insert', () => {
  it('creates a notification with all fields, readAt defaults to null', async () => {
    const user = await userFactory({ firstName: 'Alice', lastName: 'Insert' });

    const row = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'New case assigned',
      body: 'You have been assigned a new case.',
      actionUrl: '/cases/123',
      metadata: { caseId: '123' },
    });

    expect(row.id).toBeDefined();
    expect(row.userId).toBe(user.id);
    expect(row.event).toBe('case.created');
    expect(row.title).toBe('New case assigned');
    expect(row.body).toBe('You have been assigned a new case.');
    expect(row.actionUrl).toBe('/cases/123');
    expect(row.metadata).toEqual({ caseId: '123' });
    expect(row.readAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.deletedAt).toBeNull();
  });
});

// ── findUnreadByUserId ──────────────────────────────────────────────

describe('userNotificationsRepository.findUnreadByUserId', () => {
  it('returns only unread notifications for the given user in desc order', async () => {
    const user = await userFactory({ firstName: 'Unread', lastName: 'Test' });

    // Explicit, distinct createdAt so `ORDER BY created_at DESC` is deterministic
    // (back-to-back inserts otherwise tie on created_at → flaky ordering in CI).
    const first = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'First notification',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const second = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.assigned',
      title: 'Second notification',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });

    const results = await userNotificationsRepository.findUnreadByUserId(user.id);

    expect(results).toHaveLength(2);
    // Most recent first (desc order)
    expect(results[0]!.id).toBe(second.id);
    expect(results[1]!.id).toBe(first.id);
  });

  it('respects the limit parameter', async () => {
    const user = await userFactory({ firstName: 'Limit', lastName: 'Unread' });

    for (let i = 0; i < 5; i++) {
      await userNotificationsRepository.insert({
        userId: user.id,
        event: `event.${i}`,
        title: `Notification ${i}`,
      });
    }

    const results = await userNotificationsRepository.findUnreadByUserId(user.id, 3);
    expect(results).toHaveLength(3);
  });

  it('excludes other users notifications', async () => {
    const user1 = await userFactory({ firstName: 'User', lastName: 'One' });
    const user2 = await userFactory({ firstName: 'User', lastName: 'Two' });

    await userNotificationsRepository.insert({
      userId: user1.id,
      event: 'case.created',
      title: 'User1 notification',
    });

    const results = await userNotificationsRepository.findUnreadByUserId(user2.id);
    expect(results).toHaveLength(0);
  });

  it('excludes read notifications', async () => {
    const user = await userFactory({ firstName: 'Read', lastName: 'Excl' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be read',
    });

    // Mark as read
    await userNotificationsRepository.markAsRead(notif.id, user.id);

    const results = await userNotificationsRepository.findUnreadByUserId(user.id);
    expect(results).toHaveLength(0);
  });

  it('excludes soft-deleted notifications', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'Del' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be deleted',
    });

    // Soft-delete the notification
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, notif.id));

    const results = await userNotificationsRepository.findUnreadByUserId(user.id);
    expect(results).toHaveLength(0);
  });
});

// ── findByUserId ────────────────────────────────────────────────────

describe('userNotificationsRepository.findByUserId', () => {
  it('returns all non-deleted notifications (read + unread) in desc order', async () => {
    const user = await userFactory({ firstName: 'All', lastName: 'Test' });

    // Explicit, distinct createdAt so `ORDER BY created_at DESC` is deterministic
    // (back-to-back inserts otherwise tie on created_at → flaky ordering in CI).
    const first = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'First notification',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const second = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.assigned',
      title: 'Second notification',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });

    // Mark the first one as read
    await userNotificationsRepository.markAsRead(first.id, user.id);

    const results = await userNotificationsRepository.findByUserId(user.id);

    expect(results).toHaveLength(2);
    // Most recent first (desc order)
    expect(results[0]!.id).toBe(second.id);
    expect(results[1]!.id).toBe(first.id);
    // First one should be read
    expect(results[1]!.readAt).not.toBeNull();
    // Second one should be unread
    expect(results[0]!.readAt).toBeNull();
  });

  it('respects limit and offset', async () => {
    const user = await userFactory({ firstName: 'Page', lastName: 'Test' });

    for (let i = 0; i < 5; i++) {
      await userNotificationsRepository.insert({
        userId: user.id,
        event: `event.${i}`,
        title: `Notification ${i}`,
      });
    }

    const page1 = await userNotificationsRepository.findByUserId(user.id, 2, 0);
    expect(page1).toHaveLength(2);

    const page2 = await userNotificationsRepository.findByUserId(user.id, 2, 2);
    expect(page2).toHaveLength(2);

    // Pages should not overlap
    const page1Ids = page1.map((n) => n.id);
    const page2Ids = new Set(page2.map((n) => n.id));
    expect(page1Ids.filter((id) => page2Ids.has(id))).toHaveLength(0);
  });

  it('excludes soft-deleted notifications', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'ByUser' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be deleted',
    });

    // Soft-delete
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, notif.id));

    const results = await userNotificationsRepository.findByUserId(user.id);
    expect(results).toHaveLength(0);
  });
});

// ── countUnreadByUserId ─────────────────────────────────────────────

describe('userNotificationsRepository.countUnreadByUserId', () => {
  it('returns correct count of unread notifications', async () => {
    const user = await userFactory({ firstName: 'Count', lastName: 'Test' });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Unread 1',
    });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.assigned',
      title: 'Unread 2',
    });

    const unreadCount = await userNotificationsRepository.countUnreadByUserId(user.id);
    expect(unreadCount).toBe(2);
  });

  it('returns 0 when all notifications are read', async () => {
    const user = await userFactory({ firstName: 'AllRead', lastName: 'Test' });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be read',
    });

    await userNotificationsRepository.markAllAsRead(user.id);

    const unreadCount = await userNotificationsRepository.countUnreadByUserId(user.id);
    expect(unreadCount).toBe(0);
  });

  it('returns 0 when user has no notifications', async () => {
    const user = await userFactory({ firstName: 'Empty', lastName: 'Test' });

    const unreadCount = await userNotificationsRepository.countUnreadByUserId(user.id);
    expect(unreadCount).toBe(0);
  });

  it('excludes soft-deleted notifications', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'Count' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be deleted',
    });

    // Soft-delete
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, notif.id));

    const unreadCount = await userNotificationsRepository.countUnreadByUserId(user.id);
    expect(unreadCount).toBe(0);
  });
});

// ── markAsRead ──────────────────────────────────────────────────────

describe('userNotificationsRepository.markAsRead', () => {
  it('sets readAt on the notification', async () => {
    const user = await userFactory({ firstName: 'Mark', lastName: 'Read' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'To be read',
    });

    const updated = await userNotificationsRepository.markAsRead(notif.id, user.id);

    expect(updated).not.toBeNull();
    expect(updated!.readAt).toBeInstanceOf(Date);
    expect(updated!.id).toBe(notif.id);
  });

  it('returns null for wrong id', async () => {
    const user = await userFactory({ firstName: 'Wrong', lastName: 'Id' });

    const result = await userNotificationsRepository.markAsRead(
      '00000000-0000-0000-0000-000000000000',
      user.id
    );
    expect(result).toBeNull();
  });

  it('returns null for wrong userId', async () => {
    const user1 = await userFactory({ firstName: 'Owner', lastName: 'Test' });
    const user2 = await userFactory({ firstName: 'Other', lastName: 'User' });

    const notif = await userNotificationsRepository.insert({
      userId: user1.id,
      event: 'case.created',
      title: 'Owned by user1',
    });

    const result = await userNotificationsRepository.markAsRead(notif.id, user2.id);
    expect(result).toBeNull();
  });

  it('is idempotent — marking an already-read notification succeeds', async () => {
    const user = await userFactory({ firstName: 'Idemp', lastName: 'Test' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Read twice',
    });

    const first = await userNotificationsRepository.markAsRead(notif.id, user.id);
    const second = await userNotificationsRepository.markAsRead(notif.id, user.id);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.readAt).toBeInstanceOf(Date);
  });

  it('returns null for soft-deleted notification', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'Mark' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be deleted',
    });

    // Soft-delete
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, notif.id));

    const result = await userNotificationsRepository.markAsRead(notif.id, user.id);
    expect(result).toBeNull();
  });
});

// ── markAllAsRead ───────────────────────────────────────────────────

describe('userNotificationsRepository.markAllAsRead', () => {
  it('marks all unread notifications as read and returns count', async () => {
    const user = await userFactory({ firstName: 'MarkAll', lastName: 'Test' });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Unread 1',
    });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.assigned',
      title: 'Unread 2',
    });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'project.started',
      title: 'Unread 3',
    });

    const updatedCount = await userNotificationsRepository.markAllAsRead(user.id);
    expect(updatedCount).toBe(3);

    // Verify all are now read
    const unreadCount = await userNotificationsRepository.countUnreadByUserId(user.id);
    expect(unreadCount).toBe(0);
  });

  it('does not affect other users notifications', async () => {
    const user1 = await userFactory({ firstName: 'User', lastName: 'MarkAll1' });
    const user2 = await userFactory({ firstName: 'User', lastName: 'MarkAll2' });

    await userNotificationsRepository.insert({
      userId: user1.id,
      event: 'case.created',
      title: 'User1 notification',
    });

    await userNotificationsRepository.insert({
      userId: user2.id,
      event: 'case.created',
      title: 'User2 notification',
    });

    await userNotificationsRepository.markAllAsRead(user1.id);

    // User2's notification should still be unread
    const user2Unread = await userNotificationsRepository.countUnreadByUserId(user2.id);
    expect(user2Unread).toBe(1);
  });

  it('returns 0 if none are unread', async () => {
    const user = await userFactory({ firstName: 'None', lastName: 'Unread' });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Already read',
    });

    // Mark all as read first
    await userNotificationsRepository.markAllAsRead(user.id);

    // Now mark again — should return 0
    const updatedCount = await userNotificationsRepository.markAllAsRead(user.id);
    expect(updatedCount).toBe(0);
  });

  it('excludes soft-deleted notifications', async () => {
    const user = await userFactory({ firstName: 'Soft', lastName: 'MarkAll' });

    const notif = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'Will be deleted',
    });

    // Soft-delete
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, notif.id));

    const updatedCount = await userNotificationsRepository.markAllAsRead(user.id);
    expect(updatedCount).toBe(0);
  });
});

// ── countUnseenByUserId ─────────────────────────────────────────────

describe('userNotificationsRepository.countUnseenByUserId', () => {
  const since = new Date('2026-01-01T00:00:00.000Z');

  it('counts unread rows strictly after since; excludes read, deleted, other users and the boundary', async () => {
    const user = await userFactory();
    const other = await userFactory();
    const insert = (userId: string, title: string, createdAt: Date) =>
      userNotificationsRepository.insert({ userId, event: 'case.created', title, createdAt });

    await insert(user.id, 'counted-1', new Date('2026-01-01T00:00:01.000Z'));
    await insert(user.id, 'counted-2', new Date('2026-01-01T00:00:02.000Z'));
    await insert(user.id, 'boundary', since);
    await insert(user.id, 'older', new Date('2025-12-31T00:00:00.000Z'));
    const read = await insert(user.id, 'read', new Date('2026-01-01T00:00:03.000Z'));
    const deleted = await insert(user.id, 'deleted', new Date('2026-01-01T00:00:04.000Z'));
    await insert(other.id, 'other-user', new Date('2026-01-01T00:00:05.000Z'));

    await userNotificationsRepository.markAsRead(read.id, user.id);
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, deleted.id));

    expect(await userNotificationsRepository.countUnseenByUserId(user.id, since)).toBe(2);
  });

  it('returns 0 when nothing is unseen', async () => {
    const user = await userFactory();
    expect(await userNotificationsRepository.countUnseenByUserId(user.id, since)).toBe(0);
  });

  it('does not recount a row whose DB-default created_at is the cursor read back at ms precision', async () => {
    const user = await userFactory();
    const announced = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'announced',
    });

    expect(
      await userNotificationsRepository.countUnseenByUserId(user.id, announced.createdAt)
    ).toBe(0);

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'next',
      createdAt: new Date(announced.createdAt.getTime() + 1),
    });

    expect(
      await userNotificationsRepository.countUnseenByUserId(user.id, announced.createdAt)
    ).toBe(1);
  });
});

// ── markReadByActionPath ────────────────────────────────────────────

describe('userNotificationsRepository.markReadByActionPath', () => {
  const insertWithUrl = (userId: string, actionUrl: string | null) =>
    userNotificationsRepository.insert({
      userId,
      event: 'case.created',
      title: `n ${actionUrl ?? 'null'}`,
      actionUrl,
    });

  it('matches the path with or without a query string and returns the updated ids', async () => {
    const user = await userFactory();
    const withQuery = await insertWithUrl(user.id, '/projects/p1?from=x');
    const bare = await insertWithUrl(user.id, '/projects/p1');

    const ids = await userNotificationsRepository.markReadByActionPath(user.id, '/projects/p1');

    expect([...ids].sort()).toEqual([withQuery.id, bare.id].sort());
    const rows = await db
      .select({ readAt: userNotifications.readAt })
      .from(userNotifications)
      .where(eq(userNotifications.userId, user.id));
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it('does not match a longer path, a prefix-sharing sibling or a null action_url', async () => {
    const user = await userFactory();
    await insertWithUrl(user.id, '/projects/p1/files');
    await insertWithUrl(user.id, '/projects/p10');
    await insertWithUrl(user.id, null);

    const ids = await userNotificationsRepository.markReadByActionPath(user.id, '/projects/p1');

    expect(ids).toEqual([]);
    const rows = await db
      .select({ readAt: userNotifications.readAt })
      .from(userNotifications)
      .where(eq(userNotifications.userId, user.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.readAt === null)).toBe(true);
  });

  it('leaves an already-read row read_at unchanged', async () => {
    const user = await userFactory();
    const n = await insertWithUrl(user.id, '/cases/c1');
    const earlier = new Date('2026-01-01T00:00:00.000Z');
    await db
      .update(userNotifications)
      .set({ readAt: earlier })
      .where(eq(userNotifications.id, n.id));

    const ids = await userNotificationsRepository.markReadByActionPath(user.id, '/cases/c1');

    expect(ids).toEqual([]);
    const [row] = await db
      .select({ readAt: userNotifications.readAt })
      .from(userNotifications)
      .where(eq(userNotifications.id, n.id));
    expect(row?.readAt?.toISOString()).toBe(earlier.toISOString());
  });

  it('skips soft-deleted rows', async () => {
    const user = await userFactory();
    const n = await insertWithUrl(user.id, '/cases/c1');
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, n.id));

    expect(await userNotificationsRepository.markReadByActionPath(user.id, '/cases/c1')).toEqual(
      []
    );
  });

  it("does not touch another user's rows", async () => {
    const user = await userFactory();
    const other = await userFactory();
    const theirs = await insertWithUrl(other.id, '/cases/c1');

    expect(await userNotificationsRepository.markReadByActionPath(user.id, '/cases/c1')).toEqual(
      []
    );
    const [row] = await db
      .select({ readAt: userNotifications.readAt })
      .from(userNotifications)
      .where(eq(userNotifications.id, theirs.id));
    expect(row?.readAt).toBeNull();
  });
});
