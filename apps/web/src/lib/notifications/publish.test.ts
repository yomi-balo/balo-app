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

import { publishNotificationEvent, publishNotificationEventNow } from './publish';

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

  /**
   * ⚠ THE RETURNED PROMISE IS NOT A DELIVERY RECEIPT, AND THIS PINS THAT. It settles as soon
   * as the POST has been REGISTERED — awaiting it orders the registration, not the request.
   * A caller that needs the POST itself to settle is already inside a deferred callback and
   * must use `publishNotificationEventNow` (see the close fan-out). Goes red the moment this
   * wrapper starts awaiting the work it schedules.
   */
  it('resolves EAGERLY — before the registered POST has run', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });

    await publishNotificationEvent('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

    expect(mockLoggedFetch).not.toHaveBeenCalled();
    expect(runAfterResponseMock).toHaveBeenCalledTimes(1);
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

/**
 * The awaitable form (Qodo round 3). Same never-throws / log-and-swallow contract as the
 * wrapper, minus the deferral — for callers ALREADY inside a `runAfterResponse` callback that
 * need the POST to actually settle before doing something else (the close fan-out orders its
 * telling ahead of the meeting teardown on exactly this).
 */
describe('publishNotificationEventNow', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.INTERNAL_API_SECRET = 'test-secret';
    process.env.API_URL = 'http://localhost:3002';
  });

  it('POSTs inline and registers NO deferral of its own', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });

    await publishNotificationEventNow('user.welcome', {
      correlationId: 'user-1',
      userId: 'user-1',
      role: 'client',
    });

    // The whole point: the fetch has already happened once the promise settles. Deferring
    // here would re-open the "awaited the registration, not the request" bug it exists to fix.
    expect(runAfterResponseMock).not.toHaveBeenCalled();
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
          payload: { correlationId: 'user-1', userId: 'user-1', role: 'client' },
        }),
      })
    );
  });

  it('logs error and refuses to POST when INTERNAL_API_SECRET is not set', async () => {
    delete process.env.INTERNAL_API_SECRET;

    await expect(
      publishNotificationEventNow('user.welcome', {
        correlationId: 'user-1',
        userId: 'user-1',
        role: 'client',
      })
    ).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      'INTERNAL_API_SECRET not configured — cannot publish notification event',
      expect.objectContaining({ event: 'user.welcome' })
    );
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('logs error and swallows a transport rejection — it never throws to its caller', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('Network error'));

    // Resolving (not rejecting) is the contract the close fan-out relies on to need no
    // `.catch`: a notification hiccup must not abort the teardown that follows it.
    await expect(
      publishNotificationEventNow('expert.application_submitted', {
        correlationId: 'app-1',
        userId: 'user-1',
        applicationId: 'app-1',
      })
    ).resolves.toBeUndefined();

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

    await expect(
      publishNotificationEventNow('user.welcome', {
        correlationId: 'user-1',
        userId: 'user-1',
        role: 'client',
      })
    ).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      'Notification publish failed',
      expect.objectContaining({ event: 'user.welcome', status: 400, body: 'Bad request' })
    );
  });
});
