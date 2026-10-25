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

// ── findPanelByUserId ───────────────────────────────────────────────

describe('userNotificationsRepository.findPanelByUserId', () => {
  const insertAt = (userId: string, title: string, createdAt: Date) =>
    userNotificationsRepository.insert({ userId, event: 'case.created', title, createdAt });

  it('returns an older unread item even when 20 newer items are read', async () => {
    const user = await userFactory();
    const oldUnread = await insertAt(user.id, 'old-unread', new Date('2026-01-01T00:00:00.000Z'));
    for (let i = 1; i <= 20; i++) {
      const row = await insertAt(user.id, `read-${i}`, new Date(Date.UTC(2026, 0, 2, 0, 0, i)));
      await userNotificationsRepository.markAsRead(row.id, user.id);
    }

    const results = await userNotificationsRepository.findPanelByUserId(user.id, {
      unreadLimit: 20,
      readLimit: 5,
    });

    expect(results.map((n) => n.id)).toContain(oldUnread.id);
    const [first] = results;
    expect(first?.id).toBe(oldUnread.id);
    expect(results).toHaveLength(6);
  });

  it('returns unread newest first, then read newest first, each capped by its own limit', async () => {
    const user = await userFactory();
    await insertAt(user.id, 'u1', new Date('2026-01-01T00:00:01.000Z'));
    await insertAt(user.id, 'u2', new Date('2026-01-01T00:00:02.000Z'));
    await insertAt(user.id, 'u3', new Date('2026-01-01T00:00:03.000Z'));
    for (const [title, second] of [
      ['r1', 4],
      ['r2', 5],
      ['r3', 6],
    ] as const) {
      const row = await insertAt(user.id, title, new Date(Date.UTC(2026, 0, 1, 0, 0, second)));
      await userNotificationsRepository.markAsRead(row.id, user.id);
    }

    const results = await userNotificationsRepository.findPanelByUserId(user.id, {
      unreadLimit: 2,
      readLimit: 2,
    });

    expect(results.map((n) => n.title)).toEqual(['u3', 'u2', 'r3', 'r2']);
  });

  it('excludes soft-deleted and other users rows', async () => {
    const user = await userFactory();
    const other = await userFactory();
    const deleted = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'deleted',
    });
    await userNotificationsRepository.insert({
      userId: other.id,
      event: 'case.created',
      title: 'other',
    });
    await db
      .update(userNotifications)
      .set({ deletedAt: new Date() })
      .where(eq(userNotifications.id, deleted.id));

    expect(
      await userNotificationsRepository.findPanelByUserId(user.id, {
        unreadLimit: 20,
        readLimit: 5,
      })
    ).toHaveLength(0);
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
    const stillUnread = await userNotificationsRepository.findUnreadByUserId(user.id);
    expect(stillUnread).toHaveLength(0);
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
    const user2Unread = await userNotificationsRepository.findUnreadByUserId(user2.id);
    expect(user2Unread).toHaveLength(1);
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

// ── countUnreadAndUnseenByUserId ────────────────────────────────────

describe('userNotificationsRepository.countUnreadAndUnseenByUserId', () => {
  const since = new Date('2026-01-01T00:00:00.000Z');

  it('counts unseen strictly after since and unread overall; excludes read, deleted, other users and the boundary', async () => {
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

    expect(await userNotificationsRepository.countUnreadAndUnseenByUserId(user.id, since)).toEqual({
      unread: 4,
      unseen: 2,
    });
  });

  it('returns zeros when the user has no notifications', async () => {
    const user = await userFactory();
    expect(await userNotificationsRepository.countUnreadAndUnseenByUserId(user.id, since)).toEqual({
      unread: 0,
      unseen: 0,
    });
  });

  it('returns unseen 0 and the real unread count when since is null', async () => {
    const user = await userFactory();
    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'unread',
    });

    expect(await userNotificationsRepository.countUnreadAndUnseenByUserId(user.id, null)).toEqual({
      unread: 1,
      unseen: 0,
    });
  });

  it('does not recount a row whose DB-default created_at is the cursor read back at ms precision', async () => {
    const user = await userFactory();
    const announced = await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'announced',
    });

    expect(
      await userNotificationsRepository.countUnreadAndUnseenByUserId(user.id, announced.createdAt)
    ).toEqual({ unread: 1, unseen: 0 });

    await userNotificationsRepository.insert({
      userId: user.id,
      event: 'case.created',
      title: 'next',
      createdAt: new Date(announced.createdAt.getTime() + 1),
    });

    expect(
      await userNotificationsRepository.countUnreadAndUnseenByUserId(user.id, announced.createdAt)
    ).toEqual({ unread: 2, unseen: 1 });
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

    expect(new Set(ids)).toEqual(new Set([withQuery.id, bare.id]));
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
