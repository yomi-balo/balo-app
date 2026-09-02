import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const mockGetStatus = vi.fn();
vi.mock('@/lib/credit/actions', () => ({
  getTopUpCreditStatusAction: (...a: unknown[]) => mockGetStatus(...a),
}));

import {
  TOPUP_POLL_FAST_INTERVAL_MS,
  TOPUP_POLL_FAST_TICKS,
  TOPUP_POLL_SLOW_INTERVAL_MS,
  TOPUP_POLL_WINDOW_MS,
  useTopUpCreditPoll,
} from './use-topup-credit-poll';

/** ⚠ jsdom's `visibilityState` is read-only; this is the supported way to drive it. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(globalThis.document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility('visible');
  mockGetStatus.mockReset();
  mockGetStatus.mockResolvedValue({ status: 'pending', balanceMinor: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTopUpCreditPoll — cadence', () => {
  it('reads ONCE immediately on mount, and starts pending with no balance claimed', async () => {
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));

    // ⚠ THE HONEST FIRST PAINT. The webhook is asynchronous by design, so "not confirmed yet"
    // is the normal case — and no figure is asserted before a read lands.
    expect(result.current).toEqual({ status: 'pending', balanceMinor: null });

    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));
    expect(mockGetStatus).toHaveBeenCalledWith('pi_1');
  });

  it('re-arms on a SELF-RE-ARMING timeout at the fast cadence for the first five scheduled reads', async () => {
    renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));

    for (let i = 0; i < TOPUP_POLL_FAST_TICKS; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
      });
      expect(mockGetStatus).toHaveBeenCalledTimes(i + 2);
    }
  });

  it('relaxes to the slow cadence after the fast tier is spent', async () => {
    renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));

    // Burn the fast tier: 1 immediate + 5 fast = 6 reads.
    for (let i = 0; i < TOPUP_POLL_FAST_TICKS; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
      });
    }
    const callsAtTierChange = mockGetStatus.mock.calls.length;

    // The fast interval alone must NOT trigger another read now.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
    });
    expect(mockGetStatus.mock.calls).toHaveLength(callsAtTierChange);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_SLOW_INTERVAL_MS - TOPUP_POLL_FAST_INTERVAL_MS);
    });
    expect(mockGetStatus.mock.calls).toHaveLength(callsAtTierChange + 1);
  });

  it('⚠ never stacks requests — it is a self-re-arming timeout, NOT a setInterval', async () => {
    // A slow read holds the promise open across several would-be interval boundaries. With
    // `setInterval` these would pile up; with a re-arming timeout exactly one is outstanding.
    let release: (v: { status: string; balanceMinor: number }) => void = () => {};
    mockGetStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS * 4);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ status: 'pending', balanceMinor: 0 });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });
});

describe('useTopUpCreditPoll — terminal states', () => {
  it('stops permanently on credited, and surfaces the SERVER balance', async () => {
    mockGetStatus.mockResolvedValue({ status: 'credited', balanceMinor: 137_500 });
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));

    await waitFor(() => expect(result.current.status).toBe('credited'));
    expect(result.current.balanceMinor).toBe(137_500);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('stops on unauthorized WITHOUT ever claiming a balance — retrying cannot change it', async () => {
    mockGetStatus.mockResolvedValue({ status: 'unauthorized' });
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));

    await waitFor(() => expect(result.current.status).toBe('unconfirmed'));
    expect(result.current.balanceMinor).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('hard-stops at the window with `unconfirmed`, and issues no further reads', async () => {
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS + TOPUP_POLL_SLOW_INTERVAL_MS);
    });

    expect(result.current.status).toBe('unconfirmed');
    const callsAtCap = mockGetStatus.mock.calls.length;
    // Exactly 13 in practice: 1 immediate + 5 fast (t=2..10s) + 7 slow (t=15..45s). Asserted as
    // a tight RANGE rather than `toBe(13)` because `shouldAdvanceTime` lets real elapsed time
    // bleed into the mocked clock, which could shave the final read on a very slow runner. The
    // load-bearing claim is that the cost is BOUNDED and small — not 3, and not 30.
    expect(callsAtCap).toBeGreaterThanOrEqual(12);
    expect(callsAtCap).toBeLessThanOrEqual(13);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS);
    });
    expect(mockGetStatus.mock.calls).toHaveLength(callsAtCap);
  });
});

describe('useTopUpCreditPoll — failures never lie', () => {
  it('keeps polling through an `error`, and does NOT repaint a known balance as 0', async () => {
    mockGetStatus
      .mockResolvedValueOnce({ status: 'pending', balanceMinor: 2_500 })
      .mockResolvedValue({ status: 'error' });
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));

    await waitFor(() => expect(result.current.balanceMinor).toBe(2_500));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS * 2);
    });

    // ⚠ THE LAST GOOD READ SURVIVES A BLIP — `{ status: 'error' }` carries no figure by design.
    expect(result.current.balanceMinor).toBe(2_500);
    expect(result.current.status).toBe('pending');
    expect(mockGetStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats a transport-level rejection exactly like an `error` — spend a tick, keep going', async () => {
    mockGetStatus.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));

    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('pending');
    expect(result.current.balanceMinor).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });

  it('still reaches credited after a run of errors', async () => {
    mockGetStatus
      .mockResolvedValueOnce({ status: 'error' })
      .mockResolvedValueOnce({ status: 'error' })
      .mockResolvedValue({ status: 'credited', balanceMinor: 100_000 });
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));

    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS * 2);
    });

    expect(result.current).toEqual({ status: 'credited', balanceMinor: 100_000 });
  });
});

describe('useTopUpCreditPoll — visibility', () => {
  it('hidden clears the schedule; visible resumes with an IMMEDIATE fetch', async () => {
    renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS * 3);
    });
    // Still hidden — no further reads, however long we wait.
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    // ⚠ IMMEDIATE, not delayed: the buyer is looking again, so answer now.
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2));
  });

  it('a visibility event after a terminal answer is a no-op', async () => {
    mockGetStatus.mockResolvedValue({ status: 'credited', balanceMinor: 100_000 });
    const { result } = renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(result.current.status).toBe('credited'));

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_FAST_INTERVAL_MS);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });
});

describe('useTopUpCreditPoll — teardown', () => {
  it('clears its timer on unmount and lands no state update after', async () => {
    const { unmount } = renderHook(() => useTopUpCreditPoll('pi_1'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOPUP_POLL_WINDOW_MS);
    });
    // No React "update on an unmounted component" warning, and no further read.
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });
});
