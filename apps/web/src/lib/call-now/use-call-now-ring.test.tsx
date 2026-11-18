import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { mockRead, mockStopAction } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockStopAction: vi.fn(),
}));

vi.mock('@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-ring', () => ({
  readCallNowRingAction: mockRead,
}));
vi.mock('@/app/(call)/meetings/[meetingId]/call/_actions/stop-call-now-ring', () => ({
  stopCallNowRingAction: mockStopAction,
}));

import {
  RING_LOST_GRACE_MS,
  RING_POLL_BACKOFF_MS,
  RING_POLL_MS,
  ringRemainingSeconds,
  useCallNowRing,
  type CallNowRingSeed,
} from './use-call-now-ring';

const RING_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NOW = Date.parse('2026-11-19T10:00:00.000Z');

function seed(overrides: Partial<CallNowRingSeed> = {}): CallNowRingSeed {
  return {
    ringId: RING_ID,
    status: 'ringing',
    expiresAtIso: new Date(NOW + 45_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockRead.mockResolvedValue({
    ok: true,
    status: 'ringing',
    expiresAtIso: new Date(NOW + 45_000).toISOString(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ringRemainingSeconds', () => {
  it('rounds up the seconds left until expiresAt', () => {
    expect(ringRemainingSeconds(new Date(NOW + 44_100).toISOString(), NOW)).toBe(45);
    expect(ringRemainingSeconds(new Date(NOW + 1_000).toISOString(), NOW)).toBe(1);
  });

  it('⚠ is null at or past expiry and for an unreadable instant — never negative', () => {
    expect(ringRemainingSeconds(new Date(NOW).toISOString(), NOW)).toBeNull();
    expect(ringRemainingSeconds(new Date(NOW - 5_000).toISOString(), NOW)).toBeNull();
    expect(ringRemainingSeconds('not a date', NOW)).toBeNull();
  });

  it('⚠ follows the server expiry, whatever the ring length (45 s or 120 s)', () => {
    expect(ringRemainingSeconds(new Date(NOW + 120_000).toISOString(), NOW)).toBe(120);
    expect(ringRemainingSeconds(new Date(NOW + 45_000).toISOString(), NOW)).toBe(45);
  });
});

describe('useCallNowRing — the countdown', () => {
  it('starts from expiresAt and ticks down each second', () => {
    const { result } = renderHook(() => useCallNowRing(seed()));
    expect(result.current.remainingSeconds).toBe(45);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current.remainingSeconds).toBe(44);
  });

  it('hides the line once the window has passed while the ring is still ringing', async () => {
    mockRead.mockResolvedValue({
      ok: true,
      status: 'ringing',
      expiresAtIso: new Date(NOW + 2_000).toISOString(),
    });
    const { result } = renderHook(() =>
      useCallNowRing(seed({ expiresAtIso: new Date(NOW + 2_000).toISOString() }))
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(result.current.status).toBe('ringing');
    expect(result.current.remainingSeconds).toBeNull();
  });
});

describe('useCallNowRing — the poll', () => {
  it('polls every 2 s while ringing and settles on a terminal status', async () => {
    mockRead.mockResolvedValueOnce({
      ok: true,
      status: 'ringing',
      expiresAtIso: new Date(NOW + 45_000).toISOString(),
    });
    mockRead.mockResolvedValueOnce({
      ok: true,
      status: 'unanswered',
      expiresAtIso: new Date(NOW + 45_000).toISOString(),
    });
    const { result } = renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS);
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead).toHaveBeenCalledWith({ ringId: RING_ID });
    expect(result.current.status).toBe('ringing');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS);
    });
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('unanswered');
    expect(result.current.remainingSeconds).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it('⚠ backs off to 5 s after a transport failure, and again after a thrown action', async () => {
    mockRead.mockResolvedValueOnce({ ok: false, transient: true });
    mockRead.mockRejectedValueOnce(new Error('network'));
    renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS);
    });
    expect(mockRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_BACKOFF_MS - 1);
    });
    expect(mockRead).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockRead).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_BACKOFF_MS);
    });
    expect(mockRead).toHaveBeenCalledTimes(3);
  });

  it('stops polling on an answer that says the ring is gone', async () => {
    mockRead.mockResolvedValue({ ok: false, transient: false });
    renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS * 5);
    });

    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('⚠ a refusal that is not transient marks the ring lost, so the room does not sit on Calling', async () => {
    mockRead.mockResolvedValue({ ok: false, transient: false });
    const { result } = renderHook(() => useCallNowRing(seed()));
    expect(result.current.lost).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS);
    });

    expect(result.current.lost).toBe(true);
  });

  it('a transient failure inside the ring window is ridden out, not lost', async () => {
    mockRead.mockResolvedValue({ ok: false, transient: true });
    const { result } = renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS + RING_POLL_BACKOFF_MS * 2);
    });

    expect(mockRead.mock.calls.length).toBeGreaterThan(1);
    expect(result.current.lost).toBe(false);
  });

  it('⚠ transient failures that outlast expiresAt by the grace mark the ring lost and stop polling', async () => {
    mockRead.mockResolvedValue({ ok: false, transient: true });
    const { result } = renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000 + RING_LOST_GRACE_MS + RING_POLL_BACKOFF_MS * 2);
    });

    expect(result.current.lost).toBe(true);
    const calls = mockRead.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_BACKOFF_MS * 4);
    });
    expect(mockRead).toHaveBeenCalledTimes(calls);
  });

  it('a thrown action past the grace is lost too', async () => {
    mockRead.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000 + RING_LOST_GRACE_MS + RING_POLL_BACKOFF_MS * 2);
    });

    expect(result.current.lost).toBe(true);
  });

  it('never polls for a ring that is not ringing, or when there is no ring', async () => {
    renderHook(() => useCallNowRing(seed({ status: 'connected' })));
    const none = renderHook(() => useCallNowRing(null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS * 5);
    });

    expect(mockRead).not.toHaveBeenCalled();
    expect(none.result.current.status).toBeNull();
    expect(none.result.current.remainingSeconds).toBeNull();
  });

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useCallNowRing(seed()));
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RING_POLL_MS * 3);
    });

    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('useCallNowRing — stop', () => {
  it('adopts the status the api says the ring really has', async () => {
    mockStopAction.mockResolvedValue({ ok: true, status: 'connected' });
    const { result } = renderHook(() => useCallNowRing(seed()));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.stop();
    });

    expect(mockStopAction).toHaveBeenCalledWith({ ringId: RING_ID });
    expect(outcome).toEqual({ ok: true, status: 'connected' });
    expect(result.current.status).toBe('connected');
    expect(result.current.stopping).toBe(false);
  });

  it('a refused or thrown stop leaves the ring ringing', async () => {
    mockStopAction.mockResolvedValueOnce({ ok: false });
    mockStopAction.mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useCallNowRing(seed()));

    await act(async () => {
      expect(await result.current.stop()).toEqual({ ok: false });
    });
    await act(async () => {
      expect(await result.current.stop()).toEqual({ ok: false });
    });

    expect(result.current.status).toBe('ringing');
    expect(result.current.stopping).toBe(false);
  });

  it('has nothing to stop without a ring', async () => {
    const { result } = renderHook(() => useCallNowRing(null));

    await act(async () => {
      expect(await result.current.stop()).toEqual({ ok: false });
    });

    expect(mockStopAction).not.toHaveBeenCalled();
  });
});
