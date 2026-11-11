import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import { useRoomReadyRefetch } from './use-room-ready-refetch';
import {
  ROOM_READY_REFRESH_MS,
  ROOM_READY_REFRESH_AFTER_START_MS,
  ROOM_READY_REFRESH_MAX,
} from '@/lib/meetings/room-ready-refresh-schedule';

/**
 * The bounded room-readiness refresh, caller-agnostic. TIME-bounded, not count-bounded: it stays
 * active only until `scheduledStart + ROOM_READY_REFRESH_AFTER_START_MS` (the default
 * venue-unavailable end plus one sweep tick), with a hard 60-call backstop for a pathological tab.
 */

const NOW = new Date('2026-01-06T12:00:00.000Z');
/** A mount at `start − CASE_JOIN_WINDOW_MINUTES` — the case join window's own opening offset. */
const START = new Date(NOW.getTime() + CASE_JOIN_WINDOW_MINUTES * 60_000);

const onRefresh = vi.fn();

beforeEach(() => {
  onRefresh.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRoomReadyRefetch', () => {
  it('mounting alone never refreshes — the first tick is 30 s away', () => {
    renderHook(() => useRoomReadyRefetch(true, START.toISOString(), onRefresh));
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('calls the callback every ROOM_READY_REFRESH_MS while active', () => {
    renderHook(() => useRoomReadyRefetch(true, START.toISOString(), onRefresh));
    vi.advanceTimersByTime(ROOM_READY_REFRESH_MS * 3);
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it('does nothing at all while inactive', () => {
    renderHook(() => useRoomReadyRefetch(false, START.toISOString(), onRefresh));
    vi.advanceTimersByTime(5 * ROOM_READY_REFRESH_MS);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('pins the deadline to missedCallTerminationMs + one sweep tick (11 minutes)', () => {
    expect(ROOM_READY_REFRESH_AFTER_START_MS).toBe(11 * 60_000);
  });

  it('mounted at the window opening, still refreshes at start+10:30 — inside the salvage period', () => {
    renderHook(() => useRoomReadyRefetch(true, START.toISOString(), onRefresh));
    // The join window (mount → start) + 10.5 min of elapsed device time.
    vi.advanceTimersByTime((CASE_JOIN_WINDOW_MINUTES + 10.5) * 60_000);
    expect(onRefresh).toHaveBeenCalled();
  });

  it('stops by start+11 — the deadline — and never refreshes again after it', () => {
    renderHook(() => useRoomReadyRefetch(true, START.toISOString(), onRefresh));
    // The join window + 11 min: past the deadline.
    vi.advanceTimersByTime((CASE_JOIN_WINDOW_MINUTES + 11) * 60_000);
    const countAtDeadline = onRefresh.mock.calls.length;
    expect(countAtDeadline).toBeGreaterThan(0);

    vi.advanceTimersByTime(5 * 60_000);
    expect(onRefresh.mock.calls.length).toBe(countAtDeadline);
  });

  it('stops the moment `active` flips false — e.g. the room became ready', () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useRoomReadyRefetch(active, START.toISOString(), onRefresh),
      { initialProps: { active: true } }
    );
    vi.advanceTimersByTime(2 * ROOM_READY_REFRESH_MS);
    const countBeforeStop = onRefresh.mock.calls.length;
    expect(countBeforeStop).toBeGreaterThan(0);

    rerender({ active: false });
    vi.advanceTimersByTime(5 * ROOM_READY_REFRESH_MS);
    expect(onRefresh.mock.calls.length).toBe(countBeforeStop);
  });

  it('never exceeds ROOM_READY_REFRESH_MAX calls — the hard backstop', () => {
    // A scheduled start far enough away that the TIME deadline could never be what stops it —
    // only the count backstop can be responsible for the ceiling this test pins.
    const farStart = new Date(NOW.getTime() + 1_000 * 60_000);
    renderHook(() => useRoomReadyRefetch(true, farStart.toISOString(), onRefresh));
    vi.advanceTimersByTime(80 * ROOM_READY_REFRESH_MS);
    expect(onRefresh.mock.calls.length).toBe(ROOM_READY_REFRESH_MAX);
  });

  it('clears the interval on unmount — nothing fires after', () => {
    const { unmount } = renderHook(() => useRoomReadyRefetch(true, START.toISOString(), onRefresh));
    vi.advanceTimersByTime(ROOM_READY_REFRESH_MS);
    const countBeforeUnmount = onRefresh.mock.calls.length;

    unmount();
    vi.advanceTimersByTime(10 * ROOM_READY_REFRESH_MS);
    expect(onRefresh.mock.calls.length).toBe(countBeforeUnmount);
  });

  it('calls the latest callback, not the one from first render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useRoomReadyRefetch(true, START.toISOString(), cb),
      { initialProps: { cb: first } }
    );
    rerender({ cb: second });
    vi.advanceTimersByTime(ROOM_READY_REFRESH_MS);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
