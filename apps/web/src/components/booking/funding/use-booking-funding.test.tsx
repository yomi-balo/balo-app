import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { BookingFundingRequest } from '@/lib/booking/actions/booking-funding-types';
import { refusedView } from './funding-fixtures';

const mockRead = vi.fn();
vi.mock('@/lib/booking/actions/read-booking-funding', () => ({
  readBookingFundingAction: (...args: unknown[]) => mockRead(...args),
}));

const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { useBookingFunding } from './use-booking-funding';

function request(overrides: Partial<BookingFundingRequest> = {}): BookingFundingRequest {
  return {
    expertProfileId: 'expert-1',
    slot: {
      startIso: '2026-11-02T01:00:00.000Z',
      endIso: '2026-11-02T01:30:00.000Z',
      durationMinutes: 30,
    },
    caseChoice: { kind: 'new', companyId: 'company-1' },
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockRead.mockReset();
  mockCaptureException.mockReset();
  mockRead.mockResolvedValue({ kind: 'clear' });
});

describe('useBookingFunding', () => {
  it('stays idle with no view and reads nothing for a null request', () => {
    const { result } = renderHook(() => useBookingFunding(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.view).toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('loads, then reports the answer', async () => {
    const view = refusedView();
    mockRead.mockResolvedValue(view);
    const { result } = renderHook(() => useBookingFunding(request()));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view).toEqual(view);
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockRead).toHaveBeenCalledWith(request());
  });

  it('never shows the previous request’s answer on the render that changes the request', async () => {
    const view = refusedView();
    mockRead.mockResolvedValueOnce(view);
    const { result, rerender } = renderHook(({ req }) => useBookingFunding(req), {
      initialProps: { req: request() },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const next = deferred<{ kind: 'clear' }>();
    mockRead.mockReturnValueOnce(next.promise);

    rerender({ req: request({ caseChoice: { kind: 'new', companyId: 'company-2' } }) });

    expect(result.current.status).toBe('loading');
    expect(result.current.view).toBeNull();
    next.resolve({ kind: 'clear' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('does not re-read on a re-render with an equal request', async () => {
    const { result, rerender } = renderHook(({ req }) => useBookingFunding(req), {
      initialProps: { req: request() },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ req: request() });
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'slot',
      request({
        slot: {
          startIso: '2026-11-02T02:00:00.000Z',
          endIso: '2026-11-02T02:30:00.000Z',
          durationMinutes: 30,
        },
      }),
    ],
    ['company', request({ caseChoice: { kind: 'new', companyId: 'company-2' } })],
    ['case', request({ caseChoice: { kind: 'existing', engagementId: 'engagement-1' } })],
    ['expert', request({ expertProfileId: 'expert-2' })],
  ])(
    'reads again when the %s changes, clearing the old view while it loads',
    async (_label, next) => {
      mockRead.mockResolvedValue(refusedView());
      const { result, rerender } = renderHook(({ req }) => useBookingFunding(req), {
        initialProps: { req: request() },
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      const pending = deferred<{ kind: 'clear' }>();
      mockRead.mockReturnValueOnce(pending.promise);
      rerender({ req: next });
      await waitFor(() => expect(result.current.status).toBe('loading'));
      expect(result.current.view).toBeNull();
      expect(mockRead).toHaveBeenLastCalledWith(next);

      await act(async () => pending.resolve({ kind: 'clear' }));
      await waitFor(() => expect(result.current.view).toEqual({ kind: 'clear' }));
    }
  );

  it('drops a stale answer that arrives after a newer request began', async () => {
    const first = deferred<ReturnType<typeof refusedView>>();
    mockRead.mockReturnValueOnce(first.promise);
    const { result, rerender } = renderHook(({ req }) => useBookingFunding(req), {
      initialProps: { req: request() },
    });
    mockRead.mockResolvedValueOnce({ kind: 'clear' });
    rerender({ req: request({ expertProfileId: 'expert-2' }) });
    await waitFor(() => expect(result.current.view).toEqual({ kind: 'clear' }));

    await act(async () => first.resolve(refusedView()));
    expect(result.current.view).toEqual({ kind: 'clear' });
  });

  it('reports a rejection to Sentry and lands in error with no view', async () => {
    const failure = new Error('boom');
    mockRead.mockRejectedValue(failure);
    const { result } = renderHook(() => useBookingFunding(request()));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.view).toBeNull();
    expect(mockCaptureException).toHaveBeenCalledWith(failure, {
      tags: { feature: 'booking', step: 'funding_preflight' },
    });
  });

  it('refresh forwards onCoveredHold, updates state and returns the view', async () => {
    const { result } = renderHook(() => useBookingFunding(request()));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const refused = refusedView({ arm: 'hold' });
    mockRead.mockResolvedValueOnce(refused);
    let returned: unknown;
    await act(async () => {
      returned = await result.current.refresh({ onCoveredHold: 'refuse' });
    });
    expect(returned).toEqual(refused);
    expect(mockRead).toHaveBeenLastCalledWith({ ...request(), onCoveredHold: 'refuse' });
    expect(result.current.view).toEqual(refused);
  });

  it('refresh sends no onCoveredHold when none is given', async () => {
    const { result } = renderHook(() => useBookingFunding(request()));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(mockRead).toHaveBeenLastCalledWith(request());
  });

  it('refresh returns null when the read throws', async () => {
    const { result } = renderHook(() => useBookingFunding(request()));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    mockRead.mockRejectedValueOnce(new Error('boom'));
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.refresh();
    });
    expect(returned).toBeNull();
    expect(result.current.status).toBe('error');
  });

  it('refresh returns null with no request', async () => {
    const { result } = renderHook(() => useBookingFunding(null));
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.refresh();
    });
    expect(returned).toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });
});
