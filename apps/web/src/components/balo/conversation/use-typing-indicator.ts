'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TypingSignal } from '@/lib/realtime/channels';

/**
 * Sender heartbeat: while the local user keeps typing, `typing.started` is re-published this
 * often so receivers' expiry never lapses mid-burst. Ably Chat's own number.
 */
export const TYPING_HEARTBEAT_MS = 10_000;

/**
 * Receiver expiry: an inbound id is dropped this long after its LAST `typing.started` unless
 * another one re-arms it. Heartbeat + 2 s grace — Ably Chat's exact numbers.
 *
 * ⚠ THIS IS THE SAFETY NET, NOT THE NORMAL PATH. `typing.stopped` normally clears an id well
 * inside a second; the expiry exists for the stop that never arrives — a killed tab, a
 * backgrounded browser, a dropped connection. It must be measured from the most recent
 * `started`, never from the first, or a continuous typist flickers out every 12 s.
 */
export const TYPING_RECEIVER_EXPIRY_MS = 12_000;

/**
 * Sender idle stop: with no keystroke for this long, the sender publishes `typing.stopped`.
 * Sized so the indicator clears within ~2 s of the other person pausing (AC1) — the heartbeat
 * alone would leave it up for up to 12 s.
 */
export const TYPING_IDLE_STOP_MS = 1_500;

/** What a surface needs: who is typing, plus the two composer hooks. */
export interface TypingIndicatorView {
  /** Inbound typists in first-seen order. Identity is stable while the SET is unchanged. */
  readonly typingClientIds: readonly string[];
  /** Call on every keystroke that leaves non-empty text in the composer. */
  readonly onKeystroke: () => void;
  /** Call on send, on blur and when the input is cleared. Idempotent. */
  readonly onStopped: () => void;
}

/** The full machine: the view plus the transport-facing inbound side. */
export interface TypingIndicator extends TypingIndicatorView {
  /** Feed one inbound signal. `clientId` must already be self-filtered by the transport. */
  readonly receive: (signal: TypingSignal, clientId: string) => void;
  /** Drop every inbound id and cancel every inbound timer (channel switch / teardown). */
  readonly clear: () => void;
}

export interface UseTypingIndicatorInput {
  /**
   * Hands one signal to the current typing thread's relay (`createTypingRelay`), or `null` when
   * there is none (realtime disabled, no writable thread). Read through a ref at CALL time, so a
   * changed function is honoured by the very next keystroke or heartbeat without re-creating any
   * callback.
   *
   * ⚠ IT RETURNS WHETHER THE SIGNAL WAS TAKEN (`TypingRelay.publish`: `false` once that relay is
   * closed). A `started` that was not taken opens no burst, so the next keystroke tries again
   * instead of the typist staying invisible until the first heartbeat.
   */
  readonly publish: ((signal: TypingSignal) => boolean) | null;
}

const NO_ONE: readonly string[] = [];

type Timeout = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

/**
 * The transport-agnostic "typing…" state machine: both the OUTBOUND throttle for the local
 * composer and the INBOUND expiry set for everyone else. It never touches Ably — the caller
 * injects `publish` and feeds `receive` — so it is driven entirely by fake timers in tests.
 *
 * SENDER. The first keystroke publishes `started` and — only if that publish was TAKEN — opens a
 * burst: a heartbeat re-publishes `started` every {@link TYPING_HEARTBEAT_MS} while it lasts, and
 * further keystrokes publish nothing and only re-arm the idle timer. A `started` that was not
 * taken opens nothing, so the next keystroke retries; a heartbeat that was not taken (the relay
 * closed under it) closes the burst the same way. {@link TYPING_IDLE_STOP_MS} without a
 * keystroke, an explicit `onStopped`, or unmount publishes `stopped` once for an open burst. A
 * `null` publish makes keystrokes inert; a burst already under way winds down through the idle
 * timer, publishing nothing.
 *
 * ⚠ A TRANSPORT THAT SWITCHES CHANNELS MUST CALL `onStopped()` BEFORE RE-POINTING `publish`.
 * The `stopped` then lands on the OLD channel, and the next keystroke opens a fresh burst on
 * the new one; skipping it leaves the machine "active" and the new channel silent until the
 * idle timer lapses. The unmount stop is best effort for the same reason — if the channel is
 * released first, the receivers' expiry is what clears the indicator.
 *
 * RECEIVER. `started` adds an id (first-seen order) and (re)arms its expiry; `stopped` removes
 * it at once and cancels that timer; the expiry removes it. The expiry-timer map is the
 * membership record: an id is in `typingClientIds` exactly when it has a live timer.
 *
 * ⚠⚠ A REPEATED `started` FOR A PRESENT ID MUST NOT SET STATE. Heartbeats arrive every 10 s per
 * typist; each one re-arms the timer and nothing else, so the array keeps its identity, the
 * surface does not re-render, and the `aria-live` region is not re-announced. Only a change to
 * the SET produces a new array.
 *
 * ⚠ SELF-FILTERING IS NOT DONE HERE. Dropping the viewer's own id (and so deduping the viewer's
 * other tabs, which share one `clientId`) happens in `attachTypingChannel`, the only place that
 * knows the viewer's Ably identity. Anything this machine is fed, it shows.
 *
 * Every returned callback is referentially stable for the life of the mount, and the returned
 * object changes identity only when `typingClientIds` does.
 */
export function useTypingIndicator(input: UseTypingIndicatorInput): TypingIndicator {
  const { publish } = input;

  const publishRef = useRef(publish);
  useEffect(() => {
    publishRef.current = publish;
  }, [publish]);

  const activeRef = useRef(false);
  const idleTimerRef = useRef<Timeout | null>(null);
  const heartbeatRef = useRef<Interval | null>(null);

  const [typingClientIds, setTypingClientIds] = useState<readonly string[]>(NO_ONE);
  const expiryTimersRef = useRef(new Map<string, Timeout>());

  const clearSenderTimers = useCallback((): void => {
    if (idleTimerRef.current !== null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (heartbeatRef.current !== null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const onStopped = useCallback((): void => {
    clearSenderTimers();
    if (!activeRef.current) return;
    activeRef.current = false;
    publishRef.current?.('stopped');
  }, [clearSenderTimers]);

  const onKeystroke = useCallback((): void => {
    const send = publishRef.current;
    if (send === null) return;

    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => onStopped(), TYPING_IDLE_STOP_MS);

    if (activeRef.current || !send('started')) return;
    activeRef.current = true;
    heartbeatRef.current = setInterval(() => {
      if (publishRef.current?.('started') === true) return;
      // Not sent: close the burst so the next keystroke re-announces at once, rather than the
      // typist waiting out another heartbeat after the connection recovers.
      activeRef.current = false;
      clearSenderTimers();
    }, TYPING_HEARTBEAT_MS);
  }, [onStopped, clearSenderTimers]);

  const drop = useCallback((clientId: string): void => {
    const timers = expiryTimersRef.current;
    const timer = timers.get(clientId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(clientId);
    setTypingClientIds((prev) => prev.filter((id) => id !== clientId));
  }, []);

  const receive = useCallback(
    (signal: TypingSignal, clientId: string): void => {
      if (signal === 'stopped') {
        drop(clientId);
        return;
      }
      const timers = expiryTimersRef.current;
      const existing = timers.get(clientId);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(
        clientId,
        setTimeout(() => drop(clientId), TYPING_RECEIVER_EXPIRY_MS)
      );
      if (existing === undefined) setTypingClientIds((prev) => [...prev, clientId]);
    },
    [drop]
  );

  const clear = useCallback((): void => {
    const timers = expiryTimersRef.current;
    if (timers.size === 0) return;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    setTypingClientIds(NO_ONE);
  }, []);

  // Unmount: stop an open burst (best effort — see the docblock) and leave no timer behind.
  useEffect(
    () => () => {
      onStopped();
      clear();
    },
    [onStopped, clear]
  );

  return useMemo(
    () => ({ typingClientIds, onKeystroke, onStopped, receive, clear }),
    [typingClientIds, onKeystroke, onStopped, receive, clear]
  );
}
