import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() =>
    Promise.resolve({
      user: { id: 'u1', expertProfileId: 'ep1' },
      save: vi.fn(),
    })
  ),
}));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockGetConnection = vi.fn();
vi.mock('../_actions/get-calendar-connection', () => ({
  getCalendarConnectionAction: (...args: unknown[]) => mockGetConnection(...args),
}));
vi.mock('../_lib/calendar-api', () => ({
  calendarApiFetch: vi.fn(),
}));

import { useCalendarPolling } from './use-calendar-polling';
import type { CalendarConnection } from '../_types/calendar';

const connectedResult: CalendarConnection = {
  status: 'connected',
  providerEmail: 'test@gmail.com',
  lastSyncedAt: null,
  targetCalendarId: null,
  subCalendars: [
    { id: 'c1', name: 'Work', provider: 'google', primary: true, conflictChecking: true },
  ],
};

const syncPendingResult: CalendarConnection = {
  ...connectedResult,
  status: 'sync_pending',
};

describe('useCalendarPolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll when enabled is false', () => {
    renderHook(() => useCalendarPolling({ enabled: false, intervalMs: 1000 }));

    vi.advanceTimersByTime(5000);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('polls at the specified interval when enabled', () => {
    mockGetConnection.mockResolvedValue(syncPendingResult);

    renderHook(() => useCalendarPolling({ enabled: true, intervalMs: 1000 }));

    // Tick 1 — first poll fires
    vi.advanceTimersByTime(1000);
    expect(mockGetConnection).toHaveBeenCalledTimes(1);

    // Tick 2
    vi.advanceTimersByTime(1000);
    expect(mockGetConnection).toHaveBeenCalledTimes(2);
  });

  it('calls onStatusChange when status transitions from sync_pending', async () => {
    const onStatusChange = vi.fn();
    mockGetConnection.mockResolvedValue(connectedResult);

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        onStatusChange,
      })
    );

    // Tick — fires poll
    vi.advanceTimersByTime(1000);

    // Flush the promise queue
    await vi.waitFor(() => {
      expect(onStatusChange).toHaveBeenCalledWith(connectedResult);
    });
  });

  it('does not call onStatusChange when status remains sync_pending', async () => {
    const onStatusChange = vi.fn();
    mockGetConnection.mockResolvedValue(syncPendingResult);

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        onStatusChange,
      })
    );

    vi.advanceTimersByTime(1000);

    // Give promise time to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('clears interval on unmount', () => {
    mockGetConnection.mockResolvedValue(syncPendingResult);

    const { unmount } = renderHook(() => useCalendarPolling({ enabled: true, intervalMs: 1000 }));

    vi.advanceTimersByTime(1000);
    expect(mockGetConnection).toHaveBeenCalledTimes(1);

    unmount();

    vi.advanceTimersByTime(5000);
    // Should not have polled further after unmount
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });

  it('stops polling when enabled changes to false', () => {
    mockGetConnection.mockResolvedValue(syncPendingResult);

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useCalendarPolling({ enabled, intervalMs: 1000 }),
      { initialProps: { enabled: true } }
    );

    vi.advanceTimersByTime(1000);
    expect(mockGetConnection).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });

    vi.advanceTimersByTime(5000);
    expect(mockGetConnection).toHaveBeenCalledTimes(1);
  });
});
