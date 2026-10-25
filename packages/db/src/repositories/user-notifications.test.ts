import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the db client ──────────────────────────────────────────

const mockReturning = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockValues = vi.fn();
const mockInsert = vi.fn();
const mockSet = vi.fn();
const mockUpdate = vi.fn();

// Build chainable query builder mocks
function setupSelectChain(result: unknown[]) {
  mockLimit.mockReturnValue(result);
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

function setupInsertChain(result: unknown[]) {
  mockReturning.mockReturnValue(result);
  mockValues.mockReturnValue({ returning: mockReturning });
  mockInsert.mockReturnValue({ values: mockValues });
}

function setupUpdateChain(result: unknown[]) {
  mockReturning.mockReturnValue(result);
  mockWhere.mockReturnValue({ returning: mockReturning });
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });
}

vi.mock('../client', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

import { userNotificationsRepository } from './user-notifications';

// ── Test data ───────────────────────────────────────────────────

const mockNotification = {
  id: 'notif-1',
  userId: 'user-1',
  event: 'booking.confirmed',
  title: 'New booking',
  body: 'Test body',
  actionUrl: '/cases/1',
  metadata: null,
  readAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

// ── Tests ───────────────────────────────────────────────────────

describe('userNotificationsRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('insert', () => {
    it('inserts and returns the row', async () => {
      setupInsertChain([mockNotification]);

      const result = await userNotificationsRepository.insert({
        userId: 'user-1',
        event: 'booking.confirmed',
        title: 'New booking',
      });

      expect(result).toEqual(mockNotification);
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  describe('findUnreadByUserId', () => {
    it('returns unread notifications', async () => {
      setupSelectChain([mockNotification]);

      const result = await userNotificationsRepository.findUnreadByUserId('user-1');

      expect(result).toEqual([mockNotification]);
      expect(mockSelect).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(20);
    });

    it('respects custom limit', async () => {
      setupSelectChain([]);

      await userNotificationsRepository.findUnreadByUserId('user-1', 5);

      expect(mockLimit).toHaveBeenCalledWith(5);
    });
  });

  describe('findPanelByUserId', () => {
    it('queries unread and read separately with their own limits, unread first', async () => {
      const unread = { ...mockNotification, id: 'unread-1' };
      const read = { ...mockNotification, id: 'read-1', readAt: new Date() };
      mockLimit.mockReturnValueOnce([unread]).mockReturnValueOnce([read]);
      mockOrderBy.mockReturnValue({ limit: mockLimit });
      mockWhere.mockReturnValue({ orderBy: mockOrderBy });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      const result = await userNotificationsRepository.findPanelByUserId('user-1', {
        unreadLimit: 20,
        readLimit: 5,
      });

      expect(result).toEqual([unread, read]);
      expect(mockLimit).toHaveBeenNthCalledWith(1, 20);
      expect(mockLimit).toHaveBeenNthCalledWith(2, 5);
    });
  });

  describe('countUnreadAndUnseenByUserId', () => {
    function setupCountChain(row: unknown): void {
      mockWhere.mockReturnValue([row]);
      mockFrom.mockReturnValue({ where: mockWhere });
      mockSelect.mockReturnValue({ from: mockFrom });
    }

    it('returns both counts from a single select', async () => {
      setupCountChain({ unread: 4, unseen: 2 });

      const result = await userNotificationsRepository.countUnreadAndUnseenByUserId(
        'user-1',
        new Date('2026-01-01T00:00:00.000Z')
      );

      expect(result).toEqual({ unread: 4, unseen: 2 });
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('returns unseen 0 for a null cursor', async () => {
      setupCountChain({ unread: 3, unseen: 0 });

      expect(
        await userNotificationsRepository.countUnreadAndUnseenByUserId('user-1', null)
      ).toEqual({ unread: 3, unseen: 0 });
    });

    it('falls back to zeros when no row is returned', async () => {
      mockWhere.mockReturnValue([]);
      mockFrom.mockReturnValue({ where: mockWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      expect(
        await userNotificationsRepository.countUnreadAndUnseenByUserId('user-1', null)
      ).toEqual({ unread: 0, unseen: 0 });
    });
  });

  describe('markAsRead', () => {
    it('returns updated row when found', async () => {
      const readNotif = { ...mockNotification, readAt: new Date() };
      setupUpdateChain([readNotif]);

      const result = await userNotificationsRepository.markAsRead('notif-1', 'user-1');

      expect(result).toEqual(readNotif);
    });

    it('falls back to select when update returns empty (already read)', async () => {
      const readNotif = { ...mockNotification, readAt: new Date() };
      // Update chain returns [] (no unread row to update)
      const updateWhere = vi.fn().mockReturnValue({ returning: vi.fn().mockReturnValue([]) });
      mockSet.mockReturnValue({ where: updateWhere });
      mockUpdate.mockReturnValue({ set: mockSet });
      // Fallback select chain returns existing read notification
      const selectWhere = vi.fn().mockReturnValue([readNotif]);
      mockFrom.mockReturnValue({ where: selectWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      const result = await userNotificationsRepository.markAsRead('notif-1', 'user-1');

      expect(result).toEqual(readNotif);
      expect(mockSelect).toHaveBeenCalled();
    });

    it('returns null when notification does not exist', async () => {
      // Update chain returns []
      const updateWhere = vi.fn().mockReturnValue({ returning: vi.fn().mockReturnValue([]) });
      mockSet.mockReturnValue({ where: updateWhere });
      mockUpdate.mockReturnValue({ set: mockSet });
      // Fallback select chain also returns []
      const selectWhere = vi.fn().mockReturnValue([]);
      mockFrom.mockReturnValue({ where: selectWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      const result = await userNotificationsRepository.markAsRead('bad-id', 'user-1');

      expect(result).toBeNull();
    });
  });

  describe('markAllAsRead', () => {
    it('returns count of updated rows', async () => {
      setupUpdateChain([mockNotification, { ...mockNotification, id: 'notif-2' }]);

      const result = await userNotificationsRepository.markAllAsRead('user-1');

      expect(result).toBe(2);
    });

    it('returns 0 when no rows updated', async () => {
      setupUpdateChain([]);

      const result = await userNotificationsRepository.markAllAsRead('user-1');

      expect(result).toBe(0);
    });
  });
});
