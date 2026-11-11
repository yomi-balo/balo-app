import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockLoadNavCalls = vi.fn();
vi.mock('@/lib/meetings/load-nav-calls', () => ({
  loadNavCalls: (...args: unknown[]) => mockLoadNavCalls(...args),
}));

const mockNavWorkspaceTypeOf = vi.fn();
vi.mock('@/lib/navigation/nav-context', () => ({
  navWorkspaceTypeOf: (...args: unknown[]) => mockNavWorkspaceTypeOf(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from './route';
import { log } from '@/lib/logging';

const NOW = new Date('2026-09-17T12:00:00.000Z');

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'test@example.com',
    companyId: 'company-1',
    expertProfileId: 'profile-1',
    ...overrides,
  };
}

describe('GET /api/meetings/nav-calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockGetCurrentUser.mockResolvedValue(user());
    mockNavWorkspaceTypeOf.mockReturnValue('company');
    mockLoadNavCalls.mockResolvedValue([]);
  });

  it('returns 401 without a session and reads nothing', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockLoadNavCalls).not.toHaveBeenCalled();
  });

  it('returns an empty impersonating response without reading meetings', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ isImpersonating: true }));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      serverNowIso: NOW.toISOString(),
      impersonating: true,
      calls: [],
    });
    expect(mockLoadNavCalls).not.toHaveBeenCalled();
  });

  it('passes the workspace, ids and the same instant to the loader and echoes that instant', async () => {
    mockNavWorkspaceTypeOf.mockReturnValue('expert');
    const calls = [{ meetingId: 'm-1', otherWorkspace: false }];
    mockLoadNavCalls.mockResolvedValue(calls);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockLoadNavCalls).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      workspaceType: 'expert',
      companyId: 'company-1',
      expertProfileId: 'profile-1',
      now: NOW,
    });
    expect(body).toEqual({ serverNowIso: NOW.toISOString(), impersonating: false, calls });
  });

  it('normalises blank ids to null', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: '', expertProfileId: undefined }));

    await GET();

    expect(mockLoadNavCalls).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: null, expertProfileId: null })
    );
  });

  it('is never cached', async () => {
    const ok = await GET();
    expect(ok.headers.get('Cache-Control')).toBe('no-store');

    mockGetCurrentUser.mockResolvedValue(null);
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store');

    mockGetCurrentUser.mockResolvedValue(user({ isImpersonating: true }));
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store');

    mockGetCurrentUser.mockResolvedValue(user());
    mockLoadNavCalls.mockRejectedValue(new Error('boom'));
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('logs and returns 500 when the loader throws', async () => {
    mockLoadNavCalls.mockRejectedValue(new Error('db down'));

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to load nav calls',
      expect.objectContaining({ userId: 'user-1', error: 'db down' })
    );
  });
});
