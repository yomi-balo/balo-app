import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TypingSignal } from './channels';
import { createTypingRelay, TYPING_RELAY_BACKOFF_MS, TYPING_RELAY_SLOW_MS } from './typing-relay';

/**
 * ⚠⚠ The relay's ordering contract: one call in flight, latest queued signal wins.
 *
 * The fake `send` is a PLAIN function returning a promise the test settles by hand — not a
 * `vi.fn` — so vitest never attaches its own handlers to it and a missing `.catch` in the relay
 * would surface as an unhandled rejection.
 */

interface Call {
  readonly signal: TypingSignal;
  readonly resolve: () => void;
  readonly reject: () => void;
}

function fakeSend(): { send: (signal: TypingSignal) => Promise<unknown>; calls: Call[] } {
  const calls: Call[] = [];
  const send = (signal: TypingSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      calls.push({
        signal,
        resolve: () => resolve({ success: true }),
        reject: () => reject(new Error('network')),
      });
    });
  return { send, calls };
}

/** Let the relay's settle → dispatch chain run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('createTypingRelay', () => {
  it('sends a signal at once when nothing is in flight', () => {
    const { send, calls } = fakeSend();
    const relay = createTypingRelay(send);

    expect(relay.publish('started')).toBe(true);

    expect(calls.map((call) => call.signal)).toEqual(['started']);
  });

  it('⚠⚠ never has two calls in flight — the next leaves only after the previous settles', async () => {
    const { send, calls } = fakeSend();
    const relay = createTypingRelay(send);

    relay.publish('started');
    relay.publish('stopped');
    expect(calls.map((call) => call.signal)).toEqual(['started']);

    calls[0]?.resolve();
    await flush();
    expect(calls.map((call) => call.signal)).toEqual(['started', 'stopped']);
  });

  it('⚠⚠ a newer queued signal REPLACES an older one — latest intent wins', async () => {
    const { send, calls } = fakeSend();
    const relay = createTypingRelay(send);

    relay.publish('started');
    // Queued behind the in-flight call: `stopped`, then `started`. Only the LATEST may go out.
    relay.publish('stopped');
    relay.publish('started');
    calls[0]?.resolve();
    await flush();

    expect(calls.map((call) => call.signal)).toEqual(['started', 'started']);
  });

  it('a FAILED call is not retried, and backs the relay off — the queued signal is dropped', async () => {
    const { send, calls } = fakeSend();
    const relay = createTypingRelay(send);

    relay.publish('started');
    relay.publish('stopped');
    calls[0]?.reject();
    await flush();

    expect(calls.map((call) => call.signal)).toEqual(['started']);
    expect(relay.publish('started')).toBe(false);
  });

  it('a SYNCHRONOUS throw from send is swallowed and treated as a failure', async () => {
    const signals: TypingSignal[] = [];
    const relay = createTypingRelay((signal) => {
      signals.push(signal);
      throw new Error('boom');
    });

    expect(() => relay.publish('started')).not.toThrow();
    await flush();

    expect(signals).toEqual(['started']);
    expect(relay.publish('stopped')).toBe(false);
  });

  it('⚠ close() refuses NEW signals but still sends the one queued behind an in-flight call', async () => {
    const { send, calls } = fakeSend();
    const relay = createTypingRelay(send);

    relay.publish('started');
    relay.publish('stopped');
    relay.close();
    expect(relay.publish('started')).toBe(false);

    calls[0]?.resolve();
    await flush();
    expect(calls.map((call) => call.signal)).toEqual(['started', 'stopped']);
  });

  it('after close() with nothing in flight, publish sends nothing', () => {
    const { send, calls } = fakeSend();
    const relay = createTypingRelay(send);

    relay.close();

    expect(relay.publish('stopped')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  describe('⚠⚠ backing off — a typing call must never hold up the page’s other actions', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a REFUSED call ({ success: false }) silences the relay for TYPING_RELAY_BACKOFF_MS', async () => {
      vi.useFakeTimers();
      const sent: TypingSignal[] = [];
      const relay = createTypingRelay((signal) => {
        sent.push(signal);
        return Promise.resolve({ success: false, error: 'Typing is not available here.' });
      });

      relay.publish('started');
      await vi.advanceTimersByTimeAsync(0);
      expect(relay.publish('started')).toBe(false);

      await vi.advanceTimersByTimeAsync(TYPING_RELAY_BACKOFF_MS - 1);
      expect(relay.publish('started')).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(relay.publish('started')).toBe(true);
      expect(sent).toEqual(['started', 'started']);
    });

    it('a SLOW call backs off too — even though it succeeded', async () => {
      vi.useFakeTimers();
      const { send, calls } = fakeSend();
      const relay = createTypingRelay(send);

      relay.publish('started');
      relay.publish('stopped');
      await vi.advanceTimersByTimeAsync(TYPING_RELAY_SLOW_MS);
      calls[0]?.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.map((call) => call.signal)).toEqual(['started']);
      expect(relay.publish('started')).toBe(false);
    });

    it('a call just under TYPING_RELAY_SLOW_MS does NOT back off, and releases the queue', async () => {
      vi.useFakeTimers();
      const { send, calls } = fakeSend();
      const relay = createTypingRelay(send);

      relay.publish('started');
      relay.publish('stopped');
      await vi.advanceTimersByTimeAsync(TYPING_RELAY_SLOW_MS - 1);
      calls[0]?.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.map((call) => call.signal)).toEqual(['started', 'stopped']);
    });
  });
});
