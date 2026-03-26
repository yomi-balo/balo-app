import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockMarkAsRead = vi.fn();
const mockMarkAllAsRead = vi.fn();

vi.mock('@balo/db', () => ({
  userNotificationsRepository: {
    markAsRead: (...args: unknown[]) => mockMarkAsRead(...args),
    markAllAsRead: (...args: unknown[]) => mockMarkAllAsRead(...args),
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

import { PATCH } from './[id]/read/route';
import { POST } from './read-all/route';

// ── Tests ───────────────────────────────────────────────────────

describe('PATCH /api/notifications/[id]/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  });

  it('returns 401 when no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await PATCH(new Request('http://localhost'), {
      params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid UUID', async () => {
    const res = await PATCH(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when notification not found', async () => {
    mockMarkAsRead.mockResolvedValue(null);

    const res = await PATCH(new Request('http://localhost'), {
      params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });
    expect(res.status).toBe(404);
  });

  it('marks notification as read and returns 200', async () => {
    const readAt = new Date().toISOString();
    mockMarkAsRead.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-446655440000',
      readAt,
    });

    const res = await PATCH(new Request('http://localhost'), {
      params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.notification.readAt).toBe(readAt);
    expect(mockMarkAsRead).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000', 'user-1');
  });

  it('returns 500 when repository throws', async () => {
    mockMarkAsRead.mockRejectedValue(new Error('DB error'));

    const res = await PATCH(new Request('http://localhost'), {
      params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/notifications/read-all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
  });

  it('returns 401 when no session', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('marks all as read and returns count', async () => {
    mockMarkAllAsRead.mockResolvedValue(5);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.count).toBe(5);
    expect(mockMarkAllAsRead).toHaveBeenCalledWith('user-1');
  });

  it('returns 500 when repository throws', async () => {
    mockMarkAllAsRead.mockRejectedValue(new Error('DB error'));

    const res = await POST();
    expect(res.status).toBe(500);
  });
});
