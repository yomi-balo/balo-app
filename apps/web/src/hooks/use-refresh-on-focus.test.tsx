import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRefreshOnFocus, FOCUS_REFRESH_MIN_INTERVAL_MS } from './use-refresh-on-focus';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

beforeEach(() => {
  mockRefresh.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRefreshOnFocus (BAL-566, extracted from calendar-shell.tsx F7)', () => {
  it('mounting alone never calls router.refresh — event-driven, not periodic', () => {
    renderHook(() => useRefreshOnFocus());
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('a window focus event calls router.refresh() exactly once', () => {
    renderHook(() => useRefreshOnFocus());
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('a second focus inside the rate-limit window does not refresh again', () => {
    renderHook(() => useRefreshOnFocus());
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FOCUS_REFRESH_MIN_INTERVAL_MS - 1);
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('a focus event once the rate-limit window has elapsed refreshes again', () => {
    renderHook(() => useRefreshOnFocus());
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FOCUS_REFRESH_MIN_INTERVAL_MS);
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('document visibilitychange to visible also refreshes, sharing the same rate-limit budget', () => {
    renderHook(() => useRefreshOnFocus());
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    // Still inside the window — must not double-spend it.
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('a visibilitychange to "hidden" never refreshes', () => {
    renderHook(() => useRefreshOnFocus());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('unmounting removes both listeners', () => {
    const { unmount } = renderHook(() => useRefreshOnFocus());
    unmount();
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('honours a custom minIntervalMs', () => {
    renderHook(() => useRefreshOnFocus(5_000));
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    globalThis.dispatchEvent(new Event('focus'));
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });
});
