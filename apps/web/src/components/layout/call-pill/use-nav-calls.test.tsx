import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let mockPathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { MEETINGS_CHANGED_EVENT } from '@/lib/meetings/meetings-changed-event';
import type { NavCallsResponse, NavCallView } from '@/lib/meetings/nav-call-view-types';
import { NAV_CALLS_PATHNAME_REFETCH_MIN_MS, useNavCalls } from './use-nav-calls';

const NOW = new Date('2026-09-17T10:00:00.000Z');
const MIN = 60_000;

function call(startOffsetMin: number): NavCallView {
  return {
    meetingId: 'm-1',
    contextType: 'case',
    title: null,
    counterpartyName: 'Priya',
    counterpartyOrgLabel: null,
    scheduledStart: new Date(NOW.getTime() + startOffsetMin * MIN).toISOString(),
    scheduledEnd: new Date(NOW.getTime() + (startOffsetMin + 30) * MIN).toISOString(),
    status: 'scheduled',
    href: null,
    joinPath: '/meetings/m-1/call',
    rescheduleProposalExpiresAt: null,
    roomReady: true,
    otherWorkspace: false,
  };
}

function payload(calls: NavCallView[] = []): NavCallsResponse {
  return { serverNowIso: new Date(Date.now()).toISOString(), impersonating: false, calls };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

const mockFetch = vi.fn();

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  mockPathname = '/dashboard';
  mockFetch.mockReset();
  mockCaptureException.mockReset();
  mockFetch.mockImplementation(() => Promise.resolve(okResponse(payload())));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useNavCalls — fetching', () => {
  it('fetches on mount with cache: no-store and exposes the response', async () => {
    const body = payload([call(10)]);
    mockFetch.mockResolvedValue(okResponse(body));

    const { result } = renderHook(() => useNavCalls());
    expect(result.current.data).toBeNull();
    await flush();

    expect(mockFetch).toHaveBeenCalledWith('/api/meetings/nav-calls', { cache: 'no-store' });
    expect(result.current.data).toEqual(body);
  });

  it('refetches when the tab becomes visible', async () => {
    renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when the tab becomes hidden', async () => {
    renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockFetch).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('refetches on MEETINGS_CHANGED_EVENT with no throttle', async () => {
    renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    await act(async () => {
      globalThis.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT));
      globalThis.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT));
    });
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('exposes a refetch that fetches again', async () => {
    const { result } = renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    act(() => {
      result.current.refetch();
    });
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stops listening on unmount', async () => {
    const { unmount } = renderHook(() => useNavCalls());
    await flush();
    unmount();
    mockFetch.mockClear();

    globalThis.dispatchEvent(new Event(MEETINGS_CHANGED_EVENT));

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('useNavCalls — pathname throttle', () => {
  it('a route change within the throttle does not refetch', async () => {
    const { rerender } = renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAV_CALLS_PATHNAME_REFETCH_MIN_MS - 1000);
    });
    mockPathname = '/cases';
    rerender();
    await flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a route change after the throttle refetches', async () => {
    const { rerender } = renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NAV_CALLS_PATHNAME_REFETCH_MIN_MS);
    });
    mockPathname = '/cases';
    rerender();
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('useNavCalls — failure handling', () => {
  it('keeps the previous data on a non-OK response', async () => {
    const body = payload([call(10)]);
    mockFetch.mockResolvedValueOnce(okResponse(body));
    const { result } = renderHook(() => useNavCalls());
    await flush();

    mockFetch.mockResolvedValue({ ok: false, status: 500 } as Response);
    act(() => {
      result.current.refetch();
    });
    await flush();

    expect(result.current.data).toEqual(body);
  });

  it('keeps the previous data on a network error', async () => {
    const body = payload([call(10)]);
    mockFetch.mockResolvedValueOnce(okResponse(body));
    const { result } = renderHook(() => useNavCalls());
    await flush();

    mockFetch.mockRejectedValue(new Error('offline'));
    act(() => {
      result.current.refetch();
    });
    await flush();

    expect(result.current.data).toEqual(body);
  });

  it('a 401 clears the data', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(payload([call(10)])));
    const { result } = renderHook(() => useNavCalls());
    await flush();
    expect(result.current.data).not.toBeNull();

    mockFetch.mockResolvedValue({ ok: false, status: 401 } as Response);
    act(() => {
      result.current.refetch();
    });
    await flush();

    expect(result.current.data).toBeNull();
  });

  it('a parse error goes to Sentry and keeps the previous data', async () => {
    const body = payload([call(10)]);
    mockFetch.mockResolvedValueOnce(okResponse(body));
    const { result } = renderHook(() => useNavCalls());
    await flush();

    const failure = new Error('bad json');
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(failure),
    } as Response);
    act(() => {
      result.current.refetch();
    });
    await flush();

    expect(mockCaptureException).toHaveBeenCalledWith(failure);
    expect(result.current.data).toEqual(body);
  });

  it('drops an out-of-order response', async () => {
    let resolveFirst: (value: Response) => void = () => undefined;
    const slowFirst = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fresh = payload([call(10)]);
    mockFetch.mockReturnValueOnce(slowFirst).mockResolvedValue(okResponse(fresh));

    const { result } = renderHook(() => useNavCalls());
    act(() => {
      result.current.refetch();
    });
    await flush();
    expect(result.current.data).toEqual(fresh);

    await act(async () => {
      resolveFirst(okResponse(payload([])));
    });
    await flush();

    expect(result.current.data).toEqual(fresh);
  });
});

describe('useNavCalls — window-open timer', () => {
  it('refetches once when a future join window opens, measured from the response instant', async () => {
    // Start in 10 min ⇒ window opens (3 min lead) in 7 min.
    mockFetch.mockImplementation(() => Promise.resolve(okResponse(payload([call(10)]))));
    renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * MIN - 1);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('arms nothing for a window that is already open', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(okResponse(payload([call(1)]))));
    renderHook(() => useNavCalls());
    await flush();
    mockFetch.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * MIN);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('clears the timer on unmount', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(okResponse(payload([call(10)]))));
    const { unmount } = renderHook(() => useNavCalls());
    await flush();
    unmount();
    mockFetch.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * MIN);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
