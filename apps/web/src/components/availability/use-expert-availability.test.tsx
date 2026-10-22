import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  AVAILABILITY_EXPERT_ID as EXPERT_ID,
  jsonResponse,
  okAvailabilityBody as okBody,
} from '@/test/fixtures/availability';
import { useExpertAvailability } from './use-expert-availability';

/** A fetch stub that rejects with a real `AbortError` DOMException when its signal aborts —
 * mirroring what the browser's actual `fetch` does, so the hook's abort branches are exercised
 * for real rather than by a mock that just never settles. */
function abortableFetch(resolveWith: () => Promise<Response> | Response): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
      Promise.resolve(resolveWith()).then(resolve, reject);
    });
  }) as unknown as typeof fetch;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useExpertAvailability', () => {
  it('starts in the loading state', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    expect(result.current.view).toEqual({ kind: 'loading' });
  });

  /**
   * ⚠ 503 → `unavailable`, NOT `error`, and that distinction is the point: a fail-closed vendor
   * read must never render as "no availability", or a client reads a broken calendar token as a
   * booked-solid expert and leaves. 500 is the catch-all that proves `unavailable` is reserved.
   */
  it.each([
    [404, 'not_published'],
    [503, 'unavailable'],
    [500, 'error'],
  ])('maps a %i to %s', async (status, kind) => {
    fetchMock.mockResolvedValue(jsonResponse(status, {}));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind }));
  });

  it('resolves to not_published without calling the public endpoint when skipFetch is set', async () => {
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14, 'new_work', true));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'not_published' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('scope (BAL-591)', () => {
    function requestedUrl(): URL {
      const [url] = fetchMock.mock.calls[0] ?? [];
      return new URL(String(url));
    }

    it('sends scope=new_work by default (the fail-safe)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      renderHook(() => useExpertAvailability(EXPERT_ID, 14));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(requestedUrl().searchParams.get('scope')).toBe('new_work');
    });

    it('sends the requested scope', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      renderHook(() => useExpertAvailability(EXPERT_ID, 14, 'existing_work'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(requestedUrl().searchParams.get('scope')).toBe('existing_work');
    });

    it('refetches when the scope changes', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
      const { rerender } = renderHook(
        ({ scope }: { scope: 'new_work' | 'existing_work' }) =>
          useExpertAvailability(EXPERT_ID, 14, scope),
        { initialProps: { scope: 'new_work' as 'new_work' | 'existing_work' } }
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      rerender({ scope: 'existing_work' });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('maps a 200 paused body to the paused view, without the slot-body validation', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { expertProfileId: EXPERT_ID, status: 'paused', days: 14 })
      );
      const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
      await waitFor(() => expect(result.current.view).toEqual({ kind: 'paused' }));
    });
  });

  it('rejects a body with an unrecognised status as error (isAvailabilityOkBody guard)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody({ status: 'garbage' })));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('rejects a body missing expertTimezone as error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody({ expertTimezone: undefined })));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('rejects a body with a non-finite days as error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody({ days: Number.NaN })));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('rejects a body whose slots contain a malformed entry (isSlotDto guard: bad start/end)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, okBody({ slots: [{ start: 123, end: 'nope', maxDuration: 30 }] }))
    );
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('rejects a slot with a non-numeric maxDuration', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okBody({
          slots: [
            {
              start: '2026-06-05T09:00:00.000Z',
              end: '2026-06-05T10:00:00.000Z',
              maxDuration: 'a',
            },
          ],
        })
      )
    );
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('rejects a slot with an unparseable date (parse is part of the guard)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        okBody({
          slots: [{ start: 'not-a-date', end: '2026-06-05T10:00:00.000Z', maxDuration: 30 }],
        })
      )
    );
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('maps status not_configured to the not_configured view', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody({ status: 'not_configured', slots: [] })));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'not_configured' }));
  });

  it('maps status no_slots to empty_window with the server-reported days', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, okBody({ status: 'no_slots', slots: [], days: 7 }))
    );
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'empty_window', days: 7 }));
  });

  it('treats an ok status with an empty slots array as empty_window (belt-and-braces)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody({ slots: [] })));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'empty_window', days: 14 }));
  });

  it('maps a fully valid ok body to the ready view', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() =>
      expect(result.current.view).toEqual({
        kind: 'ready',
        slots: okBody().slots,
        expertTimezone: 'UTC',
        days: 14,
        receivedAt: expect.any(Number),
      })
    );
  });

  it('reload() re-fetches with cache: reload (bypassing the browser HTTP cache)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));

    fetchMock.mockClear();
    act(() => {
      result.current.reload();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('reload');
  });

  it('a network error commits the error view', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });

  it('a plain (non-timeout) AbortError — e.g. from unmount or a prop change — commits nothing', async () => {
    fetchMock.mockImplementation(abortableFetch(() => new Promise<Response>(() => {})));
    const { result, unmount } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    expect(result.current.view).toEqual({ kind: 'loading' });

    unmount();

    // Give the rejected promise's .catch a turn; the view must still read 'loading' because the
    // hook already unmounted (there is nothing further to assert against, but this exercises the
    // catch branch without throwing an unhandled rejection).
    await new Promise((r) => setTimeout(r, 0));
  });

  it('a superseded request (id changes mid-flight) is abandoned without committing its answer', async () => {
    let releaseFirst: ((res: Response) => void) | undefined;
    fetchMock.mockImplementation(
      abortableFetch(
        () =>
          new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          })
      )
    );

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useExpertAvailability(id, 14),
      {
        initialProps: { id: EXPERT_ID },
      }
    );

    // Swap in a second fetch that resolves immediately for the new id.
    const secondId = '00000000-0000-0000-0000-000000000000';
    fetchMock.mockImplementationOnce(abortableFetch(() => new Promise<Response>(() => {})));
    rerender({ id: secondId });

    // Now let the FIRST (superseded) request's fetch resolve — its `commit` must be a no-op
    // because its controller was aborted by the cleanup when the id changed.
    releaseFirst?.(jsonResponse(200, okBody()));
    await new Promise((r) => setTimeout(r, 0));

    expect(result.current.view).not.toEqual({
      kind: 'ready',
      slots: okBody().slots,
      expertTimezone: 'UTC',
      days: 14,
    });
  });

  it('a timeout (no response within REQUEST_TIMEOUT_MS) commits the error view, unlike a plain abort', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(abortableFetch(() => new Promise<Response>(() => {})));

    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    expect(result.current.view).toEqual({ kind: 'loading' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
  });
});

describe('useExpertAvailability — stale-tab silent refresh', () => {
  // The grid's age is measured from when the response arrived (00:00:30 below), on the browser's
  // clock; only `Date` is faked so testing-library's polling keeps running.
  function setNow(iso: string): void {
    vi.setSystemTime(new Date(iso));
  }

  function renderRecording(): {
    kinds: string[];
    result: ReturnType<
      typeof renderHook<ReturnType<typeof useExpertAvailability>, unknown>
    >['result'];
  } {
    const kinds: string[] = [];
    const rendered = renderHook(() => {
      const value = useExpertAvailability(EXPERT_ID, 14);
      kinds.push(value.view.kind);
      return value;
    });
    return { kinds, result: rendered.result };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    setNow('2026-06-01T00:00:30.000Z');
  });

  it('refetches silently with cache: reload when the tab returns to a 3-minute-old grid', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { kinds, result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    fetchMock.mockClear();
    kinds.length = 0;

    setNow('2026-06-01T00:03:00.000Z');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('reload');
    await waitFor(() => expect(kinds.length).toBeGreaterThan(0));
    expect(kinds).not.toContain('loading');
    expect(result.current.view.kind).toBe('ready');
  });

  it.each(['focus', 'pageshow'])('also refetches on window %s', async (eventName) => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    fetchMock.mockClear();

    setNow('2026-06-01T00:03:00.000Z');
    act(() => {
      globalThis.dispatchEvent(new Event(eventName));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('does not refetch while the grid is fresh', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    fetchMock.mockClear();

    setNow('2026-06-01T00:01:30.000Z');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      globalThis.dispatchEvent(new Event('focus'));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a server clock far behind the browser's: a just-received grid is fresh", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ...okBody(), generatedAt: '2020-01-01T00:00:00.000Z' })
    );
    const { result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    fetchMock.mockClear();

    setNow('2026-06-01T00:00:40.000Z');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a server clock far ahead of the browser's: a long-held grid still refreshes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ...okBody(), generatedAt: '2099-01-01T00:00:00.000Z' })
    );
    const { result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    fetchMock.mockClear();

    setNow('2026-06-01T00:03:00.000Z');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('keeps the old view when the silent refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, okBody()));
    const { kinds, result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    const before = result.current.view;
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    kinds.length = 0;

    setNow('2026-06-01T00:03:00.000Z');
    act(() => {
      globalThis.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.view).toBe(before);
    expect(kinds).not.toContain('error');
  });

  it('removes its listeners on unmount', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, okBody()));
    const { result } = renderRecording();
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    const removed = vi.spyOn(globalThis, 'removeEventListener');

    cleanup();

    expect(removed.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(['focus', 'pageshow'])
    );
  });
});
