import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockFindUnreadByUserId = vi.fn();
const mockFindPanelByUserId = vi.fn();
const mockCountUnreadAndUnseenByUserId = vi.fn();
const mockFindNotificationsLastSeenAt = vi.fn();

vi.mock('@balo/db', () => ({
  userNotificationsRepository: {
    findUnreadByUserId: (...args: unknown[]) => mockFindUnreadByUserId(...args),
    findPanelByUserId: (...args: unknown[]) => mockFindPanelByUserId(...args),
    countUnreadAndUnseenByUserId: (...args: unknown[]) => mockCountUnreadAndUnseenByUserId(...args),
  },
  usersRepository: {
    findNotificationsLastSeenAt: (...args: unknown[]) => mockFindNotificationsLastSeenAt(...args),
  },
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

vi.mock('@/lib/logging', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET } from './route';

// ── Helpers ─────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3000';

function makeRequest(queryString = ''): NextRequest {
  const suffix = queryString ? `?${queryString}` : '';
  const url = `${BASE_URL}/api/notifications${suffix}`;
  return new NextRequest(new URL(url));
}

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    userId: 'user-1',
    event: 'booking.confirmed',
    title: 'New booking',
    body: 'Alice booked a consultation',
    actionUrl: '/cases/case-1',
    readAt: null,
    metadata: { correlationId: 'corr-1' },
    createdAt: '2026-03-22T10:00:00Z',
    updatedAt: '2026-03-22T10:00:00Z',
    deletedAt: null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('GET /api/notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', email: 'test@example.com' });
    mockFindNotificationsLastSeenAt.mockResolvedValue(null);
    mockCountUnreadAndUnseenByUserId.mockResolvedValue({ unread: 3, unseen: 0 });
  });

  describe('seen cursor', () => {
    it('returns lastSeenAt null and unseenCount 0 when the cursor is unset', async () => {
      mockFindPanelByUserId.mockResolvedValue([]);

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.lastSeenAt).toBeNull();
      expect(body.unseenCount).toBe(0);
      expect(mockFindNotificationsLastSeenAt).toHaveBeenCalledWith('user-1');
      expect(mockCountUnreadAndUnseenByUserId).toHaveBeenCalledWith('user-1', null);
    });

    it('counts unseen from the cursor and serialises it as ISO', async () => {
      const lastSeenAt = new Date('2026-03-22T09:00:00.000Z');
      mockFindPanelByUserId.mockResolvedValue([]);
      mockFindNotificationsLastSeenAt.mockResolvedValue(lastSeenAt);
      mockCountUnreadAndUnseenByUserId.mockResolvedValue({ unread: 3, unseen: 2 });

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(mockCountUnreadAndUnseenByUserId).toHaveBeenCalledWith('user-1', lastSeenAt);
      expect(body.lastSeenAt).toBe('2026-03-22T09:00:00.000Z');
      expect(body.unseenCount).toBe(2);
      expect(body.unreadCount).toBe(3);
    });
  });

  describe('impersonation flag', () => {
    it('reports impersonating false for a normal session', async () => {
      mockFindPanelByUserId.mockResolvedValue([]);

      const body = await (await GET(makeRequest())).json();

      expect(body.impersonating).toBe(false);
    });

    it('reports impersonating true for an impersonated session', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'user-1', isImpersonating: true });
      mockFindPanelByUserId.mockResolvedValue([]);

      const body = await (await GET(makeRequest())).json();

      expect(body.impersonating).toBe(true);
    });
  });

  describe('authentication', () => {
    it('returns 401 when no session', async () => {
      mockGetCurrentUser.mockResolvedValue(null);

      const res = await GET(makeRequest());
      expect(res.status).toBe(401);
    });
  });

  describe('unread query', () => {
    it('calls findUnreadByUserId when unread=true', async () => {
      mockFindUnreadByUserId.mockResolvedValue([makeNotification()]);

      const res = await GET(makeRequest('unread=true'));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(mockFindUnreadByUserId).toHaveBeenCalledWith('user-1', 20);
      expect(body.unreadCount).toBe(3);
      expect(body.notifications).toHaveLength(1);
    });

    it('calls findPanelByUserId when unread is not set', async () => {
      mockFindPanelByUserId.mockResolvedValue([makeNotification()]);

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(mockFindPanelByUserId).toHaveBeenCalledWith('user-1', {
        unreadLimit: 20,
        readLimit: 5,
      });
      expect(mockFindUnreadByUserId).not.toHaveBeenCalled();
      expect(body.notifications).toHaveLength(1);
    });

    it('uses the limit as the unread limit and keeps the read limit fixed', async () => {
      mockFindPanelByUserId.mockResolvedValue([]);

      await GET(makeRequest('limit=10'));

      expect(mockFindPanelByUserId).toHaveBeenCalledWith('user-1', {
        unreadLimit: 10,
        readLimit: 5,
      });
    });
  });

  describe('field projection', () => {
    it('omits metadata, userId, updatedAt, and deletedAt from response', async () => {
      mockFindUnreadByUserId.mockResolvedValue([makeNotification()]);

      const res = await GET(makeRequest('unread=true'));
      const body = await res.json();
      const notif = body.notifications[0];

      expect(notif).toHaveProperty('id');
      expect(notif).toHaveProperty('title');
      expect(notif).toHaveProperty('createdAt');
      expect(notif).not.toHaveProperty('metadata');
      expect(notif).not.toHaveProperty('userId');
      expect(notif).not.toHaveProperty('updatedAt');
      expect(notif).not.toHaveProperty('deletedAt');
    });
  });

  describe('validation', () => {
    it('returns 400 for invalid limit', async () => {
      const res = await GET(makeRequest('limit=100'));
      expect(res.status).toBe(400);
    });

    it('returns 400 for a non-"true" unread value', async () => {
      const res = await GET(makeRequest('unread=false'));
      expect(res.status).toBe(400);
    });
  });

  describe('error handling', () => {
    it('returns 500 when repository throws', async () => {
      mockFindPanelByUserId.mockRejectedValue(new Error('DB down'));
      mockCountUnreadAndUnseenByUserId.mockRejectedValue(new Error('DB down'));

      const res = await GET(makeRequest());
      expect(res.status).toBe(500);
    });
  });
});
