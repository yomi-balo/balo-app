'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallRingStatus } from '@balo/shared/meetings';
import { readCallNowRingAction } from '@/app/(call)/meetings/[meetingId]/call/_actions/read-call-now-ring';
import {
  stopCallNowRingAction,
  type StopCallNowRingResult,
} from '@/app/(call)/meetings/[meetingId]/call/_actions/stop-call-now-ring';

/** How often the caller's room asks whether the ring was answered, declined or has run out. */
export const RING_POLL_MS = 2_000;
/** The slower beat after a transport failure, so a bad connection is not hammered. */
export const RING_POLL_BACKOFF_MS = 5_000;
const TICK_MS = 1_000;
/**
 * How long past `expiresAt` the poll keeps riding out transient failures. The server settles a
 * ring a moment after it expires, so a read that still cannot answer this long after is not a blip.
 */
export const RING_LOST_GRACE_MS = 30_000;

/** Whole seconds left on the ring, rounded up, or `null` once the window has passed. */
export function ringRemainingSeconds(expiresAtIso: string, nowMs: number): number | null {
  const expiresMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresMs)) return null;
  const seconds = Math.ceil((expiresMs - nowMs) / 1000);
  return seconds > 0 ? seconds : null;
}

/** The ring the room was sent to, as the server verified it. */
export interface CallNowRingSeed {
  readonly ringId: string;
  readonly status: CallRingStatus;
  readonly expiresAtIso: string;
}

export interface CallNowRingState {
  /** `null` when this room has no ring of its own to watch. */
  readonly status: CallRingStatus | null;
  /** `null` once `expiresAt` has passed while the ring is still `ringing`: the line is hidden. */
  readonly remainingSeconds: number | null;
  /**
   * `true` once the room can no longer learn what became of the ring: the read was refused for good
   * (the ring is gone, or the session ended), or kept failing well past `expiresAt`. The caller
   * leaves the room rather than sit on "Calling".
   */
  readonly lost: boolean;
  readonly stopping: boolean;
  readonly stop: () => Promise<StopCallNowRingResult>;
}

/**
 * The caller's view of one Call now ring: its status, polled while it is `ringing`, and the
 * seconds left until `expiresAt`. The ring length varies, so the countdown always reads the
 * server's `expiresAt` and never a constant. Polling stops on a terminal status, on an answer
 * that says the ring is gone (`lost`), and on unmount.
 */
export function useCallNowRing(ring: CallNowRingSeed | null): CallNowRingState {
  const ringId = ring?.ringId ?? null;
  const [status, setStatus] = useState<CallRingStatus | null>(ring?.status ?? null);
  const [expiresAtIso, setExpiresAtIso] = useState(ring?.expiresAtIso ?? '');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [lost, setLost] = useState(false);
  const expiresMsRef = useRef(Date.parse(ring?.expiresAtIso ?? ''));
  const ringing = status === 'ringing';

  useEffect(() => {
    if (!ringing) return;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ringing]);

  useEffect(() => {
    if (!ringing || ringId === null) return;
    const watchedRingId: string = ringId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number): void => {
      timer = setTimeout(poll, delayMs);
    };
    function poll(): void {
      readCallNowRingAction({ ringId: watchedRingId })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setStatus(result.status);
            setExpiresAtIso(result.expiresAtIso);
            expiresMsRef.current = Date.parse(result.expiresAtIso);
            if (result.status === 'ringing') schedule(RING_POLL_MS);
            return;
          }
          if (result.transient && !pastGrace()) {
            schedule(RING_POLL_BACKOFF_MS);
            return;
          }
          setLost(true);
        })
        .catch(() => {
          if (cancelled) return;
          if (pastGrace()) setLost(true);
          else schedule(RING_POLL_BACKOFF_MS);
        });
    }
    function pastGrace(): boolean {
      const expiresMs = expiresMsRef.current;
      // An unreadable expiry gives no window to ride out, so a failure counts as lost.
      return !Number.isFinite(expiresMs) || Date.now() > expiresMs + RING_LOST_GRACE_MS;
    }

    schedule(RING_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [ringing, ringId]);

  const stop = useCallback(async (): Promise<StopCallNowRingResult> => {
    if (ringId === null) return { ok: false };
    setStopping(true);
    try {
      const result = await stopCallNowRingAction({ ringId });
      if (result.ok) setStatus(result.status);
      return result;
    } catch {
      return { ok: false };
    } finally {
      setStopping(false);
    }
  }, [ringId]);

  return {
    status,
    remainingSeconds: ringing ? ringRemainingSeconds(expiresAtIso, nowMs) : null,
    lost,
    stopping,
    stop,
  };
}
