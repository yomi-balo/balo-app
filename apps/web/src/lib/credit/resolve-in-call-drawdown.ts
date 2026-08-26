import 'server-only';

import { creditSessionsRepository } from '@balo/db';
import type { DrawdownState } from '@balo/shared/credit';
import { authorizeMeetingParticipation } from '@/lib/authz/meeting-participation';
import { getSessionDrawdownState } from '@/lib/credit/actions/get-drawdown-state';
import { log } from '@/lib/logging';

/**
 * BAL-403 (R1) / BAL-466 (D3, D8) — **THE ONE COMPOSED GATE** for the in-call BALANCE slot.
 * Both ends of the seam call THIS function and nothing else: the RSC's slot boolean
 * (`page.tsx`'s `resolveBalanceSlot`, narrowed to `!== null`) and the polled action's body
 * (`get-meeting-drawdown-state.ts`, forwarded as-is). Registration and body share one verdict
 * and CANNOT disagree by construction — there is exactly one place this can go wrong, and this
 * module is it.
 *
 * ── ⚠⚠ BAL-466 CHANGED THE AXIS: IT IS NOW **PARTICIPATION**, NOT **AUDIENCE** ───────────────
 *
 * Until BAL-466 this composed `authorizeMeetingFileAccess` — the company-AUDIENCE gate — and a
 * member of the owning company with NO connection to THIS specific call passed it. That was a
 * documented, deliberate gap, safe only while the whole surface was inert. BAL-466 replaces the
 * company-audience gate everywhere with `authorizeMeetingParticipation`
 * (`@/lib/authz/meeting-participation`), the `apps/web` wrapper over the ONE participation rule
 * in `@balo/shared/meetings` that `apps/api`'s join, guest and admission surfaces also use.
 * There is no second definition of "participant" on this platform.
 *
 * ⚠⚠ **THE GAP IS NARROWED, NOT CLOSED — AND ONLY ON THE EXPERT ARM.** State this plainly so a
 * future reader does not delete step 3 believing step 1 alone now excludes a stray company
 * member: the CLIENT arm of `authorizeMeetingParticipation` is byte-IDENTICAL in predicate to
 * the audience gate it replaced (live company membership carrying `PARTICIPATE`, resolved
 * through `roleHasCapability` — never a `role ===`), and step 3 below checks the SAME company.
 * Under today's data model, participation and membership genuinely COINCIDE for a client-side
 * actor — there is no per-meeting client-participant record to narrow against — so "a member of
 * the owning company with no connection to this specific call" is STILL possible on the client
 * side; it is exactly what step 3's `credit_sessions.company_id` re-check (D10, below) exists to
 * make harmless rather than to prevent. Only the EXPERT arm genuinely narrowed: the engagement
 * axis's `manage_engagement` holder set instead of `actorHasExpertSideVisibility`'s wider "any
 * live agency member". Nobody who was denied before is authorized now (the change is a strict
 * narrowing, never a widening) — but a true per-meeting CLIENT-participant gate needs BAL-408's
 * participation model, which does not exist yet.
 *
 * Composes, IN ORDER:
 *   1. `authorizeMeetingParticipation` — is this actor a participant of THIS meeting.
 *   2. `creditSessionsRepository.findIdByMeetingId` — does a credit session exist. Projected to
 *      `id` alone; already filters `status <> 'cancelled'` and `deleted_at IS NULL`, so a
 *      cancelled or soft-deleted session correctly yields `null` too.
 *   3. `getSessionDrawdownState` — the membership + capability read that assembles the state.
 *
 * ── ⚠⚠ STEP 3 IS LOAD-BEARING AND IS **NOT** REDUNDANT WITH STEP 1 (D10) ─────────────────────
 *
 * `getSessionDrawdownState` reads `credit_sessions.company_id` — an INDEPENDENT FK column, not
 * derived from the meeting's context — and requires LIVE MEMBERSHIP of THAT company
 * (`get-drawdown-state.ts:64-71`). That read is what EXCLUDES EVERY EXPERT-SIDE ACTOR: the
 * expert arm of step 1 passes on its own, but a delivering expert (independent or agency) is
 * never a member of the client company that owns the credit session. Remove it as "redundant"
 * and the expert arm becomes a live read path onto the client company's wallet balance and its
 * billing-admin's name. The true composed predicate is:
 *
 *   participant of this meeting **AND** live member of `credit_sessions.company_id`.
 *
 * ── ⚠⚠ BAL-466 (D8) — THE R8 TIMING ORACLE IS CLOSED BY ORDERING ─────────────────────────────
 *
 * Round 2 documented but did not close it: "no session" returned after ONE indexed select while
 * "session exists but denied" returned after ~4-11, so the two collapsed `null`s were
 * distinguishable BY TIMING on a polled endpoint that any authenticated user can call with any
 * `meetingId`. Authorization now runs FIRST, so **an actor who is not a participant never reads
 * `credit_sessions` at all** — zero reads, not merely a constant number. Session existence is
 * no longer observable to anyone outside the call.
 *
 * ⚠ THE COST: the participation gate now runs even for a meeting with no session. It is paid
 * ONCE PER RSC RENDER and once per post-join probe, never per poll — the poll only runs when
 * the slot is registered, and the slot is registered only when this function already returned
 * non-null.
 *
 * ⚠ TWO RESIDUALS, STATED RATHER THAN IMPLIED. (1) The gate's own cost varies with the
 * meeting's CONTEXT TYPE (3 reads engagement-grain, 4 for `request_interaction`) — a fact about
 * the meeting, true of every gate on this platform, not about the money. (2) A PARTICIPANT who
 * is denied at step 3 — in practice the delivering expert side — can still infer that a session
 * exists. Accepted: an expert delivering a Case consultation already knows it is metered
 * (ADR-1050), and no money field is reachable either way.
 *
 * ── ⚠ `userId` MUST BE THE SESSION USER — NOW ENFORCED, NOT ASSUMED ─────────────────────────
 *
 * `getSessionDrawdownState` takes `userId` as of BAL-466 (D9.1) and ASSERTS it matches the
 * viewer it derives itself. A caller passing some OTHER user's id is denied rather than
 * silently authorizing actor A and returning actor B's state.
 *
 * Every denial along the way — not a participant, no session, not a live member of the
 * session's company, or the session/wallet vanishing between reads — collapses into the SAME
 * `null`. ADR-1029 requires a denial to be indistinguishable from "does not exist" on the wire;
 * the real reason goes to `log.warn` HERE (this module owns the logging for both callers),
 * never to either caller's return value.
 */
export interface InCallDrawdown {
  readonly sessionId: string;
  readonly state: DrawdownState;
}

export async function resolveInCallDrawdown(
  meetingId: string,
  userId: string
): Promise<InCallDrawdown | null> {
  // 1. ⚠⚠ AUTHORIZATION FIRST (D8). Nothing below this line runs for a non-participant, which
  //    is what makes session existence unobservable to them.
  const access = await authorizeMeetingParticipation({ meetingId, userId });
  if (!access.ok) {
    // ⚠ NO `sessionId` IN THIS LINE — we have not looked, and must not.
    log.warn('Drawdown read refused — not a participant of this meeting', { meetingId, userId });
    return null;
  }

  // 2. Does a credit session exist for this meeting at all.
  //    ⚠ `findIdByMeetingId` RETURNS `{ id: string } | undefined`, NOT a bare string.
  const row = await creditSessionsRepository.findIdByMeetingId(meetingId);
  if (row === undefined) {
    // Not an error: a meeting with no money (an intro call, a discovery call, or a Case whose
    // client has not been admitted yet) is a SUCCESSFUL `null`.
    return null;
  }

  // 3. ⚠⚠ THE `credit_sessions.company_id` MEMBERSHIP READ. See the docblock — this is what
  //    denies every expert-side actor, and it is NOT redundant with step 1.
  //
  //    ⚠⚠ G2 (second review round) — `log.info`, NOT `log.warn`. On a live Case this denial is
  //    the EXPECTED, BY-DESIGN outcome (D10) for the delivering expert — the docblock above
  //    calls it exactly that — and `resolveBalanceSlot` runs this composed gate on every
  //    call-page render, so a `warn` here fires once per render for a path this module already
  //    documents as normal. Keep the log (an anomaly here would still want a paper trail); just
  //    don't alarm on it.
  const state = await getSessionDrawdownState(row.id, userId);
  if (state === null) {
    log.info('Drawdown read denied — not a live member of the billed company', {
      meetingId,
      sessionId: row.id,
    });
    return null;
  }

  return { sessionId: row.id, state };
}
