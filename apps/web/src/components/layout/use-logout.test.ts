import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { track, analytics, AUTH_EVENTS } from '@/lib/analytics';
import { rememberSetupIntent, readRememberedSetupIntent } from '@/lib/stripe/setup-intent-return';
import { useLogout } from './use-logout';

const mockLogoutAction = vi.fn();
vi.mock('@/lib/auth/actions/logout', () => ({
  logoutAction: () => mockLogoutAction(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLogout', () => {
  it('§C — clears the SetupIntent binding on sign-out', () => {
    rememberSetupIntent('seti_a');
    const { result } = renderHook(() => useLogout());

    result.current();

    expect(readRememberedSetupIntent()).toBeNull();
  });

  it('§C — the clear is synchronous, before logoutAction, not on the deferred reset timer', () => {
    vi.useFakeTimers();
    rememberSetupIntent('seti_a');
    const { result } = renderHook(() => useLogout());

    result.current();

    // Assert BEFORE advancing the 500ms `analytics.reset()` timer at all.
    expect(readRememberedSetupIntent()).toBeNull();
    expect(analytics.reset).not.toHaveBeenCalled();
  });

  it('tracks LOGOUT_COMPLETED and calls logoutAction', () => {
    const { result } = renderHook(() => useLogout());

    result.current();

    expect(track).toHaveBeenCalledWith(AUTH_EVENTS.LOGOUT_COMPLETED, {});
    expect(mockLogoutAction).toHaveBeenCalledTimes(1);
  });

  it('defers analytics.reset by 500ms', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLogout());

    result.current();
    expect(analytics.reset).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(analytics.reset).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(analytics.reset).toHaveBeenCalledTimes(1);
  });
});
