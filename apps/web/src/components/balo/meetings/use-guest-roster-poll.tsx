'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GUESTS_MAX_CONSECUTIVE_POLL_FAILURES,
  GUESTS_POLL_BACKOFF_AFTER_MS,
  GUESTS_POLL_BACKOFF_INTERVAL_MS,
  GUESTS_POLL_INTERVAL_MS,
} from '@/lib/meetings/guests-poll';
import type {
  MeetingGuestsPayload,
  MeetingMemberPanelRegistration,
} from '@/lib/meetings/meeting-panels';

/**
 * BAL-436 — the People panel's ROSTER READ and its poll schedule.
 *
 * ── ⚠⚠ THE CADENCE RULES, AND WHY EACH EXISTS ────────────────────────────────────────────
 *
 *   · **The panel being MOUNTED is the whole bound.** This hook lives in `PeoplePanel`, which
 *     the frame renders only while the People slot is open — so a closed panel polls nothing,
 *     with no "is it open?" flag to get wrong.
 *   · **A hidden document pauses**, and resumes with an IMMEDIATE fetch. A tab left in the
 *     background for forty minutes must not spend forty minutes' worth of requests, and must
 *     not show a forty-minute-old queue the instant it comes back.
 *   · **A `pending` row pins the fast tier.** A host watching somebody wait at the door is the
 *     one moment latency is felt; the back-off is for the far more common empty queue.
 *   · **Eight consecutive retryable failures stop the schedule** and surface the error state
 *     with a Retry button. A counter rather than one-strike, for the reason
 *     `LOBBY_MAX_CONSECUTIVE_POLL_FAILURES` records: a single dropped packet must not tell a
 *     host their roster is gone.
 *   · **A TERMINAL failure stops immediately.** A `404` is a verdict, not a blip; retrying it
 *     eight times is eight requests spent confirming an answer we already have.
 *
 * ⚠ EVERY MUTATION REFETCHES IMMEDIATELY (`refetch`), because the seat count and the queue
 * have both moved by then and the next tick could be 30 seconds away.
 *
 * ⚠ THE SCHEDULE RE-ENTERS THROUGH A REF, NOT THROUGH A CALLBACK'S OWN IDENTITY — the shipped
 * `useAdmissionPoll` / `call-client.tsx` pattern. A `setTimeout` closing over the tick would
 * either need the tick in its own dependency list (a cycle) or capture a stale one.
 */

export type GuestRosterStatus = 'loading' | 'ready' | 'error';

export interface GuestRosterPollState {
  /** ⚠ `null` UNTIL THE FIRST SUCCESS — and it SURVIVES a later failure, deliberately. */
  readonly payload: MeetingGuestsPayload | null;
  readonly status: GuestRosterStatus;
  /** One immediate read, outside the schedule. Used on mount, on resume and after a mutation. */
  readonly refetch: () => Promise<void>;
}

export interface UseGuestRosterPollInput {
  readonly panels: MeetingMemberPanelRegistration;
  readonly onSeatsChange: (seats: { participantCount: number; participantCap: number }) => void;
}

function isDocumentVisible(): boolean {
  return globalThis.document?.visibilityState !== 'hidden';
}

export function useGuestRosterPoll({
  panels,
  onSeatsChange,
}: UseGuestRosterPollInput): GuestRosterPollState {
  const [payload, setPayload] = useState<MeetingGuestsPayload | null>(null);
  const [status, setStatus] = useState<GuestRosterStatus>('loading');

  const openedAtRef = useRef<number>(Date.now());
  const failureCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  /** ⚠ THE LAST RESPONSE'S QUEUE DEPTH — the fast tier's only input. */
  const hasPendingRef = useRef(false);
  const tickRef = useRef<() => void>(() => {});

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback((): void => {
    clearTimer();
    if (!isDocumentVisible()) return;
    const idleFor = Date.now() - openedAtRef.current;
    const isIdle = !hasPendingRef.current && idleFor >= GUESTS_POLL_BACKOFF_AFTER_MS;
    const delay = isIdle ? GUESTS_POLL_BACKOFF_INTERVAL_MS : GUESTS_POLL_INTERVAL_MS;
    timerRef.current = setTimeout(() => tickRef.current(), delay);
  }, [clearTimer]);

  const refetch = useCallback(async (): Promise<void> => {
    const result = await panels.loadGuests();
    if (!isMountedRef.current) return;

    if (result.success) {
      failureCountRef.current = 0;
      hasPendingRef.current = result.data.guests.some((guest) => guest.admission === 'pending');
      setPayload(result.data);
      setStatus('ready');
      // ⚠ THE SEAT COUNT IS HOISTED so the top-bar chip survives the panel closing. It is the
      // SERVER's counter, passed through untouched — never a local count.
      onSeatsChange({
        participantCount: result.data.participantCount,
        participantCap: result.data.participantCap,
      });
      return;
    }

    // ⚠ A RETRYABLE FAILURE SPENDS ONE OF THE EIGHT LIVES; a TERMINAL one spends them all,
    // which is what stops the schedule immediately. Written positive-first (S7735: a negated
    // condition with an `else` is the harder of the two to read).
    if (result.retryable) {
      failureCountRef.current += 1;
    } else {
      failureCountRef.current = GUESTS_MAX_CONSECUTIVE_POLL_FAILURES;
    }
    setStatus('error');
  }, [panels, onSeatsChange]);

  const tick = useCallback((): void => {
    void refetch().then(() => {
      if (!isMountedRef.current) return;
      if (failureCountRef.current >= GUESTS_MAX_CONSECUTIVE_POLL_FAILURES) {
        // ⚠ GIVING UP ON THE SCHEDULE IS NOT GIVING UP ON THE PERSON — the error card's
        // "Try again" stays live, and the footer's controls were never gated on this read.
        clearTimer();
        return;
      }
      schedule();
    });
  }, [refetch, schedule, clearTimer]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  /** Mount: one immediate read, then the schedule. */
  useEffect(() => {
    isMountedRef.current = true;
    openedAtRef.current = Date.now();
    failureCountRef.current = 0;
    tickRef.current();
    return () => {
      isMountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // ⚠ MOUNT-ONLY, DELIBERATELY, AND THE EMPTY DEPENDENCY LIST IS THE POINT. `tickRef` is
    // what keeps the latest closure reachable, so re-running this on every `tick` identity
    // change would restart the schedule on every render — the exact thundering herd the
    // cadence exists to avoid. It reads only refs, so there is nothing stale to capture.
  }, []);

  /** ⚠ PAUSE WHEN HIDDEN; RESUME WITH AN IMMEDIATE FETCH, not with a delay. */
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (!isDocumentVisible()) {
        clearTimer();
        return;
      }
      tickRef.current();
    };
    globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
    return () => globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
  }, [clearTimer]);

  /** The manual retry / post-mutation read: reset the lives, fetch, and re-arm. */
  const manualRefetch = useCallback(async (): Promise<void> => {
    failureCountRef.current = 0;
    await refetch();
    if (isMountedRef.current) schedule();
  }, [refetch, schedule]);

  return { payload, status, refetch: manualRefetch };
}
