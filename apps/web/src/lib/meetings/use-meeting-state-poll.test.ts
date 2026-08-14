import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MEETING_STATE_MAX_CONSECUTIVE_FAILURES,
  MEETING_STATE_POLL_INTERVAL_MS,
  useMeetingStatePoll,
} from './use-meeting-state-poll';
import type { GetMeetingStateResult, MeetingStateWire } from './meeting-state';

/**
 * BAL-134 (§7.2) — **THE POLL'S CADENCE CONTRACT.** Plan §12 mandates this file by name
 * ("cadence, visibility pause, terminal stop, failure budget") and the hook shipped with no test.
 *
 * ⚠⚠ IT IS A MIRROR AND NOTHING ELSE — it writes nothing, ever. The assertions below are about
 * WHEN it reads, when it stops, and what it tells the consumer when it gives up; none of them
 * involve a client→server presence path, because there is none.
 */

const WIRE: MeetingStateWire = {
  status: 'waiting_for_participants',
  outcome: null,
  endedBy: null,
  viewerRole: 'expert',
  phase: 'running',
  clocks: {
    expertPresentMs: 60_000,
    billableMs: 0,
    expertFirstJoinedAt: '2026-08-14T10:00:00.000Z',
    billableStartedAt: null,
  },
  asOf: '2026-08-14T10:01:00.000Z',
};

function ok(overrides: Partial<MeetingStateWire> = {}): GetMeetingStateResult {
  return { success: true, state: { ...WIRE, ...overrides } };
}

const RETRYABLE: GetMeetingStateResult = { success: false, retryable: true };
const VERDICT: GetMeetingStateResult = { success: false, retryable: false };

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
  vi.restoreAllMocks();
});

describe('useMeetingStatePoll — cadence', () => {
  it('reads once immediately on mount', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it('re-arms on the 10s interval, and does NOT stack ticks', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });
    expect(load).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('exposes the parsed snapshot, not the raw wire body', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    // Instants arrive as ISO strings and must reach the consumer as `Date`s.
    expect(result.current.snapshot?.asOf).toBeInstanceOf(Date);
    expect(result.current.snapshot?.clocks.expertFirstJoinedAt).toBeInstanceOf(Date);
  });

  it('⚠ `enabled: false` reads NOTHING — no mount fetch, no schedule', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    renderHook(() => useMeetingStatePoll({ load, enabled: false }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 3);
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('⚠ a caller that allocates a NEW closure every render still gets ONE schedule', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    const { rerender } = renderHook(() => useMeetingStatePoll({ load: () => load() }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    rerender();
    rerender();
    rerender();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });
    // One mount read plus exactly one scheduled read — not one per render.
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('useMeetingStatePoll — terminal stop', () => {
  for (const status of ['ended', 'cancelled'] as const) {
    it(`stops permanently once the status is ${status}`, async () => {
      const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok({ status }));
      const { result } = renderHook(() => useMeetingStatePoll({ load }));

      await waitFor(() => expect(result.current.isStopped).toBe(true));
      expect(result.current.stopReason).toBe('terminal');
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 5);
      });
      expect(load).toHaveBeenCalledTimes(1);
    });
  }

  it('⚠ the last snapshot SURVIVES the stop — the clocks are frozen, not blanked', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockResolvedValue(ok({ status: 'ended' }));
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(result.current.isStopped).toBe(true));
    expect(result.current.snapshot?.status).toBe('ended');
  });

  it('⚠⚠ `retry()` is a NO-OP after a terminal stop', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockResolvedValue(ok({ status: 'ended' }));
    const { result } = renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(result.current.stopReason).toBe('terminal'));

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 3);
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(result.current.stopReason).toBe('terminal');
  });
});

describe('useMeetingStatePoll — the failure budget', () => {
  it(`tolerates ${MEETING_STATE_MAX_CONSECUTIVE_FAILURES - 1} failures, then stops on the last`, async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(RETRYABLE);
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    for (let i = 1; i < MEETING_STATE_MAX_CONSECUTIVE_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
      });
    }

    expect(load).toHaveBeenCalledTimes(MEETING_STATE_MAX_CONSECUTIVE_FAILURES);
    await waitFor(() => expect(result.current.stopReason).toBe('unreachable'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 5);
    });
    expect(load).toHaveBeenCalledTimes(MEETING_STATE_MAX_CONSECUTIVE_FAILURES);
  });

  it('⚠ a SUCCESS resets the budget — the count is CONSECUTIVE failures', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValue(ok());
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    for (let i = 0; i < MEETING_STATE_MAX_CONSECUTIVE_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
      });
    }

    expect(result.current.stopReason).toBeNull();
    expect(load.mock.calls.length).toBeGreaterThan(MEETING_STATE_MAX_CONSECUTIVE_FAILURES);
  });

  it('⚠ a non-retryable verdict stops IMMEDIATELY without spending eight lives', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(VERDICT);
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(result.current.stopReason).toBe('unreachable'));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('honours a `Retry-After` instead of the default cadence', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockResolvedValue({ success: false, retryable: true, retryAfterSeconds: 60 });
    renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('⚠ an UNPARSEABLE body does not spend a life and keeps the last good snapshot', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockResolvedValueOnce(ok())
      // A shape change is a deploy-shaped problem, not a connectivity one.
      .mockResolvedValue({
        success: true,
        state: { nonsense: true } as unknown as MeetingStateWire,
      });
    const { result } = renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    for (let i = 0; i < MEETING_STATE_MAX_CONSECUTIVE_FAILURES + 2; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
      });
    }

    expect(result.current.stopReason).toBeNull();
    expect(result.current.snapshot?.phase).toBe('running');
  });
});

/**
 * ⚠⚠ **THE REJECTION ARM — AND WITHOUT IT THE POLL DIED SILENTLY AND PERMANENTLY.**
 *
 * `void loadRef.current().then(…)` carried NO `.catch`. A Server Action can reject before any
 * server answers (a dropped connection, an HTML error page, a deployment-ID mismatch —
 * `call-client.tsx`'s join `.catch` documents exactly this class). On rejection the timer was
 * never re-armed, zero of the eight advertised lives were spent, `isStopped` stayed false, and it
 * surfaced as an unhandled rejection. Worse, `MeetingClockSlot` keeps interpolating
 * `baseMs + (Date.now() - asOf)` every second — so a dead poll did not freeze the chip, it
 * EXTRAPOLATED an ever-growing counted duration with no server correction, forever.
 */
describe('useMeetingStatePoll — ⚠⚠ a REJECTED action (BAL-134 regression guard)', () => {
  it('re-arms the schedule instead of dying on the first rejection', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(ok());
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });

    expect(load).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.stopReason).toBeNull();
  });

  it('spends the SAME budget as an `ok: false`, then stops with a reason', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useMeetingStatePoll({ load }));

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    for (let i = 1; i < MEETING_STATE_MAX_CONSECUTIVE_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
      });
    }

    expect(load).toHaveBeenCalledTimes(MEETING_STATE_MAX_CONSECUTIVE_FAILURES);
    await waitFor(() => expect(result.current.stopReason).toBe('unreachable'));
  });

  it('⚠ a rejection never throws out of the hook (no unhandled rejection)', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockRejectedValue(new Error('boom'));
    expect(() => renderHook(() => useMeetingStatePoll({ load }))).not.toThrow();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });
  });
});

/**
 * ⚠⚠ **`isStopped` WAS COMPUTED AND DISCARDED.** After eight failures or a refusal the poll
 * stopped permanently and nothing told anybody — the phase froze so an expert would never reach
 * "you're free to leave". These pin the signal AND the way back.
 */
describe('useMeetingStatePoll — ⚠⚠ recovering from a stop (BAL-134)', () => {
  it('`retry()` restarts a schedule that gave up', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(VERDICT);
    const { result } = renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(result.current.stopReason).toBe('unreachable'));

    load.mockResolvedValue(ok());
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.stopReason).toBeNull();
    expect(result.current.isStopped).toBe(false);
  });

  it('⚠ `retry()` restores the FULL budget, not one extra attempt', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(RETRYABLE);
    const { result } = renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    for (let i = 1; i < MEETING_STATE_MAX_CONSECUTIVE_FAILURES; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
      });
    }
    await waitFor(() => expect(result.current.stopReason).toBe('unreachable'));
    const spent = load.mock.calls.length;

    act(() => result.current.retry());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS);
    });

    expect(load.mock.calls.length).toBe(spent + 2);
  });

  it('⚠⚠ the stop is NOT sticky across an `enabled` toggle', async () => {
    // `stoppedRef` was reset on re-enable while `isStopped` was left `true`, so a healthy
    // re-enabled poll ran under a stale "reconnecting" notice.
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(VERDICT);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMeetingStatePoll({ load, enabled }),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(result.current.isStopped).toBe(true));

    load.mockResolvedValue(ok());
    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.isStopped).toBe(false));
    expect(result.current.stopReason).toBeNull();
  });

  it('⚠ a TERMINAL stop still survives an `enabled` toggle — a verdict is a verdict', async () => {
    const load = vi
      .fn<() => Promise<GetMeetingStateResult>>()
      .mockResolvedValue(ok({ status: 'ended' }));
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMeetingStatePoll({ load, enabled }),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(result.current.stopReason).toBe('terminal'));
    const spent = load.mock.calls.length;

    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 3);
    });

    expect(load.mock.calls.length).toBe(spent);
    expect(result.current.stopReason).toBe('terminal');
  });
});

describe('useMeetingStatePoll — visibility', () => {
  it('⚠ a hidden tab stops spending requests', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    act(() => {
      setVisibility('hidden');
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 4);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('⚠ resuming reads IMMEDIATELY, not after another full interval', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    act(() => {
      setVisibility('hidden');
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      setVisibility('visible');
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    });

    // A forty-minute background must not show a forty-minute-old clock on return.
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('⚠ a stopped poll does NOT resume on visibility alone — that is what `retry()` is for', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(VERDICT);
    const { result } = renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(result.current.isStopped).toBe(true));

    act(() => {
      setVisibility('hidden');
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    });
    act(() => {
      setVisibility('visible');
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('useMeetingStatePoll — unmount', () => {
  it('clears the pending timer so nothing fires after unmount', async () => {
    const load = vi.fn<() => Promise<GetMeetingStateResult>>().mockResolvedValue(ok());
    const { unmount } = renderHook(() => useMeetingStatePoll({ load }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MEETING_STATE_POLL_INTERVAL_MS * 3);
    });

    expect(load).toHaveBeenCalledTimes(1);
  });
});
