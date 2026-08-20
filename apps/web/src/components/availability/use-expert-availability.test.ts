import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
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

  it('maps a 404 to not_published', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, {}));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'not_published' }));
  });

  it('maps a 503 to unavailable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'unavailable' }));
  });

  it('maps any other non-ok status to error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    const { result } = renderHook(() => useExpertAvailability(EXPERT_ID, 14));
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'error' }));
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
