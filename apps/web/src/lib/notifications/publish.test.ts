import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockLoggedFetch, mockLog } = vi.hoisted(() => {
  const mockLoggedFetch = vi.fn();
  const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { mockLoggedFetch, mockLog };
});

vi.mock('server-only', () => ({}));

vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: mockLoggedFetch,
}));

vi.mock('@/lib/logging', () => ({
  log: mockLog,
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

  it('calls loggedFetch with correct URL, method, headers, and body', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });

    await publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

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

  it('logs error and returns silently when INTERNAL_API_SECRET is not set', async () => {
    delete process.env.INTERNAL_API_SECRET;

    await publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

    expect(mockLog.error).toHaveBeenCalledWith(
      'INTERNAL_API_SECRET not configured — cannot publish notification event',
      expect.objectContaining({ event: 'user.welcome' })
    );
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('logs error and returns silently when fetch throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('Network error'));

    await publishNotificationEvent('expert.application_submitted', {
      correlationId: 'app-1',
      userId: 'user-1',
      applicationId: 'app-1',
    });

    expect(mockLog.error).toHaveBeenCalledWith(
      'Notification publish request failed',
      expect.objectContaining({
        event: 'expert.application_submitted',
        error: 'Network error',
      })
    );
  });

  it('logs error and returns silently when API returns non-200', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('Bad request'),
    });

    await publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

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
