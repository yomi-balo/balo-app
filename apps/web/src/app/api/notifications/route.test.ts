import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ───────────────────────────────────────────────────────

const mockFindUnreadByUserId = vi.fn();
const mockFindByUserId = vi.fn();
const mockCountUnreadByUserId = vi.fn();

vi.mock('@balo/db', () => ({
  userNotificationsRepository: {
    findUnreadByUserId: (...args: unknown[]) => mockFindUnreadByUserId(...args),
    findByUserId: (...args: unknown[]) => mockFindByUserId(...args),
    countUnreadByUserId: (...args: unknown[]) => mockCountUnreadByUserId(...args),
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
  const url = `${BASE_URL}/api/notifications${queryString ? `?${queryString}` : ''}`;
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
    mockCountUnreadByUserId.mockResolvedValue(3);
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

    it('calls findByUserId when unread is not set', async () => {
      mockFindByUserId.mockResolvedValue([makeNotification()]);

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(mockFindByUserId).toHaveBeenCalledWith('user-1', 20, 0);
      expect(body.notifications).toHaveLength(1);
    });

    it('respects custom limit and offset', async () => {
      mockFindByUserId.mockResolvedValue([]);

      await GET(makeRequest('limit=10&offset=5'));

      expect(mockFindByUserId).toHaveBeenCalledWith('user-1', 10, 5);
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

    it('returns 400 for negative offset', async () => {
      const res = await GET(makeRequest('offset=-1'));
      expect(res.status).toBe(400);
    });
  });

  describe('error handling', () => {
    it('returns 500 when repository throws', async () => {
      mockFindByUserId.mockRejectedValue(new Error('DB down'));
      mockCountUnreadByUserId.mockRejectedValue(new Error('DB down'));

      const res = await GET(makeRequest());
      expect(res.status).toBe(500);
    });
  });
});
