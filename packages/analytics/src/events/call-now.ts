/**
 * BAL-649 / ADR-1058 — Call now analytics.
 *
 * SERVER-ONLY. The ring's terminal compare-and-set runs in `apps/api`, and the outcome is a
 * fact the server decided; no browser code emits it. It MUST NOT be added to `AllEvents` (the
 * client union) or to the `apps/web/src/test/setup.mocks.ts` client analytics mock.
 *
 * ⚠ REGISTRATION IS FIVE FILES: this one, `events/index.ts`, `types.ts` (`ServerEvents`),
 * `server/index.ts` (`apps/api` imports from `@balo/analytics/server` ONLY), and the guard test.
 *
 * ⚠ NO PII. Ids, one closed enum per dimension and a duration — no names, no company, no
 * address. `distinct_id` is the CALLER's user id.
 */

import type { CallRingPlacement, CallRingReach, CallSide } from '@balo/shared/meetings';

export const CALL_NOW_SERVER_EVENTS = {
  /**
   * A ring reached a terminal status. Fires ONCE per ring, from the ring's terminal
   * compare-and-set, never from a CAS that lost its race.
   */
  RING_ENDED: 'call_now_ring_ended',
} as const;

/** `call_now_ring_ended.outcome`. An unanswered ring is reported as `no_answer`. */
export type CallNowRingOutcome = 'connected' | 'no_answer' | 'declined' | 'stopped';

export interface CallNowServerEventMap {
  [CALL_NOW_SERVER_EVENTS.RING_ENDED]: {
    outcome: CallNowRingOutcome;
    /** Whole seconds from the ring starting to its terminal status. */
    ring_seconds: number;
    /** The side that placed the call. */
    caller_lens: CallSide;
    /** How the callee was reached. Always `app` until BAL-652 adds SMS. */
    reached_by: CallRingReach;
    placement: CallRingPlacement;
    meeting_id: string;
    /** The CALLER's user id. */
    distinct_id: string;
  };
}
