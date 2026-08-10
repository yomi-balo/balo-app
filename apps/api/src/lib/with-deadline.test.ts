import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError, withDeadline } from './with-deadline.js';

/**
 * `withDeadline` exists for ONE failure mode, and it is not the obvious one: a promise that
 * never settles. `getRedis()` sets `maxRetriesPerRequest: null` (BullMQ requires it), and
 * ioredis only flushes pending commands with an error when that option is a NUMBER — with
 * `null` plus the default offline queue, a command issued while Redis is unreachable is
 * parked indefinitely rather than rejected. Every fail-closed `catch` downstream of such a
 * call is dead code until something bounds the wait.
 *
 * Fake timers throughout: the assertions are about WHEN the deadline fires, which advancing
 * a clock states exactly and sleeping only approximates.
 */
const OPTIONS = { deadlineMs: 2_000, label: 'test op' } as const;

/** A promise that never settles — the ioredis-while-disconnected shape. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the happy path is untouched', () => {
    it('resolves with the operation value when it settles in time', async () => {
      await expect(withDeadline(async () => 'ok', OPTIONS)).resolves.toBe('ok');
    });

    it('propagates the operation error verbatim, not as a deadline error', async () => {
      const failure = new Error('Redis unavailable');

      await expect(withDeadline(() => Promise.reject(failure), OPTIONS)).rejects.toThrow(failure);
    });

    it('propagates a synchronous throw from the operation', async () => {
      await expect(
        withDeadline(() => {
          throw new Error('boom');
        }, OPTIONS)
      ).rejects.toThrow('boom');
    });
  });

  describe('the deadline', () => {
    it('rejects with DeadlineExceededError once the deadline passes', async () => {
      vi.useFakeTimers();

      const pending = withDeadline(neverSettles, OPTIONS);
      const assertion = expect(pending).rejects.toThrow(DeadlineExceededError);
      await vi.advanceTimersByTimeAsync(OPTIONS.deadlineMs + 1);

      await assertion;
    });

    it('names the label and the deadline in the message, for the log line', async () => {
      vi.useFakeTimers();

      const pending = withDeadline(neverSettles, {
        deadlineMs: 2_000,
        label: 'rate limit ratelimit:meeting-guests:user',
      });
      const assertion = expect(pending).rejects.toThrow(
        'rate limit ratelimit:meeting-guests:user exceeded its 2000ms deadline'
      );
      await vi.advanceTimersByTimeAsync(2_001);

      await assertion;
    });

    it('does NOT fire early — a slow-but-alive operation still wins', async () => {
      vi.useFakeTimers();

      const pending = withDeadline(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 1_500)),
        OPTIONS
      );
      await vi.advanceTimersByTimeAsync(1_600);

      await expect(pending).resolves.toBe('slow');
    });

    it('exposes label and deadlineMs on the error for a structured log', async () => {
      vi.useFakeTimers();

      const pending = withDeadline(neverSettles, OPTIONS).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(OPTIONS.deadlineMs + 1);
      const error = await pending;

      expect(error).toBeInstanceOf(DeadlineExceededError);
      expect((error as DeadlineExceededError).label).toBe('test op');
      expect((error as DeadlineExceededError).deadlineMs).toBe(2_000);
      expect((error as DeadlineExceededError).name).toBe('DeadlineExceededError');
    });
  });

  /**
   * ⚠ THE ABANDONED PROMISE. When the deadline wins, the underlying operation is still
   * pending and may reject LATER. With no handler attached that surfaces as an
   * `unhandledRejection` — which on a hardened Node process kills the worker, turning a
   * Redis blip into an outage strictly worse than the hang this function replaced.
   */
  describe('the abandoned operation cannot crash the process', () => {
    it('does not emit unhandledRejection when the operation rejects after the deadline', async () => {
      vi.useFakeTimers();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      try {
        let rejectLate: (reason: Error) => void = () => {};
        const pending = withDeadline(
          () =>
            new Promise<never>((_resolve, reject) => {
              rejectLate = reject;
            }),
          OPTIONS
        ).catch(() => 'deadline won');

        await vi.advanceTimersByTimeAsync(OPTIONS.deadlineMs + 1);
        expect(await pending).toBe('deadline won');

        // The operation now fails, long after nobody is waiting on it.
        rejectLate(new Error('Redis finally errored'));

        // Give the rejection a chance to be reported as unhandled.
        vi.useRealTimers();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  /**
   * A leaked `setTimeout` per call would keep the event loop alive and stall a graceful
   * shutdown — the timer must be cleared on the success path too, not only on timeout.
   */
  describe('timer hygiene', () => {
    it('clears the deadline timer when the operation wins', async () => {
      vi.useFakeTimers();

      await withDeadline(async () => 'ok', OPTIONS);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the deadline timer when the operation rejects', async () => {
      vi.useFakeTimers();

      await expect(withDeadline(() => Promise.reject(new Error('nope')), OPTIONS)).rejects.toThrow(
        'nope'
      );

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
