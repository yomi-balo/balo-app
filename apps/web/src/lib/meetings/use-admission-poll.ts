'use client';

import { useCallback, useEffect, useRef } from 'react';
import { pollGuestAdmissionAction } from '@/app/join/_actions/poll-guest-admission';
import type { JoinGrant } from '@/lib/meetings/join-api-client';
import {
  LOBBY_MAX_CONSECUTIVE_POLL_FAILURES,
  LOBBY_POLL_BACKOFF_AFTER_MS,
  LOBBY_POLL_BACKOFF_INTERVAL_MS,
  LOBBY_POLL_INTERVAL_MS,
} from '@/lib/meetings/lobby';

/**
 * BAL-132 — "HAVE I BEEN LET IN YET?", AS ONE POLICY BOTH JOIN SURFACES SHARE.
 *
 * ⚠⚠ IT IS A HOOK RATHER THAN TWO COPIES BECAUSE THE POLICY IS THE SUBTLE PART. The cadence,
 * the back-off, which failures are retryable, how many consecutive failures are tolerated and
 * whether `Retry-After` is honoured are five decisions that MUST agree between the anonymous
 * lobby (`/join/m/[meetingId]`) and the invited guest who lands in the queue
 * (`/join/[token]`) — the second of which had no poll at all and simply toasted "waiting…" and
 * reset its button, leaving the guest to click blindly.
 *
 * ── ⚠⚠ FAILURE IS NOT REFUSAL, AND CONFLATING THEM BREAKS THE BACK-OFF ──────────────────
 *
 * The first cut treated EVERY poll failure as terminal. Since a terminal state also stops the
 * scheduler, the 5s→15s back-off — whose only purpose is to keep a patient guest inside the
 * api's rate-limit window across a ~35-minute wait — could never survive a single dropped
 * packet. A live guest on a patchy phone connection (THE primary context for a forwarded
 * meeting link) was shown "this link isn't active" for a link that was perfectly fine.
 *
 *   RETRYABLE → keep polling, bounded by {@link LOBBY_MAX_CONSECUTIVE_POLL_FAILURES}:
 *     · transport (`status: 0`) — a dropped connection is not a verdict;
 *     · `429` — we are asked to slow down, not to go away (and `Retry-After` is obeyed);
 *     · `>= 500` — an upstream wobble.
 *   TERMINAL → `404` (unknown / expired / revoked / DENIED token, or no such meeting) and
 *     `409` (the meeting is not open for join). Those are answers.
 *
 * ⚠ A SELF-RE-ARMING `setTimeout`, NOT A `setInterval`. The cadence CHANGES, and a fixed
 * interval cannot back off; more importantly a timeout re-armed only AFTER the previous call
 * settles cannot stack overlapping requests on a slow network, which is exactly how a client
 * burns through its window while waiting.
 *
 * ⚠ NO TOAST FROM HERE, EVER. A background tick is not a user-initiated mutation, and at one
 * every five seconds it would be unusable. The consumer decides what to render.
 */

/** Where the poll is in its back-off schedule, given how long we have been waiting. */
export function pollIntervalFor(waitedMs: number): number {
  return waitedMs >= LOBBY_POLL_BACKOFF_AFTER_MS
    ? LOBBY_POLL_BACKOFF_INTERVAL_MS
    : LOBBY_POLL_INTERVAL_MS;
}

/**
 * Which card a run that has STOPPED should land on.
 *
 * ⚠⚠ ONE FUNCTION, TWO CALL SITES, AND THAT IS THE FIX. There used to be two expressions:
 * this one tested `status === 503`, while the exhausted-failures branch inlined
 * `result.status >= 500`. **The `503` test was DEAD CODE** — `isRetryableStatus`
 * (`poll-guest-admission.ts`) classifies every `>= 500` as retryable, so a `503` never reaches
 * the non-retryable arm this was called from; the only mapping that ever ran was the inline
 * one. Two spellings of one rule, one of them unreachable, is how they disagree later.
 *
 * ⚠ `>= 500` IS THE BOUNDARY, deliberately and everywhere: an outage on OUR side is the ONE
 * un-collapsed failure (see `JOIN_TEMPORARILY_UNAVAILABLE_TITLE`), because it is reachable
 * only after a ≥256-bit token has already resolved AND the bearer was already admitted.
 * Everything else — `404`, `409`, `429`, transport — collapses onto the dead-link card.
 * `join-control.tsx` uses the same boundary on its click path.
 */
export function terminalOutcomeFor(status: number): 'unavailable' | 'retry_later' {
  return status >= 500 ? 'retry_later' : 'unavailable';
}

export interface UseAdmissionPollInput {
  readonly meetingId: string;
  /** ⚠ `null` DISABLES THE POLL ENTIRELY — nothing is scheduled and nothing is torn down. */
  readonly guestToken: string | null;
  /**
   * Epoch ms when the wait began, so the back-off survives a reload. `null` ⇒ "now".
   * ⚠ Passing `Date.now()` inline on every render would restart the schedule every render.
   */
  readonly waitingSince: number | null;
  readonly onAdmitted: (grant: JoinGrant) => void;
  /** Called ONCE, when the poll gives up. The consumer decides which card to render. */
  readonly onExhausted: (outcome: 'unavailable' | 'retry_later') => void;
}

export function useAdmissionPoll({
  meetingId,
  guestToken,
  waitingSince,
  onAdmitted,
  onExhausted,
}: UseAdmissionPollInput): void {
  /**
   * ⚠ THE CALLBACKS LIVE IN A REF SO THE EFFECT DOES NOT DEPEND ON THEM. A consumer that
   * forgot a `useCallback` would otherwise tear down and re-arm the timer on every render —
   * which, at a 5s cadence with a render per poll, quietly becomes a request storm.
   */
  const handlersRef = useRef({ onAdmitted, onExhausted });
  handlersRef.current = { onAdmitted, onExhausted };

  const failureCountRef = useRef(0);
  const retryAfterMsRef = useRef<number | null>(null);
  const settledRef = useRef(false);

  const poll = useCallback(async (): Promise<void> => {
    if (guestToken === null || settledRef.current) return;

    const result = await pollGuestAdmissionAction({ meetingId, guestToken });

    if (!result.success) {
      if (!result.retryable) {
        settledRef.current = true;
        handlersRef.current.onExhausted(terminalOutcomeFor(result.status));
        return;
      }

      failureCountRef.current += 1;
      if (failureCountRef.current >= LOBBY_MAX_CONSECUTIVE_POLL_FAILURES) {
        // ⚠ BOUNDED, so a genuinely dead endpoint does not leave a tab polling forever. A
        // SUSTAINED upstream failure still lands on the outage card, not the dead-link one —
        // telling an already-admitted guest their link is dead would be a lie.
        // ⚠ THROUGH `terminalOutcomeFor`, NOT AN INLINE COPY OF ITS RULE — this branch used to
        // inline `status >= 500` while that function tested `=== 503`, leaving one of the two
        // unreachable and free to drift.
        settledRef.current = true;
        handlersRef.current.onExhausted(terminalOutcomeFor(result.status));
        return;
      }
      // ⚠ HONOUR THE SERVER'S OWN ADVICE when it sent some. Ignoring `Retry-After` on a `429`
      // is how a client digs itself deeper into the window it just hit.
      retryAfterMsRef.current =
        result.retryAfterSeconds === undefined ? null : result.retryAfterSeconds * 1000;
      return;
    }

    failureCountRef.current = 0;
    retryAfterMsRef.current = null;

    if (result.state === 'admitted') {
      settledRef.current = true;
      handlersRef.current.onAdmitted(result.grant);
    }
    // `waiting` deliberately does nothing — the scheduler below re-arms.
  }, [guestToken, meetingId]);

  useEffect(() => {
    if (guestToken === null) return;

    settledRef.current = false;
    failureCountRef.current = 0;
    retryAfterMsRef.current = null;

    const startedAt = waitingSince ?? Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (cancelled || settledRef.current) return;
      // ⚠ A SERVER-SUPPLIED `Retry-After` WINS over the schedule while it is in force.
      //
      // ⚠ "FOR ONE TICK" IS WHAT AN EARLIER COMMENT SAID AND IT WAS WRONG. The override is
      // cleared on a SUCCESS and on a retryable failure that carries NO header — so consecutive
      // `429`s that each carry `Retry-After` keep replacing it and it stays in force for as
      // long as the server keeps sending one. That is the correct behaviour (obeying the
      // server's latest advice is the entire point); only the description was wrong, which is
      // worse than useless on a policy whose whole value is being readable.
      const delay = retryAfterMsRef.current ?? pollIntervalFor(Date.now() - startedAt);
      timer = setTimeout(() => {
        // ⚠ NOT AWAITED (a timer callback cannot be) and NOT PREFIXED WITH `void`: this repo
        // does not enable type-aware linting, so `no-floating-promises` never fires, and
        // SonarCloud S3735 flags the operator — which `error.tsx` and `meeting-call-surface.tsx`
        // already refuse by name. `.finally(schedule)` is what re-arms, and it runs on both
        // outcomes, so nothing is dropped.
        poll().finally(schedule);
      }, delay);
    };

    schedule();

    return () => {
      cancelled = true;
      // ⚠ A LEAKED TIMER KEEPS HITTING THE RATE LIMIT FROM A PAGE NOBODY IS LOOKING AT.
      if (timer !== null) clearTimeout(timer);
    };
  }, [guestToken, poll, waitingSince]);
}
