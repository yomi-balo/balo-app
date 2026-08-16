'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseMeetingState,
  type GetMeetingStateResult,
  type MeetingStateSnapshot,
} from './meeting-state';

/**
 * BAL-134 (§7.2) — **THE ONE POLLED READ THE IN-CALL MIRROR IS FED FROM.**
 *
 * ⚠⚠ **IT IS A MIRROR AND NOTHING ELSE. IT WRITES NOTHING, EVER.** The browser is never a
 * presence input: Daily's `participant-joined` / `participant-left` events stay UI-only in the
 * frame (they drive `resolveStageKind`) and are never reported to a server. A client-reported
 * join is a MONEY input supplied by a party to the transaction — a client that lies inflates
 * `billableMs`, and a client that dies silently never reports its leave. Presence is observed
 * server-to-server from Daily (D1), and `join-link-never-writes.test.ts`'s posture is
 * preserved by this hook creating no new client→server presence path.
 *
 * ⚠⚠ AND IT COMPUTES NO THRESHOLD. `phase` arrives as a LABEL the server resolved from the
 * env-overridable timers; nothing here derives `near` from a duration. See
 * `meeting-state.ts`'s docblock for why that is structural rather than stylistic.
 *
 * ── ⚠ THE CADENCE RULES, MODELLED ON `use-guest-roster-poll.tsx` ─────────────────────────
 *
 *   · **A self-re-arming `setTimeout`, NEVER `setInterval`** — the house rule stated by name
 *     in `use-admission-poll.ts`. Ticks must not stack on a slow network; an interval fires
 *     regardless of whether the previous request came back.
 *   · **A TERMINAL status stops the schedule PERMANENTLY.** `ended` and `cancelled` are
 *     verdicts, and the clocks are frozen against `ended_at` — re-reading them for the rest of
 *     a tab's life buys nothing and costs a request every ten seconds.
 *   · **A hidden document pauses**, and resumes with an IMMEDIATE fetch. A tab backgrounded
 *     for forty minutes must not spend forty minutes of requests, and must not show a
 *     forty-minute-old clock the instant it comes back.
 *   · **A `429` is honoured**, using the server's own `Retry-After` when it sent a usable one.
 *   · **Eight consecutive retryable failures stop the schedule** and the UI keeps its LAST
 *     KNOWN state rather than flapping between a mirror and a blank. A counter rather than
 *     one-strike, for the reason `LOBBY_MAX_CONSECUTIVE_POLL_FAILURES` records: a single
 *     dropped packet must not blank a participant's clock mid-call.
 *   · **A TERMINAL failure stops immediately.** A `404` is a verdict, not a blip.
 *   · **The loader is held in a ref**, so a caller's missing `useCallback` cannot re-arm the
 *     timer on every render.
 */

/**
 * ⚠ THE CADENCE CONSTANTS LIVE **HERE**, IN A PLAIN CLIENT MODULE, NOT IN THE `'use server'`
 * ACTION. A Server Action module may export ONLY async functions; an `export const` inside one
 * fails `next build` while every local gate stays green (memory
 * `reference_use_server_no_value_exports`). `guests-poll.ts` exists for the identical reason.
 */

/**
 * 10s while the meeting is live — matching `GUESTS_POLL_INTERVAL_MS` deliberately, so two
 * polls on one surface do not run on two arbitrary schedules.
 *
 * ⚠ THE MIRROR IS INTERPOLATED BETWEEN TICKS, not stepped: `MeetingClockSlot` ticks its own
 * second-by-second display from `asOf` and drift-corrects on every poll. So this number is
 * about how fast a STATE CHANGE (waiting → in progress → ended) surfaces, not about how smooth
 * the clock looks.
 */
export const MEETING_STATE_POLL_INTERVAL_MS = 10_000;

/**
 * How many CONSECUTIVE retryable failures the poll tolerates before it stops.
 *
 * ⚠ MIRRORS `GUESTS_MAX_CONSECUTIVE_POLL_FAILURES` DELIBERATELY. Two polls on the same patchy
 * connection should give up at the same point, not at two arbitrary ones.
 */
export const MEETING_STATE_MAX_CONSECUTIVE_FAILURES = 8;

/** ⚠ Bounds a `Retry-After` the server sent. A poll delay is not an upstream's opinion to trust. */
const MAX_RETRY_AFTER_MS = 300_000;

export interface UseMeetingStatePollInput {
  /**
   * The read. ⚠ It is held in a REF, so it need not be memoised — but a caller that allocates
   * a new closure every render still gets exactly one schedule.
   */
  readonly load: () => Promise<GetMeetingStateResult>;
  /**
   * ⚠ `false` DISABLES THE POLL ENTIRELY — no mount fetch, no schedule, no listener. The
   * member route only mounts the mirror once it holds a grant; before that there is nothing
   * to mirror and a request would 404 on a meeting the viewer has not joined.
   */
  readonly enabled?: boolean;
}

/**
 * WHY the schedule stopped — ⚠⚠ **AND THE TWO ARE NOT INTERCHANGEABLE ON SCREEN.**
 *
 *   · `terminal` — the meeting ENDED. The mirror is complete and correct; there is nothing to
 *     reconnect to and offering a retry would invite somebody to poll a finished call.
 *   · `unreachable` — the failure budget is spent, or the server returned a verdict we cannot
 *     act on. The meeting may well still be running and **the phase on screen is now frozen**,
 *     so this is the one the viewer must be told about.
 */
export type MeetingStatePollStopReason = 'terminal' | 'unreachable';

export interface MeetingStatePollState {
  /**
   * ⚠ `null` UNTIL THE FIRST SUCCESSFUL PARSE — and it SURVIVES a later failure, deliberately.
   * The consumer falls back to the shipped local chrome while this is `null`; it never renders
   * a blank clock because one request was dropped.
   */
  readonly snapshot: MeetingStateSnapshot | null;
  /** `true` once the poll has permanently stopped (terminal status, verdict, or budget spent). */
  readonly isStopped: boolean;
  /** ⚠ `null` while running. See {@link MeetingStatePollStopReason} — the two arms differ. */
  readonly stopReason: MeetingStatePollStopReason | null;
  /**
   * Restart a stopped schedule, once, on an explicit human request.
   *
   * ⚠⚠ **A NO-OP AFTER A `terminal` STOP.** The clocks are frozen against `ended_at` server-side;
   * re-reading them forever would spend a request every ten seconds to confirm an answer that
   * cannot change. Everything else — a spent budget, a refusal — is retryable by a person who
   * can see that the screen has stalled.
   */
  readonly retry: () => void;
}

function isDocumentVisible(): boolean {
  return globalThis.document?.visibilityState !== 'hidden';
}

/** ⚠ `ended` / `cancelled` are the two TERMINAL labels. Both stop the schedule for good. */
function isTerminal(snapshot: MeetingStateSnapshot | null): boolean {
  return snapshot?.status === 'ended' || snapshot?.status === 'cancelled';
}

export function useMeetingStatePoll({
  load,
  enabled = true,
}: UseMeetingStatePollInput): MeetingStatePollState {
  const [snapshot, setSnapshot] = useState<MeetingStateSnapshot | null>(null);
  const [stopReason, setStopReason] = useState<MeetingStatePollStopReason | null>(null);

  const loadRef = useRef(load);
  const failureCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const stoppedRef = useRef(false);
  /** ⚠ A VERDICT OUTLIVES AN `enabled` TOGGLE and outlives a retry. Held in a ref for both. */
  const isTerminalRef = useRef(false);
  const tickRef = useRef<() => void>(() => {});

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * ⚠ THE REASON IS RECORDED, NOT JUST THE FACT. A stop used to be an unlabelled boolean that
   * the only consumer then discarded, so a poll that gave up after eight failures froze the
   * phase on screen and told nobody — an expert would simply never reach "you're free to leave".
   */
  const stop = useCallback(
    (reason: MeetingStatePollStopReason): void => {
      stoppedRef.current = true;
      if (reason === 'terminal') isTerminalRef.current = true;
      clearTimer();
      if (isMountedRef.current) setStopReason(reason);
    },
    [clearTimer]
  );

  const schedule = useCallback(
    (delayMs: number): void => {
      clearTimer();
      if (stoppedRef.current || !isDocumentVisible()) return;
      timerRef.current = setTimeout(() => tickRef.current(), delayMs);
    },
    [clearTimer]
  );

  /** Spend one life, then either re-arm or give up. ⚠ The ONE place the budget is decremented. */
  const spendFailure = useCallback(
    (delayMs: number): void => {
      failureCountRef.current += 1;
      if (failureCountRef.current >= MEETING_STATE_MAX_CONSECUTIVE_FAILURES) {
        // ⚠ THE LAST KNOWN SNAPSHOT STAYS ON SCREEN. Giving up on the schedule is not the same
        // as declaring the call over — which is exactly why the consumer is told.
        stop('unreachable');
        return;
      }
      schedule(delayMs);
    },
    [schedule, stop]
  );

  const tick = useCallback((): void => {
    // ⚠ DELIBERATELY NOT `void`-PREFIXED: this repo does not enable type-aware linting so
    // `no-floating-promises` never fires, and SonarCloud S3735 flags the operator on a new-code
    // line. The position `call-client.tsx` and `use-admission-poll.ts` already state by name.
    loadRef
      .current()
      .then((result) => {
        if (!isMountedRef.current || stoppedRef.current) return;

        if (result.success) {
          failureCountRef.current = 0;
          const parsed = parseMeetingState(result.state);
          if (parsed !== null) {
            setSnapshot(parsed);
            if (isTerminal(parsed)) {
              // ⚠ A VERDICT. The clocks are frozen against `ended_at` server-side; there is
              // nothing further to mirror.
              stop('terminal');
              return;
            }
          }
          // ⚠ AN UNPARSEABLE BODY IS NOT A TRANSPORT FAILURE AND DOES NOT SPEND A LIFE — it
          // keeps the last good snapshot and tries again on the next tick. A shape change is a
          // deploy-shaped problem, not a connectivity one, and blanking a live call's chrome
          // over it would be the louder of the two wrong answers.
          schedule(MEETING_STATE_POLL_INTERVAL_MS);
          return;
        }

        if (!result.retryable) {
          // ⚠ A `404` is an answer, not a blip. Eight retries would be eight requests spent
          // confirming something already known — but the viewer is still told, because the
          // phase on their screen has just stopped advancing.
          stop('unreachable');
          return;
        }

        const retryAfterMs =
          result.retryAfterSeconds === undefined
            ? MEETING_STATE_POLL_INTERVAL_MS
            : Math.min(result.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS);
        spendFailure(retryAfterMs);
      })
      .catch(() => {
        /*
          ⚠⚠ **THE TRANSPORT ARM — AND WITHOUT IT THE POLL DIED SILENTLY AND PERMANENTLY.**

          A Server Action can REJECT before any server answers: a dropped connection, an HTML
          error page where JSON was expected, a deployment-ID mismatch after a redeploy —
          `call-client.tsx`'s own join `.catch` documents exactly this class. With no handler the
          rejection escaped as an unhandled promise, the timer was never re-armed, ZERO of the
          eight advertised failure lives were spent, and `stopReason` stayed `null` so nothing
          downstream could tell.

          ⚠ AND A DEAD POLL DOES NOT FREEZE THE CHIP — IT EXTRAPOLATES. `MeetingClockSlot`
          interpolates `baseMs + (Date.now() - asOf)` every second, so an expert would have
          watched an ever-growing "counted" duration with no server correction, forever.

          It spends a life exactly like an `ok: false`, so the budget and the stop are the same
          for both kinds of not-getting-an-answer.
        */
        if (!isMountedRef.current || stoppedRef.current) return;
        spendFailure(MEETING_STATE_POLL_INTERVAL_MS);
      });
  }, [schedule, spendFailure, stop]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  /**
   * Restart a schedule that gave up. ⚠ A NO-OP AFTER A TERMINAL STOP — see {@link retry}'s doc
   * on `MeetingStatePollState`.
   */
  const retry = useCallback((): void => {
    if (isTerminalRef.current || !isMountedRef.current) return;
    stoppedRef.current = false;
    failureCountRef.current = 0;
    setStopReason(null);
    tickRef.current();
  }, []);

  /** Mount: one immediate read, then the schedule. */
  useEffect(() => {
    if (!enabled) return;
    isMountedRef.current = true;
    // ⚠⚠ A VERDICT SURVIVES AN `enabled` TOGGLE. Re-enabling must not restart a poll on a
    // meeting the server already told us is over.
    if (isTerminalRef.current) return;
    stoppedRef.current = false;
    failureCountRef.current = 0;
    // ⚠ THE STATE IS RESET TOO, NOT JUST THE REF. `stoppedRef` was cleared here while
    // `isStopped` was left `true`, so a re-enabled poll ran while every consumer still read it
    // as stopped — a stale "reconnecting" notice over a perfectly healthy schedule.
    setStopReason(null);
    tickRef.current();
    return () => {
      isMountedRef.current = false;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    // ⚠ THE DEPENDENCY LIST IS `[enabled]` AND THAT IS THE POINT. `tickRef` keeps the latest
    // closure reachable, so re-running this on every `tick` identity change would restart the
    // schedule on every render — the thundering herd the cadence exists to avoid. It reads
    // only refs, so there is nothing stale to capture.
  }, [enabled]);

  /** ⚠ PAUSE WHEN HIDDEN; RESUME WITH AN IMMEDIATE FETCH, not with a delay. */
  useEffect(() => {
    if (!enabled) return;
    const onVisibilityChange = (): void => {
      if (stoppedRef.current) return;
      if (!isDocumentVisible()) {
        clearTimer();
        return;
      }
      tickRef.current();
    };
    globalThis.document?.addEventListener('visibilitychange', onVisibilityChange);
    return () => globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange);
  }, [clearTimer, enabled]);

  return { snapshot, isStopped: stopReason !== null, stopReason, retry };
}
