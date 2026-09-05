import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { DrawdownState } from '@balo/shared/credit';
import type { GetMeetingDrawdownResult, MeetingBalancePanelActions } from './meeting-panels';
import {
  DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES,
  DRAWDOWN_POLL_INTERVAL_MS,
  DRAWDOWN_POLL_URGENT_INTERVAL_MS,
  useDrawdownPoll,
} from './use-drawdown-poll';

function stateFor(overrides: Partial<DrawdownState> = {}): DrawdownState {
  return {
    key: 'healthy',
    status: 'active',
    elapsed: '00:05:00',
    paused: false,
    meter: { mode: 'balance', pct: 80, tone: 'blue', label: 'Balance healthy' },
    tone: 'none',
    channels: [],
    balanceMinor: 45000,
    graceAvailable: true,
    lens: 'client',
    ratePerMinuteMinor: 450,
    ...overrides,
  };
}

function ok(state: DrawdownState, sessionId = 'sess-1'): GetMeetingDrawdownResult {
  return { success: true, state, sessionId };
}

function fail(retryable: boolean): GetMeetingDrawdownResult {
  return { success: false, error: 'boom', retryable };
}

function balanceFor(load: () => Promise<GetMeetingDrawdownResult>): MeetingBalancePanelActions {
  return { loadDrawdownState: load };
}

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
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDrawdownPoll — the zero-cost inert guarantee', () => {
  it('⚠ balance: null arms no timer and issues no fetch', async () => {
    const load = vi.fn();
    const { result } = renderHook(() => useDrawdownPoll({ balance: null }));

    expect(result.current).toEqual({
      state: null,
      sessionId: null,
      status: 'idle',
      retry: expect.any(Function),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 3);
    });

    expect(load).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });
});

describe('useDrawdownPoll — cadence', () => {
  it('fires one immediate read on mount, then the 30s cadence', async () => {
    const load = vi.fn().mockResolvedValue(ok(stateFor()));
    renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['grace', 'near', 'wrap'] as const)(
    'switches to the 10s tier once the last successful key is %s',
    async (key) => {
      const load = vi.fn().mockResolvedValue(ok(stateFor({ key, status: 'grace' })));
      renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

      await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_URGENT_INTERVAL_MS);
      });
      expect(load).toHaveBeenCalledTimes(2);
    }
  );

  it('stays on the 30s tier for healthy/low', async () => {
    const load = vi.fn().mockResolvedValue(ok(stateFor({ key: 'low' })));
    renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_URGENT_INTERVAL_MS);
    });
    // The urgent interval alone must NOT have triggered a second read.
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DRAWDOWN_POLL_INTERVAL_MS - DRAWDOWN_POLL_URGENT_INTERVAL_MS
      );
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('useDrawdownPoll — visibility', () => {
  it('hidden clears the schedule; visible resumes with an IMMEDIATE fetch', async () => {
    const load = vi.fn().mockResolvedValue(ok(stateFor()));
    renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 2);
    });
    // Still hidden — no further reads, however long we wait.
    expect(load).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe('useDrawdownPoll — failures', () => {
  it('a retryable failure spends ONE life and keeps polling at the baseline cadence', async () => {
    const load = vi.fn().mockResolvedValue(fail(true));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    // ⚠ NOT YET `'error'` — that is reserved for the failure CAP (see the module docblock). A
    // single blip before ANY successful read stays `'loading'`, honestly: no data has arrived,
    // and the schedule has not given up either.
    expect(result.current.status).toBe('loading');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a TERMINAL (non-retryable) failure stops the schedule at once', async () => {
    const load = vi.fn().mockResolvedValue(fail(false));
    renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 5);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('⚠⚠ W2 — a TERMINAL verdict FAIL-CLOSES: it clears a previously-good state rather than keeping it', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(ok(stateFor({ key: 'low' })))
      .mockResolvedValue(fail(false));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(result.current.state?.key).toBe('low');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS);
    });

    // ⚠ UNLIKE THE RETRYABLE CAP BELOW: a verdict most often means membership was revoked
    // mid-call, so the last-known-good funding state must NOT keep rendering in this browser.
    expect(result.current.state).toBeNull();
    expect(result.current.sessionId).toBeNull();
    expect(result.current.status).toBe('error');
  });

  it('eight consecutive retryable failures stop the schedule and keep the last good state', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(ok(stateFor({ key: 'low' })))
      .mockResolvedValue(fail(true));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(result.current.state?.key).toBe('low');

    for (let i = 0; i < DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS);
      });
    }

    // ⚠ LAST-KNOWN-GOOD SURVIVES — the panel never blanks because polling dropped.
    expect(result.current.state?.key).toBe('low');
    expect(result.current.status).toBe('error');

    const callsAtCap = load.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 3);
    });
    expect(load.mock.calls).toHaveLength(callsAtCap);
  });
});

describe('useDrawdownPoll — terminal stop', () => {
  it.each(['ended', 'cancelled'] as const)('%s stops the schedule permanently', async (status) => {
    const load = vi.fn().mockResolvedValue(ok(stateFor({ key: 'end', status })));
    renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 3);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("⚠ 'wrapped' does NOT stop the schedule — settlement may still move it", async () => {
    const load = vi.fn().mockResolvedValue(ok(stateFor({ key: 'wrap', status: 'wrapped' })));
    renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_URGENT_INTERVAL_MS);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a SUCCESS answering state: null (session vanished) is terminal, not an error', async () => {
    const load = vi.fn().mockResolvedValue({ success: true, state: null });
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.state).toBeNull();
    expect(result.current.sessionId).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 3);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('useDrawdownPoll — ⚠⚠ C2, retry()', () => {
  it('re-fetches after the RETRYABLE cap, and a subsequent success resumes the schedule', async () => {
    const load = vi.fn().mockResolvedValue(fail(true));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    for (let i = 0; i < DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS);
      });
    }
    expect(result.current.status).toBe('error');
    const callsAtCap = load.mock.calls.length;

    load.mockResolvedValue(ok(stateFor()));
    act(() => result.current.retry());

    await waitFor(() => expect(load.mock.calls).toHaveLength(callsAtCap + 1));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.state?.key).toBe('healthy');

    // ⚠ THE SCHEDULE RESUMED — retry() re-armed `stoppedRef`, not just this one fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS);
    });
    expect(load.mock.calls).toHaveLength(callsAtCap + 2);
  });

  it('re-fetches after a TERMINAL verdict too', async () => {
    const load = vi.fn().mockResolvedValue(fail(false));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(load).toHaveBeenCalledTimes(1);

    load.mockResolvedValue(ok(stateFor()));
    act(() => result.current.retry());

    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.state?.key).toBe('healthy');
  });
});

describe('useDrawdownPoll — ⚠⚠ fix round 2 (R6), retry() is guarded', () => {
  it('while the slot is unregistered, retry() is a genuine no-op — it never strands status in loading', () => {
    const { result } = renderHook(() => useDrawdownPoll({ balance: null }));
    expect(result.current.status).toBe('idle');

    act(() => result.current.retry());

    // ⚠ THE ROUND 1 BUG: `setStatus('loading')` ran BEFORE the no-op fetch, stranding the hook
    // in `'loading'` forever with nothing left to move it out.
    expect(result.current.status).toBe('idle');
  });

  it('a burst of clicks spends the fetch only ONCE while one is still in flight', async () => {
    const load = vi.fn().mockResolvedValue(fail(false));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    const callsAtCap = load.mock.calls.length;

    let resolveRetry: (value: GetMeetingDrawdownResult) => void = () => {};
    load.mockImplementationOnce(
      () =>
        new Promise<GetMeetingDrawdownResult>((resolve) => {
          resolveRetry = resolve;
        })
    );

    act(() => {
      result.current.retry();
      // ⚠ A SECOND CLICK WHILE THE FIRST FETCH IS STILL OUTSTANDING — must not double-spend.
      result.current.retry();
    });
    expect(load.mock.calls).toHaveLength(callsAtCap + 1);

    await act(async () => {
      resolveRetry(ok(stateFor()));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // The latch released on settlement — a LATER retry() (not a burst) fetches again.
    load.mockResolvedValue(fail(false));
    act(() => result.current.retry());
    await waitFor(() => expect(load.mock.calls).toHaveLength(callsAtCap + 2));
  });

  it('resets lastKeyRef — a retried fetch that fails again schedules at the BASELINE cadence, never a stale URGENT one', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(ok(stateFor({ key: 'grace', status: 'grace' })))
      .mockResolvedValue(fail(true));
    const { result } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(result.current.state?.key).toBe('grace');

    // Drive to the retryable cap on the URGENT cadence (`lastKeyRef` is `'grace'` throughout —
    // a failure branch never touches it).
    for (let i = 0; i < DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_URGENT_INTERVAL_MS);
      });
    }
    expect(result.current.status).toBe('error');
    const callsAtCap = load.mock.calls.length;

    // retry()'s own fetch ALSO fails (retryable) — the failure branch it lands in never sets
    // `lastKeyRef`, so only `retry()`'s own reset can clear the stale `'grace'` key.
    act(() => result.current.retry());
    await waitFor(() => expect(load.mock.calls).toHaveLength(callsAtCap + 1));

    // If `lastKeyRef` were still `'grace'`, this would already have fired a fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_URGENT_INTERVAL_MS);
    });
    expect(load.mock.calls).toHaveLength(callsAtCap + 1);

    // It fires only once the full BASELINE interval has elapsed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DRAWDOWN_POLL_INTERVAL_MS - DRAWDOWN_POLL_URGENT_INTERVAL_MS
      );
    });
    expect(load.mock.calls).toHaveLength(callsAtCap + 2);
  });
});

describe('useDrawdownPoll — teardown', () => {
  it('clears its timer on unmount and lands no state update after', async () => {
    const load = vi.fn().mockResolvedValue(ok(stateFor()));
    const { unmount } = renderHook(() => useDrawdownPoll({ balance: balanceFor(load) }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAWDOWN_POLL_INTERVAL_MS * 3);
    });
    // No React "update on an unmounted component" warning, and no further fetch.
    expect(load).toHaveBeenCalledTimes(1);
  });
});
