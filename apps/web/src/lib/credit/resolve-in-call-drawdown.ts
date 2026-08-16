import 'server-only';

import { creditSessionsRepository } from '@balo/db';
import type { DrawdownState } from '@balo/shared/credit';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { getSessionDrawdownState } from '@/lib/credit/actions/get-drawdown-state';
import { log } from '@/lib/logging';

/**
 * BAL-403 fix round 2 (R1) — **THE ONE COMPOSED GATE** for the in-call BALANCE slot. Both ends
 * of the seam call THIS function and nothing else:
 *
 *   · the RSC's slot boolean — `page.tsx`'s `resolveBalanceSlot` — narrows the result to
 *     `!== null`;
 *   · the polled action's body — `get-meeting-drawdown-state.ts` — forwards the result as-is.
 *
 * ── ⚠⚠ WHY THIS EXISTS: ROUND 1 PUT TWO DIFFERENT GATES ON THE TWO ENDS OF ONE SEAM ────────────
 *
 * The RSC ran `findIdByMeetingId → getSessionDrawdownState`; the action ran `findIdByMeetingId →
 * authorizeMeetingFileAccess → getSessionDrawdownState`. The RSC was strictly weaker by exactly
 * the `authorizeMeetingFileAccess` term, which ALSO denies on `no_context` / `ambiguous_context`
 * / `subject_unresolvable` / `no_capability` — none of which the RSC asked. When the two
 * disagreed, the toolbar button rendered (the slot said `true`) while every poll answered
 * `{ success: true, state: null }` (the action said denied) — the panel opened onto an eternal,
 * empty skeleton with no error and no retry. Registration and body now share one verdict and
 * CANNOT disagree by construction: there is exactly one place this can go wrong, and this module
 * is it.
 *
 * Composes, IN ORDER:
 *   1. `creditSessionsRepository.findIdByMeetingId` — does a credit session exist for this
 *      meeting at all. Projected to `id` alone; already filters `status != 'cancelled'` and
 *      `deletedAt IS NULL`, so a cancelled or soft-deleted session correctly yields `null` too.
 *   2. `authorizeMeetingFileAccess` — the audience check below.
 *   3. `getSessionDrawdownState` — the membership + capability read that assembles the state.
 *
 * Every denial along the way — no session, denied audience, not a live company member, or the
 * session/wallet vanishing in the gap between reads — collapses into the SAME `null` return.
 * ADR-1029 requires a denial to be indistinguishable from "does not exist" on the wire; the real
 * reason goes to `log.warn` HERE (this module owns the logging for both callers), never to
 * either caller's return value.
 *
 * ── ⚠⚠ FIX ROUND 2 — THE W6 AXIS IS **AUDIENCE**, NOT **PARTICIPATION** ─────────────────────────
 *
 * Round 1's docblock claimed `authorizeMeetingFileAccess` closed "a member with no connection to
 * THIS meeting could pass any meetingId". It does not, and a wrong comment is worse than none.
 *
 * `authorizeMeetingFileAccess` composes TWO arms on the meeting's PRIMARY-CONTEXT OWNING
 * COMPANY, and this gate depends on BOTH — round 2's version named only the first:
 *
 *   · CLIENT ARM — `getMemberRole('company', companyId, userId)`, GATED ON
 *     `roleHasCapability(companyRole, CAPABILITIES.PARTICIPATE)` (`authorize-meeting-file-
 *     access.ts:348-353`), not a bare existence check. Today all three company roles
 *     (owner/admin/member) carry `PARTICIPATE`, so the holder set is identical to "any live
 *     company member" — but the check itself is capability-gated, and describing it as bare
 *     existence reads as an ADR-1029 violation it is not.
 *   · EXPERT ARM — reached only when the actor holds no company membership at all:
 *     `actorIsOnExpertSide` for the delivering expert or ANY live member of their agency
 *     (including agency role `expert`), minus the request-grain decline gate
 *     (`authorize-meeting-file-access.ts:364-378`). This is the SAME expert-side visibility
 *     rule BAL-419 centralized (`actorHasExpertSideVisibility`) — it grants to actors who
 *     normally hold no company membership at all, so it is not a special case of the client
 *     arm above; it is a second, independent way to pass step 2.
 *
 * Passing EITHER arm is not sufficient on its own. `getSessionDrawdownState` (step 3) THEN reads
 * `credit_sessions.company_id` — an independent FK column, not derived from the meeting's
 * context — and requires LIVE MEMBERSHIP of THAT company. So the true composed predicate is:
 *
 *   (live company member with PARTICIPATE ∨ expert-side visibility, minus request-grain
 *   declines) **AND** live membership of `credit_sessions.company_id`.
 *
 * That second membership read is what EXCLUDES expert-side actors from this gate — the expert
 * arm above passes step 2 on its own, but an expert (independent or agency) is never a member of
 * the client company that owns the credit session, so step 3 denies them. This is LOAD-BEARING,
 * not belt-and-braces: remove the `credit_sessions.company_id` read as "redundant" with the step
 * 2 check and the expert arm becomes a live read path onto the client company's wallet balance
 * and billing-admin name.
 *
 * In the ordinary case the client arm's company and the credit session's company are the same
 * one, and the composed check reduces to "is this actor a live member of the company running the
 * call" — which is AUDIENCE, not participation. A company member who is not admitted to, not
 * present in, and has no connection to THIS specific call still passes. The real PARTICIPATION
 * resolver (`authorizeMeetingParticipation`, `apps/api`) is NOT ported here — that is its own
 * piece of work, tracked separately, out of scope for this ticket. The residual exposure is
 * intra-tenant only (a member of company X reading company X's own call's funding state), and
 * the whole surface ships INERT — nothing opens a credit session yet (see `meeting-panels.ts`'s
 * `MeetingPanelId` docblock) — so nothing is reachable until the session-open ticket lands.
 *
 * Do NOT invent a participation gate here to "finish" this. That was considered and explicitly
 * rejected for this round: the real resolver lives in a different app and porting it is
 * out-of-scope work, not a one-line fix.
 *
 * ── ⚠ `userId` MUST BE THE SESSION USER ─────────────────────────────────────────────────────────
 *
 * This function takes `userId` for the audience check (steps 2–3), but `getSessionDrawdownState`
 * (step 3) does NOT thread it through — it re-derives the viewer itself via `getCurrentUser()`.
 * Both current callers (`page.tsx`'s slot resolver, `get-meeting-drawdown-state.ts`'s polled
 * action) pass the session's own user id for `userId`, so the two agree. A future caller passing
 * some OTHER user's id would authorize actor A (via `userId`) but read and return actor B's
 * (the session user's) drawdown state — audit and authorize against the same identity you read.
 *
 * ── ⚠ FIX ROUND 2 (R8) — A RESIDUAL TIMING ORACLE, DOCUMENTED, NOT CLOSED ───────────────────────
 *
 * "No session" returns after one indexed select (step 1 alone). "Session exists but denied"
 * returns after up to ~5 reads (this module's own two steps plus `getSessionDrawdownState`'s
 * three). The two collapsed wire shapes are therefore still distinguishable BY TIMING on a
 * polled endpoint. Closing this means reordering the reads behind a constant-time envelope;
 * that is not built here — noted so the next person does not assume the collapse is airtight.
 */
export interface InCallDrawdown {
  readonly sessionId: string;
  readonly state: DrawdownState;
}

export async function resolveInCallDrawdown(
  meetingId: string,
  userId: string
): Promise<InCallDrawdown | null> {
  // ⚠ `findIdByMeetingId` RETURNS `{ id: string } | undefined`, NOT a bare string.
  const row = await creditSessionsRepository.findIdByMeetingId(meetingId);
  if (row === undefined) {
    // ⚠⚠ THE INERT PATH. See the module docblock — this is the expected answer for every
    // meeting today, and it is a SUCCESS (`null`), never an error.
    return null;
  }

  // ⚠⚠ THE AUDIENCE CHECK — see the module docblock for exactly what this does and does not
  // enforce. Resolved AFTER existence so the (today: always) inert path above pays no extra
  // read at all.
  const access = await authorizeMeetingFileAccess({ meetingId, userId });
  if (!access.ok) {
    log.warn('Drawdown read refused — not in the audience for this meeting', {
      meetingId,
      sessionId: row.id,
    });
    return null;
  }

  const state = await getSessionDrawdownState(row.id);
  if (state === null) {
    // Denied (not a live company member) or the session/wallet vanished between the id lookup
    // and this read.
    log.warn('Drawdown read denied — not a live company member', {
      meetingId,
      sessionId: row.id,
    });
    return null;
  }

  return { sessionId: row.id, state };
}
