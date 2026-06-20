import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockLoggedFetch, mockLog, runAfterResponseMock, getScheduled } = vi.hoisted(() => {
  let scheduled: (() => Promise<void>) | null = null;
  return {
    mockLoggedFetch: vi.fn(),
    mockLog: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    // Capture the deferred work so each test can run it explicitly — mirrors how
    // the real runAfterResponse hands the work to Next's after() (BAL-279).
    runAfterResponseMock: vi.fn((_label: string, work: () => Promise<void>) => {
      scheduled = work;
    }),
    getScheduled: (): (() => Promise<void>) | null => scheduled,
  };
});

vi.mock('server-only', () => ({}));

vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: mockLoggedFetch,
}));

vi.mock('@/lib/logging', () => ({
  log: mockLog,
}));

vi.mock('@/lib/after-response', () => ({
  runAfterResponse: runAfterResponseMock,
}));

import { publishNotificationEvent } from './publish';

describe('publishNotificationEvent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.INTERNAL_API_SECRET = 'test-secret';
    process.env.API_URL = 'http://localhost:3002';
  });

  it('defers the publish via runAfterResponse rather than fetching inline', () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });

    publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

    // Scheduled, not yet executed — the fetch must not happen on the response path.
    expect(runAfterResponseMock).toHaveBeenCalledWith('notification publish', expect.any(Function));
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('calls loggedFetch with correct URL, method, headers, and body when the deferred work runs', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });

    publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });
    await getScheduled()?.();

    expect(mockLoggedFetch).toHaveBeenCalledWith(
      'http://localhost:3002/notifications/publish',
      expect.objectContaining({
        service: 'balo-api',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-key': 'test-secret',
        },
        body: JSON.stringify({
          event: 'user.welcome',
          payload: {
            correlationId: 'user-1',
            userId: 'user-1',
            role: 'client',
          },
        }),
      })
    );
  });

  it('logs error and never schedules when INTERNAL_API_SECRET is not set', () => {
    delete process.env.INTERNAL_API_SECRET;

    publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

    expect(mockLog.error).toHaveBeenCalledWith(
      'INTERNAL_API_SECRET not configured — cannot publish notification event',
      expect.objectContaining({ event: 'user.welcome' })
    );
    expect(runAfterResponseMock).not.toHaveBeenCalled();
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('logs error and swallows when the deferred fetch throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('Network error'));

    publishNotificationEvent('expert.application_submitted', {
      correlationId: 'app-1',
      userId: 'user-1',
      applicationId: 'app-1',
    });
    await expect(getScheduled()?.()).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      'Notification publish request failed',
      expect.objectContaining({
        event: 'expert.application_submitted',
        error: 'Network error',
      })
    );
  });

  it('logs error and swallows when the API returns non-200', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad request'),
    });

    publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });
    await expect(getScheduled()?.()).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      'Notification publish failed',
      expect.objectContaining({
        event: 'user.welcome',
        status: 400,
        body: 'Bad request',
      })
    );
  });
});
