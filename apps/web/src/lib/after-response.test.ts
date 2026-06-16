import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockAfter, mockLog } = vi.hoisted(() => ({
  mockAfter: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: mockAfter }));
vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { runAfterResponse } from './after-response';

describe('runAfterResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules the work via after() (does not run it inline)', () => {
    const work = vi.fn().mockResolvedValue(undefined);
    runAfterResponse('test work', work);

    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockAfter).toHaveBeenCalledWith(expect.any(Function));
    // Deferred — not invoked until after() runs the callback.
    expect(work).not.toHaveBeenCalled();
  });

  it('runs the scheduled work when after() invokes the callback', async () => {
    const work = vi.fn().mockResolvedValue(undefined);
    let scheduled: (() => Promise<void>) | undefined;
    mockAfter.mockImplementation((cb: () => Promise<void>) => {
      scheduled = cb;
    });

    runAfterResponse('test work', work);
    await scheduled?.();

    expect(work).toHaveBeenCalledTimes(1);
  });

  it('swallows and logs when the deferred work rejects — the callback never rejects', async () => {
    const work = vi.fn().mockRejectedValue(new Error('boom'));
    let scheduled: (() => Promise<void>) | undefined;
    mockAfter.mockImplementation((cb: () => Promise<void>) => {
      scheduled = cb;
    });

    runAfterResponse('notification publish', work);

    await expect(scheduled?.()).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalledWith(
      'Deferred notification publish threw',
      expect.objectContaining({ error: 'boom' })
    );
  });

  it('falls back to running work inline (with a warn) when after() is unavailable', () => {
    const work = vi.fn().mockResolvedValue(undefined);
    mockAfter.mockImplementation(() => {
      throw new Error('after() outside request scope');
    });

    // Must not throw to the caller even though after() did.
    expect(() => runAfterResponse('Ably publish', work)).not.toThrow();

    expect(mockLog.warn).toHaveBeenCalledWith(
      'after() unavailable — running Ably publish inline (best-effort)',
      expect.objectContaining({ error: 'after() outside request scope' })
    );
    expect(work).toHaveBeenCalledTimes(1);
  });
});
