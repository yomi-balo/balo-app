import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  useRoomReadyRefresh,
  ROOM_READY_REFRESH_MS,
  ROOM_READY_REFRESH_AFTER_START_MS,
  ROOM_READY_REFRESH_MAX,
} from './use-room-ready-refresh';

/**
 * BAL-581 — the case page's bounded room-readiness refresh. TIME-bounded, not
 * count-bounded: it stays active only until `scheduledStart + ROOM_READY_REFRESH_AFTER_START_MS`
 * (the default venue-unavailable end plus one sweep tick), with a hard 60-refresh backstop for a
 * pathological tab.
 */

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const NOW = new Date('2026-01-06T12:00:00.000Z');
/** The nudge mounts at `start − 15` — the case join window's own opening offset. */
const START = new Date(NOW.getTime() + 15 * 60_000);

beforeEach(() => {
  mockRefresh.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoomReadyRefresh', () => {
  it('mounting alone never refreshes — the first tick is 30 s away', () => {
    renderHook(() => useRoomReadyRefresh(true, START.toISOString()));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does nothing at all while inactive', () => {
    renderHook(() => useRoomReadyRefresh(false, START.toISOString()));
    vi.advanceTimersByTime(5 * ROOM_READY_REFRESH_MS);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('pins the deadline to missedCallTerminationMs + one sweep tick (11 minutes)', () => {
    expect(ROOM_READY_REFRESH_AFTER_START_MS).toBe(11 * 60_000);
  });

  it('mounted at start−15, still refreshes at start+10:30 — inside the salvage period', () => {
    renderHook(() => useRoomReadyRefresh(true, START.toISOString()));
    // 15 min (mount → start) + 10.5 min = 25.5 min of elapsed device time.
    vi.advanceTimersByTime(25.5 * 60_000);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('stops by start+11 — the deadline — and never refreshes again after it', () => {
    renderHook(() => useRoomReadyRefresh(true, START.toISOString()));
    // 15 + 11 = 26 min: past the deadline.
    vi.advanceTimersByTime(26 * 60_000);
    const countAtDeadline = mockRefresh.mock.calls.length;
    expect(countAtDeadline).toBeGreaterThan(0);

    vi.advanceTimersByTime(5 * 60_000);
    expect(mockRefresh.mock.calls.length).toBe(countAtDeadline);
  });

  it('stops the moment `active` flips false — e.g. the room became ready', () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useRoomReadyRefresh(active, START.toISOString()),
      { initialProps: { active: true } }
    );
    vi.advanceTimersByTime(2 * ROOM_READY_REFRESH_MS);
    const countBeforeStop = mockRefresh.mock.calls.length;
    expect(countBeforeStop).toBeGreaterThan(0);

    rerender({ active: false });
    vi.advanceTimersByTime(5 * ROOM_READY_REFRESH_MS);
    expect(mockRefresh.mock.calls.length).toBe(countBeforeStop);
  });

  it('never exceeds ROOM_READY_REFRESH_MAX refreshes — the hard backstop', () => {
    // A scheduled start far enough away that the TIME deadline could never be what stops it —
    // only the count backstop can be responsible for the ceiling this test pins.
    const farStart = new Date(NOW.getTime() + 1_000 * 60_000);
    renderHook(() => useRoomReadyRefresh(true, farStart.toISOString()));
    vi.advanceTimersByTime(80 * ROOM_READY_REFRESH_MS);
    expect(mockRefresh.mock.calls.length).toBe(ROOM_READY_REFRESH_MAX);
  });

  it('clears the interval on unmount — no refresh fires after', () => {
    const { unmount } = renderHook(() => useRoomReadyRefresh(true, START.toISOString()));
    vi.advanceTimersByTime(ROOM_READY_REFRESH_MS);
    const countBeforeUnmount = mockRefresh.mock.calls.length;

    unmount();
    vi.advanceTimersByTime(10 * ROOM_READY_REFRESH_MS);
    expect(mockRefresh.mock.calls.length).toBe(countBeforeUnmount);
  });
});
