import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CaseCallNowView } from '@/lib/call-now/call-now-types';
import { useCallNowView } from './use-call-now-view';

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (error: unknown) => mockCaptureException(error),
}));

const VIEW: CaseCallNowView = {
  entry: 'button',
  calleeLabel: 'Amara',
  onlineBadge: false,
  calleeOnline: false,
  calleeTimeZone: null,
  confirm: { kind: 'expert_notice', engagementId: 'eng-1' },
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockCaptureException.mockClear();
});

describe('useCallNowView', () => {
  it('is settled and empty at once when there is no read', () => {
    const { result } = renderHook(() => useCallNowView(null));
    expect(result.current).toEqual({ settled: true, callNow: null });
  });

  it('is unsettled until the read lands, then carries its view', async () => {
    const read = deferred<CaseCallNowView | null>();
    const { result } = renderHook(() => useCallNowView(read.promise));
    expect(result.current).toEqual({ settled: false, callNow: null });

    act(() => read.resolve(VIEW));

    await waitFor(() => expect(result.current).toEqual({ settled: true, callNow: VIEW }));
  });

  it('keeps the last view on screen, unsettled, while a refreshed read is in flight', async () => {
    const { result, rerender } = renderHook(({ read }) => useCallNowView(read), {
      initialProps: { read: Promise.resolve<CaseCallNowView | null>(VIEW) },
    });
    await waitFor(() => expect(result.current.callNow).toBe(VIEW));

    const next = deferred<CaseCallNowView | null>();
    rerender({ read: next.promise });
    expect(result.current).toEqual({ settled: false, callNow: VIEW });

    act(() => next.resolve(null));
    await waitFor(() => expect(result.current).toEqual({ settled: true, callNow: null }));
  });

  it('ignores a superseded read that lands late', async () => {
    const first = deferred<CaseCallNowView | null>();
    const { result, rerender } = renderHook(({ read }) => useCallNowView(read), {
      initialProps: { read: first.promise },
    });
    rerender({ read: Promise.resolve<CaseCallNowView | null>(null) });
    await waitFor(() => expect(result.current.settled).toBe(true));

    act(() => first.resolve(VIEW));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.callNow).toBeNull();
  });

  it('does not report a rejected read that was already superseded', async () => {
    let failFirst: (error: Error) => void = () => undefined;
    const failing = new Promise<CaseCallNowView | null>((_, reject) => {
      failFirst = reject;
    });
    const { result, rerender } = renderHook(({ read }) => useCallNowView(read), {
      initialProps: { read: failing },
    });
    rerender({ read: Promise.resolve<CaseCallNowView | null>(VIEW) });
    await waitFor(() => expect(result.current).toEqual({ settled: true, callNow: VIEW }));

    act(() => failFirst(new Error('dropped')));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(result.current.callNow).toBe(VIEW);
  });

  it('reports a rejected read and shows no entry', async () => {
    const error = new Error('boom');
    const read = Promise.reject(error);
    const { result } = renderHook(() => useCallNowView(read));

    await waitFor(() => expect(result.current).toEqual({ settled: true, callNow: null }));
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });
});
