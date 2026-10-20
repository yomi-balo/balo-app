import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ServerAnchoredClock } from './use-server-anchored-clock';
import { useServerAnchoredClock } from './use-server-anchored-clock';

const SERVER_NOW = new Date('2026-09-17T10:00:00.000Z');
const TICK = 30_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('useServerAnchoredClock (BAL-574)', () => {
  it('render 0 returns exactly new Date(serverNowIso), device clock 30 min FAST', () => {
    const deviceNow = new Date(SERVER_NOW.getTime() + 30 * 60_000);
    vi.useFakeTimers({ now: deviceNow });

    const seen: Date[] = [];
    const { result } = renderHook(() => {
      const clock = useServerAnchoredClock(SERVER_NOW.toISOString(), TICK);
      seen.push(clock.now);
      return clock;
    });

    expect(seen[0]?.getTime()).toBe(SERVER_NOW.getTime());
    // Non-vacuity: the clock is not a frozen constant returning this value forever — advancing
    // time moves it forward from here, proving render 0's value came from the anchor, not luck.
    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    expect(result.current.now.getTime()).toBeGreaterThan(seen[0]?.getTime() ?? 0);
  });

  it('render 0 returns exactly new Date(serverNowIso), device clock 30 min SLOW', () => {
    const deviceNow = new Date(SERVER_NOW.getTime() - 30 * 60_000);
    vi.useFakeTimers({ now: deviceNow });

    const seen: Date[] = [];
    const { result } = renderHook(() => {
      const clock = useServerAnchoredClock(SERVER_NOW.toISOString(), TICK);
      seen.push(clock.now);
      return clock;
    });

    expect(seen[0]?.getTime()).toBe(SERVER_NOW.getTime());
    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    expect(result.current.now.getTime()).toBeGreaterThan(seen[0]?.getTime() ?? 0);
  });

  it('after the mount effect, now is within a small tolerance of serverNow', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const { result } = renderHook(() => useServerAnchoredClock(SERVER_NOW.toISOString(), TICK));
    const diff = Math.abs(result.current.now.getTime() - SERVER_NOW.getTime());
    expect(diff).toBeLessThan(1000);
  });

  it('after one tick, now === serverNow + TICK — not the device clock', () => {
    const deviceNow = new Date(SERVER_NOW.getTime() + 30 * 60_000);
    vi.useFakeTimers({ now: deviceNow });
    const { result } = renderHook(() => useServerAnchoredClock(SERVER_NOW.toISOString(), TICK));

    act(() => {
      vi.advanceTimersByTime(TICK);
    });

    expect(result.current.now.getTime()).toBe(SERVER_NOW.getTime() + TICK);
  });

  it('measures the offset ONCE — a later serverNowIso does not move the clock off its anchor', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const { result, rerender } = renderHook(
      ({ serverNowIso }: { serverNowIso: string }) => useServerAnchoredClock(serverNowIso, TICK),
      { initialProps: { serverNowIso: SERVER_NOW.toISOString() } }
    );
    const before = result.current.now.getTime();

    const tenMinutesLater = new Date(SERVER_NOW.getTime() + 10 * 60_000).toISOString();
    act(() => {
      rerender({ serverNowIso: tenMinutesLater });
    });

    expect(result.current.now.getTime()).toBe(before);
  });

  it('clears its interval on unmount', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderHook(() => useServerAnchoredClock(SERVER_NOW.toISOString(), TICK));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('a zero offset (device clock exactly right) still ticks', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const { result } = renderHook(() => useServerAnchoredClock(SERVER_NOW.toISOString(), TICK));
    const first = result.current.now.getTime();

    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    const second = result.current.now.getTime();
    expect(second).toBeGreaterThan(first);

    act(() => {
      vi.advanceTimersByTime(TICK);
    });
    const third = result.current.now.getTime();
    expect(third).toBeGreaterThan(second);
  });

  /**
   * `??=` and `||=` are identical on the FIRST assignment (`null` is falsy either way), so a test
   * that never re-runs the mount effect cannot tell them apart at all.
   * They diverge only on a SECOND effect run when the already-stored offset is exactly `0`
   * (falsy, but not `null`/`undefined`) — `||=` treats that as "unset" and re-measures, `??=`
   * does not. This test forces exactly that: the offset is measured as `0` at mount, the DEVICE
   * clock then genuinely advances with no new server reading, and a refresh finally lands with a
   * server reading that implies a DIFFERENT elapsed amount than the device actually measured.
   */
  it('a measured-zero offset is never re-measured on a later effect run — pins ??= over ||=', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const { result, rerender } = renderHook(
      ({ serverNowIso }: { serverNowIso: string }) => useServerAnchoredClock(serverNowIso, TICK),
      { initialProps: { serverNowIso: SERVER_NOW.toISOString() } }
    );
    // Mount: device clock exactly matches the server, so the measured offset is exactly 0.
    expect(result.current.now.getTime()).toBe(SERVER_NOW.getTime());

    // 2 real minutes pass on the DEVICE with no new server reading yet.
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    const deviceAdvancedNow = result.current.now.getTime();
    expect(deviceAdvancedNow).toBe(SERVER_NOW.getTime() + 2 * 60_000);

    // A refresh lands with a server reading that implies +10 minutes elapsed, not +2. Re-
    // measuring against it would jump the clock to SERVER_NOW+10min; the correct behaviour
    // ignores it and keeps tracking real elapsed time from the ORIGINAL zero-offset anchor.
    act(() => {
      rerender({ serverNowIso: new Date(SERVER_NOW.getTime() + 10 * 60_000).toISOString() });
    });

    expect(result.current.now.getTime()).toBe(deviceAdvancedNow);
  });

  it('anchored is false at render 0 and true once the mount effect has run', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const seen: boolean[] = [];
    renderHook(() => {
      const clock = useServerAnchoredClock(SERVER_NOW.toISOString(), TICK);
      seen.push(clock.anchored);
      return clock;
    });

    expect(seen[0]).toBe(false);
    const last = seen.at(-1);
    expect(last).toBe(true);
  });

  it('returns a referentially stable now identity between renders that do not tick', () => {
    vi.useFakeTimers({ now: SERVER_NOW });
    const { result, rerender } = renderHook(
      (props: { tickMs: number }) => useServerAnchoredClock(SERVER_NOW.toISOString(), props.tickMs),
      { initialProps: { tickMs: TICK } }
    );
    const first: ServerAnchoredClock = result.current;
    rerender({ tickMs: TICK });
    expect(result.current.now).toBe(first.now);
  });
});
