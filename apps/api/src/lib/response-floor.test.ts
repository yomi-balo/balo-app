import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOBBY_REENTRY_RESPONSE_FLOOR_MS, withResponseFloor } from './response-floor.js';

/**
 * BAL-442 (RULING 4) — the fixed-floor timing primitive. Fake timers throughout: the
 * assertions are about WHEN the promise settles, which advancing a clock states exactly and
 * sleeping only approximates.
 */
describe('withResponseFloor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the floor constant to exactly 400ms', () => {
    expect(LOBBY_REENTRY_RESPONSE_FLOOR_MS).toBe(400);
  });

  it('resolves with the work function’s own return value', async () => {
    vi.useFakeTimers();
    const pending = withResponseFloor(100, async () => 'ok');
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe('ok');
  });

  it('pads a fast branch (0ms of work) up to the floor, not beyond it', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = withResponseFloor(400, async () => 'miss').then((value) => {
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
      () => new Promise<string>((resolve) => setTimeout(() => resolve('match'), 50))
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
    const pending = withResponseFloor(400, async () => {
      workDone();
      return 'value';
    });

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
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 150))
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
    const pending = withResponseFloor(400, () => Promise.reject(new Error('boom')));

    await expect(pending).rejects.toThrow('boom');
  });
});
