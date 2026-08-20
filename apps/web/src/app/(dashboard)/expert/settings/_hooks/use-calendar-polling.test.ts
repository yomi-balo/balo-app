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

const mockGetConnections = vi.fn();
vi.mock('../_actions/get-calendar-connections', () => ({
  getCalendarConnectionsAction: (...args: unknown[]) => mockGetConnections(...args),
}));
vi.mock('../_lib/calendar-api', () => ({
  calendarApiFetch: vi.fn(),
}));

import { useCalendarPolling } from './use-calendar-polling';
import type { CalendarConnection } from '../_types/calendar';

const googleActive: CalendarConnection = {
  provider: 'google',
  credentialStatus: 'ACTIVE',
  providerEmail: 'test@gmail.com',
  lastSyncedAt: null,
  targetCalendarId: null,
  subCalendars: [
    { id: 'c1', name: 'Work', provider: 'google', primary: true, conflictChecking: true },
  ],
};

const googleSyncPending: CalendarConnection = { ...googleActive, credentialStatus: 'SYNC_PENDING' };
const microsoftActive: CalendarConnection = { ...googleActive, provider: 'microsoft' };

const NOOP_SKIP = (): ReadonlySet<never> => new Set();

describe('useCalendarPolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not poll when enabled is false', () => {
    renderHook(() =>
      useCalendarPolling({
        enabled: false,
        intervalMs: 1000,
        skipProviders: NOOP_SKIP,
        onConnections: vi.fn(),
      })
    );

    vi.advanceTimersByTime(5000);
    expect(mockGetConnections).not.toHaveBeenCalled();
  });

  it('polls at the specified interval when enabled', () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [googleSyncPending] });

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        skipProviders: NOOP_SKIP,
        onConnections: vi.fn(),
      })
    );

    vi.advanceTimersByTime(1000);
    expect(mockGetConnections).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(mockGetConnections).toHaveBeenCalledTimes(2);
  });

  it('hands the fetched array up via onConnections on a successful tick', async () => {
    const onConnections = vi.fn();
    mockGetConnections.mockResolvedValue({ ok: true, connections: [googleActive] });

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        skipProviders: NOOP_SKIP,
        onConnections,
      })
    );

    vi.advanceTimersByTime(1000);

    await vi.waitFor(() => {
      expect(onConnections).toHaveBeenCalledWith([googleActive]);
    });
  });

  it('does not call onConnections when the action returns ok:false', async () => {
    const onConnections = vi.fn();
    mockGetConnections.mockResolvedValue({ ok: false, error: 'boom' });

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        skipProviders: NOOP_SKIP,
        onConnections,
      })
    );

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(onConnections).not.toHaveBeenCalled();
  });

  it('filters out a provider in the skip set before handing the array up (a mutation in flight keeps its optimistic row)', async () => {
    const onConnections = vi.fn();
    mockGetConnections.mockResolvedValue({
      ok: true,
      connections: [googleSyncPending, microsoftActive],
    });

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        skipProviders: () => new Set(['google']),
        onConnections,
      })
    );

    vi.advanceTimersByTime(1000);

    await vi.waitFor(() => {
      expect(onConnections).toHaveBeenCalledWith([microsoftActive]);
    });
  });

  it('clears interval on unmount', () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [googleSyncPending] });

    const { unmount } = renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 1000,
        skipProviders: NOOP_SKIP,
        onConnections: vi.fn(),
      })
    );

    vi.advanceTimersByTime(1000);
    expect(mockGetConnections).toHaveBeenCalledTimes(1);

    unmount();

    vi.advanceTimersByTime(5000);
    expect(mockGetConnections).toHaveBeenCalledTimes(1);
  });

  it('stops polling when enabled changes to false', () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [googleSyncPending] });

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCalendarPolling({
          enabled,
          intervalMs: 1000,
          skipProviders: NOOP_SKIP,
          onConnections: vi.fn(),
        }),
      { initialProps: { enabled: true } }
    );

    vi.advanceTimersByTime(1000);
    expect(mockGetConnections).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });

    vi.advanceTimersByTime(5000);
    expect(mockGetConnections).toHaveBeenCalledTimes(1);
  });

  it('honours MAX_POLLS — stops fetching after 120 ticks (10 minutes at 5s)', () => {
    mockGetConnections.mockResolvedValue({ ok: true, connections: [googleSyncPending] });

    renderHook(() =>
      useCalendarPolling({
        enabled: true,
        intervalMs: 5000,
        skipProviders: NOOP_SKIP,
        onConnections: vi.fn(),
      })
    );

    vi.advanceTimersByTime(5000 * 121);
    expect(mockGetConnections).toHaveBeenCalledTimes(120);
  });
});
