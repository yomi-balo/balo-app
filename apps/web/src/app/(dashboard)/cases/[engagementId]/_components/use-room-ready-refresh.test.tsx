import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRoomReadyRefresh } from './use-room-ready-refresh';
import { ROOM_READY_REFRESH_MS } from '@/lib/meetings/room-ready-refresh-schedule';

/** BAL-581 — the case page's wrapper over the shared bounded schedule (`useRoomReadyRefetch`). */

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

const NOW = new Date('2026-01-06T12:00:00.000Z');
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
  it('mounting alone never refreshes', () => {
    renderHook(() => useRoomReadyRefresh(true, START.toISOString()));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('re-runs the Server Component via router.refresh on each tick while active', () => {
    renderHook(() => useRoomReadyRefresh(true, START.toISOString()));
    vi.advanceTimersByTime(2 * ROOM_READY_REFRESH_MS);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh while inactive', () => {
    renderHook(() => useRoomReadyRefresh(false, START.toISOString()));
    vi.advanceTimersByTime(5 * ROOM_READY_REFRESH_MS);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
