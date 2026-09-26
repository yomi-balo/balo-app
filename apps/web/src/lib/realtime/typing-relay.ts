import type { TypingSignal } from './channels';

/**
 * The answer of every typing Server Action (case, project request, in-call). `{ success: true }`
 * means the signal was PUBLISHED — the action awaits Ably's acknowledgement — not merely
 * accepted.
 */
export type SendTypingSignalResult = { success: true } | { success: false; error: string };

/** A surface's bound typing Server Action. */
export type SendTypingSignal = (signal: TypingSignal) => Promise<unknown>;

export interface TypingRelay {
  /**
   * Hand one signal to the relay. Fire-and-forget and never throws.
   *
   * @returns `false` when the signal is dropped — the relay is closed, or backing off after a
   * slow, failed or refused call — and `true` otherwise.
   */
  readonly publish: (signal: TypingSignal) => boolean;
  /**
   * Refuse every later signal. A signal already in flight, or queued behind one, still goes
   * out — which is what lets a teardown `stopped` land after the relay is closed.
   */
  readonly close: () => void;
}

const ignore = (): undefined => undefined;

/**
 * A call that took at least this long, failed, or was refused (including THROTTLED by the
 * shared rate limit — `relay-typing-signal.ts`'s `typing-signal` bucket) puts the relay into
 * {@link TYPING_RELAY_BACKOFF_MS} of silence.
 *
 * ⚠ WHY A TYPING CALL MUST BE CHEAP OR ABSENT: every signal is a Server Action, and Next runs a
 * page's Server Actions ONE AT A TIME — a slow typing call delays the message send, token
 * refresh or in-call action queued behind it. When calls are slow (Ably or the database is
 * degraded) or refused (the thread closed under the composer), backing off costs only the
 * indicator, never the conversation.
 */
export const TYPING_RELAY_SLOW_MS = 2_000;
export const TYPING_RELAY_BACKOFF_MS = 30_000;

/** A settled answer that says the signal did not go out (`{ success: false }`). */
function isRefusal(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { success?: unknown }).success === false
  );
}

/**
 * ⚠⚠ ONE SIGNAL IN FLIGHT AT A TIME, LATEST WINS.
 *
 * Each signal is its own Server Action call, and two calls in flight together are two
 * independent serverless requests that can reach Ably in either order. A `stopped` overtaking
 * its `started` would leave a phantom typist on every screen until the 12 s receiver expiry. So
 * the next call leaves only after the previous one settled — and the action returns only after
 * Ably acknowledged (`publishTypingSignal`) — which makes the channel order the send order.
 *
 * While a call is in flight, a new signal REPLACES any queued one rather than queueing behind
 * it: only the latest intent matters ("stopped" after "started" after "stopped" is just
 * "stopped"), and it bounds an honest client to one request at a time however fast it types.
 *
 * A failed call is dropped, never retried: the sender's heartbeat re-sends `started` within
 * 10 s, and a lost `stopped` is what the receivers' expiry exists for. A SLOW, failed or refused
 * call also silences the relay for {@link TYPING_RELAY_BACKOFF_MS} — see
 * {@link TYPING_RELAY_SLOW_MS} for why.
 */
export function createTypingRelay(send: SendTypingSignal): TypingRelay {
  let inFlight = false;
  let queued: TypingSignal | null = null;
  let closed = false;
  let silentUntil = 0;

  const settle = (startedAt: number, succeeded: boolean): void => {
    inFlight = false;
    const next = queued;
    queued = null;
    if (!succeeded || Date.now() - startedAt >= TYPING_RELAY_SLOW_MS) {
      // Backing off drops the queued signal too: sending it would hit the same slow path.
      silentUntil = Date.now() + TYPING_RELAY_BACKOFF_MS;
      return;
    }
    if (next !== null) dispatch(next);
  };

  const dispatch = (signal: TypingSignal): void => {
    inFlight = true;
    const startedAt = Date.now();
    // The executor runs `send` synchronously and turns a synchronous throw into a rejection, so
    // one pair of handlers settles every outcome — a resolved answer, a rejection, or a throw.
    new Promise<unknown>((resolve) => {
      resolve(send(signal));
    })
      .then(
        (result) => settle(startedAt, !isRefusal(result)),
        () => settle(startedAt, false)
      )
      .catch(ignore);
  };

  return {
    publish(signal: TypingSignal): boolean {
      if (closed || Date.now() < silentUntil) return false;
      if (inFlight) {
        queued = signal;
      } else {
        dispatch(signal);
      }
      return true;
    },
    close(): void {
      closed = true;
    },
  };
}
