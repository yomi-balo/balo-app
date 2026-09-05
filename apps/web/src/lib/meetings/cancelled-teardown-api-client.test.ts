import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockLoggedFetch, mockLog } = vi.hoisted(() => ({
  mockLoggedFetch: vi.fn(),
  mockLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('server-only', () => ({}));

vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: mockLoggedFetch,
}));

vi.mock('@/lib/logging', () => ({
  log: mockLog,
}));

vi.mock('@/lib/api/balo-api-client', () => ({
  getApiUrl: () => 'http://localhost:3002',
}));

import { postCancelledTeardown, TEARDOWN_BATCH_SIZE } from './cancelled-teardown-api-client';

describe('postCancelledTeardown', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.INTERNAL_API_SECRET = 'test-secret';
  });

  it('no-ops on an empty array — no fetch, no log', async () => {
    await postCancelledTeardown([]);

    expect(mockLoggedFetch).not.toHaveBeenCalled();
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('posts the batch with the internal-auth header', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });

    await postCancelledTeardown([
      { meetingId: 'meeting-1', expertProfileId: 'expert-1' },
      { meetingId: 'meeting-2', expertProfileId: null },
    ]);

    expect(mockLoggedFetch).toHaveBeenCalledWith(
      'http://localhost:3002/meetings/cancelled-teardown',
      expect.objectContaining({
        service: 'balo-api',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-api-key': 'test-secret',
        },
        body: JSON.stringify({
          meetings: [
            { meetingId: 'meeting-1', expertProfileId: 'expert-1' },
            { meetingId: 'meeting-2', expertProfileId: null },
          ],
        }),
      })
    );
  });

  it('logs error and never fetches when INTERNAL_API_SECRET is not set', async () => {
    delete process.env.INTERNAL_API_SECRET;

    await postCancelledTeardown([{ meetingId: 'meeting-1', expertProfileId: null }]);

    expect(mockLog.error).toHaveBeenCalledWith(
      'INTERNAL_API_SECRET not configured — cannot post cancelled-meeting teardown',
      expect.objectContaining({ meetingCount: 1 })
    );
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('logs error and swallows a non-2xx response — never throws', async () => {
    mockLoggedFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal error'),
    });

    await expect(
      postCancelledTeardown([{ meetingId: 'meeting-1', expertProfileId: null }])
    ).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      'Cancelled-meeting teardown post failed',
      expect.objectContaining({ status: 500, body: 'Internal error', meetingCount: 1 })
    );
  });

  it('CHUNKS at the route cap — a 26-meeting cascade posts twice, never one over-cap request', async () => {
    mockLoggedFetch.mockResolvedValue({ ok: true });
    const oversized = Array.from({ length: TEARDOWN_BATCH_SIZE + 1 }, (_, i) => ({
      meetingId: `meeting-${i}`,
      expertProfileId: null,
    }));

    await postCancelledTeardown(oversized);

    // Before the fix this was ONE request of 26, which the route's `.max(25)` rejected with a
    // 400 — dropping the teardown for the WHOLE batch, not just the excess.
    expect(mockLoggedFetch).toHaveBeenCalledTimes(2);
    const bodies = mockLoggedFetch.mock.calls.map(
      (call) => JSON.parse(String((call[1] as { body: string }).body)) as { meetings: unknown[] }
    );
    expect(bodies[0]?.meetings).toHaveLength(TEARDOWN_BATCH_SIZE);
    expect(bodies[1]?.meetings).toHaveLength(1);
    // Every meeting is posted exactly once, in order.
    expect([...(bodies[0]?.meetings ?? []), ...(bodies[1]?.meetings ?? [])]).toEqual(oversized);
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('a failing chunk does not stop the remaining chunks', async () => {
    mockLoggedFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue({ ok: true });
    const oversized = Array.from({ length: TEARDOWN_BATCH_SIZE + 2 }, (_, i) => ({
      meetingId: `meeting-${i}`,
      expertProfileId: null,
    }));

    await expect(postCancelledTeardown(oversized)).resolves.toBeUndefined();

    expect(mockLoggedFetch).toHaveBeenCalledTimes(2);
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });

  it('logs error and swallows a thrown transport error — never throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('Network error'));

    await expect(
      postCancelledTeardown([{ meetingId: 'meeting-1', expertProfileId: null }])
    ).resolves.toBeUndefined();

    expect(mockLog.error).toHaveBeenCalledWith(
      'Cancelled-meeting teardown request failed',
      expect.objectContaining({ error: 'Network error', meetingCount: 1 })
    );
  });
});
