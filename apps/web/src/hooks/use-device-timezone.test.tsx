import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeviceTimezone } from './use-device-timezone';

/** Fakes only the zero-argument device probe; every `Intl.DateTimeFormat(locale, options)` call
 *  still reaches the real implementation, so alias canonicalisation is exercised for real. */
function mockDeviceZone(timeZone: string): void {
  vi.restoreAllMocks();
  const RealDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    if (args.length === 0) {
      return { resolvedOptions: () => ({ timeZone }) } as Intl.DateTimeFormat;
    }
    return new RealDateTimeFormat(...args);
  } as unknown as typeof Intl.DateTimeFormat);
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('useDeviceTimezone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setVisibility('visible');
  });

  it('resolves the device zone after mount', () => {
    mockDeviceZone('Europe/London');
    const { result } = renderHook(() => useDeviceTimezone());
    expect(result.current).toBe('Europe/London');
  });

  it('canonicalises an alias', () => {
    mockDeviceZone('US/Pacific');
    const { result } = renderHook(() => useDeviceTimezone());
    expect(result.current).toBe('America/Los_Angeles');
  });

  it('is null when the runtime reports no zone', () => {
    mockDeviceZone('');
    const { result } = renderHook(() => useDeviceTimezone());
    expect(result.current).toBeNull();
  });

  it('re-reads when the window regains focus', () => {
    mockDeviceZone('Australia/Sydney');
    const { result } = renderHook(() => useDeviceTimezone());
    expect(result.current).toBe('Australia/Sydney');

    mockDeviceZone('Europe/London');
    act(() => {
      globalThis.dispatchEvent(new Event('focus'));
    });
    expect(result.current).toBe('Europe/London');
  });

  it('re-reads when the tab becomes visible', () => {
    mockDeviceZone('Australia/Sydney');
    const { result } = renderHook(() => useDeviceTimezone());

    mockDeviceZone('America/New_York');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe('America/New_York');
  });

  it('ignores a visibilitychange to hidden', () => {
    mockDeviceZone('Australia/Sydney');
    const { result } = renderHook(() => useDeviceTimezone());

    mockDeviceZone('America/New_York');
    setVisibility('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe('Australia/Sydney');
  });

  it('removes its listeners on unmount', () => {
    mockDeviceZone('Australia/Sydney');
    const removeWindow = vi.spyOn(globalThis, 'removeEventListener');
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => useDeviceTimezone());
    unmount();
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
