import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLogWarn, error: vi.fn() }),
}));

import {
  FLOOR_OVERRUN_MESSAGE,
  LOBBY_REENTRY_RESPONSE_FLOOR_MS,
  withResponseFloor,
} from './response-floor.js';

const ROUTE = 'lobby-reentry';

/**
 * BAL-442 (RULING 4) — the fixed-floor timing primitive. Fake timers throughout: the
 * assertions are about WHEN the promise settles, which advancing a clock states exactly and
 * sleeping only approximates.
 */
describe('withResponseFloor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the floor constant to exactly 400ms', () => {
    expect(LOBBY_REENTRY_RESPONSE_FLOOR_MS).toBe(400);
  });

  it('resolves with the work function’s own return value', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(100, async () => 'ok', ROUTE);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('ok');
  });

  it('pads a fast branch (0ms of work) up to the floor, not beyond it', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = withResponseFloor(400, async () => 'miss', ROUTE).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).resolves.toBe('miss');
  });

  it('the match arm (50ms of work) settles at the SAME floor as the miss arm', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = withResponseFloor(
      400,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('match'), 50)),
      ROUTE
    ).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).resolves.toBe('match');
  });

  it('delays the RESPONSE, not the work — the work itself settles before the floor elapses', async () => {
    vi.useFakeTimers();
    const workDone = vi.fn();
    const pending = withResponseFloor(
      400,
      async () => {
        workDone();
        return 'value';
      },
      ROUTE
    );

    // The work has already run synchronously inside the async function by the time the floor's
    // own setTimeout is scheduled — advancing 0ms lets the microtask queue drain.
    await vi.advanceTimersByTimeAsync(0);
    expect(workDone).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe('value');
  });

  it('does not pad when the work already exceeds the floor', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = withResponseFloor(
      100,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 150)),
      ROUTE
    ).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(settled).toBe(true);
    await expect(pending).resolves.toBe('slow');
  });

  it('propagates a rejection from the work without padding it to the floor', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(400, () => Promise.reject(new Error('boom')), ROUTE);

    await expect(pending).rejects.toThrow('boom');
  });
});

/**
 * BAL-442 fix round (R-4) — THE OVERRUN WARNING. The floor only equalises WHILE IT EXCEEDS THE
 * SLOWEST BRANCH, and until this landed, the day it stopped doing so was the day the two arms
 * became distinguishable by a stopwatch with NOTHING ANYWHERE REPORTING IT. A fake-timer test
 * cannot see production latency; an Axiom query for {@link FLOOR_OVERRUN_MESSAGE} can.
 */
describe('withResponseFloor — R-4: the overrun warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('⚠⚠ warns with the VERBATIM message, the route label and both durations, when the work outruns the floor', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(
      100,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 150)),
      ROUTE
    );

    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBe('slow');

    // ⚠ THE FULL LITERAL, not `stringContaining` — a fragment match would survive the message
    // being reworded out from under an Axiom monitor.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      { route: ROUTE, floorMs: 100, elapsedMs: 150 },
      FLOOR_OVERRUN_MESSAGE
    );
  });

  it('⚠ warns when the work lands EXACTLY on the floor — `remaining <= 0`, not `< 0`', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(
      100,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('exact'), 100)),
      ROUTE
    );

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('exact');

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
  });

  it('⚠ does NOT warn on a padded (healthy) branch — the negative pair', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(400, async () => 'fast', ROUTE);

    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe('fast');

    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ THE LOG IS EMITTED FROM AN UNAUTHENTICATED PATH WHOSE ENTIRE PURPOSE IS THAT A CALLER'S
   * INPUT CANNOT BE CORRELATED WITH ANYTHING. An overrun is a fact about OUR latency — never
   * about whose request produced it — so the field set is closed, not merely "safe today".
   */
  it('⚠⚠ the warning carries EXACTLY {route, floorMs, elapsedMs} — no caller-derived field can be added by accident', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(
      10,
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 50)),
      ROUTE
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    const [fields] = mockLogWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(Object.keys(fields).sort((a, b) => a.localeCompare(b))).toEqual([
      'elapsedMs',
      'floorMs',
      'route',
    ]);
  });
});
