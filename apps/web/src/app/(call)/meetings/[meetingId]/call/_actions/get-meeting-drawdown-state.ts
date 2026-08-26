'use server';

import 'server-only';

import { z } from 'zod';
import { requireUser } from '@/lib/auth/session';
import { resolveInCallDrawdown } from '@/lib/credit/resolve-in-call-drawdown';
import { log } from '@/lib/logging';
import { callActionErrorFields, enterCallAction } from '@/lib/meetings/call-action-entry';
import type { GetMeetingDrawdownResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z.object({ meetingId: z.uuid() }).strict();

/**
 * BAL-403 — read the in-call BALANCE panel's `DrawdownState`. The **only** read the poll calls.
 *
 * ⚠⚠ **GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY.** Bare `requireUser()` (via the thunk
 * form — see below) plus an entry on `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`: it writes
 * nothing, anywhere, transitively. `onboarding-mutation-gate.test.ts` fails the build without
 * that entry. The participation gate and the membership + capability read both run inside
 * `resolveInCallDrawdown` — same posture as `get-meeting-guests.ts` / `get-meeting-state.ts`.
 *
 * ⚠ THE THUNK FORM IS LOAD-BEARING: `enterCallAction(() => requireUser(), …)`, never
 * `enterCallAction(requireUser, …)`. See `call-action-entry.ts`'s docblock — a bare value
 * reference would drop this file out of `onboarding-mutation-gate.test.ts`'s `bareRequireUser`
 * scan set, silencing the very invariant that allowlists it.
 *
 * ── ⚠⚠ FIX ROUND 2 (R1) — THIS BODY IS NOW ONE CALL TO THE SHARED GATE ────────────────────────
 *
 * `resolveInCallDrawdown` (`@/lib/credit/resolve-in-call-drawdown`) is the SAME function
 * `page.tsx`'s `resolveBalanceSlot` calls to decide whether the Balance slot is even
 * REGISTERED. Round 1 shipped two different compositions — this action ran a participation gate
 * the RSC did not — and the two could disagree: the toolbar button would render while every poll
 * answered the inert arm below, opening onto a permanent empty skeleton. See that module's
 * docblock for the full incident. BAL-466 (D3, D8) changed WHICH gate that is —
 * `authorizeMeetingParticipation`, the real participation resolver, not the company-audience
 * gate this file used to name — and reordered it to run FIRST.
 *
 * ── ⚠⚠ BAL-466 — "NO CREDIT SESSION FOR THIS MEETING" IS NOW THE ANSWER ONLY FOR A NON-`case`
 *    MEETING, OR A `case` WHOSE CLIENT HAS NOT YET BEEN ADMITTED ────────────────────────────
 *
 * `apps/web`'s `openSessionAction` (`lib/credit/actions/session-mutations.ts`) still has zero
 * non-test callers — the seam is server-side. (`connectSessionAction` no longer exists — F1 of
 * the BAL-466 fix round deleted it; a `'presence'` session connects system-only.)
 * `joinMeetingAsMember` (`apps/api`) opens a `duration_source='presence'` session when the
 * first CLIENT-side member is admitted to a `case` meeting, so `resolveInCallDrawdown` now
 * answers non-null for those meetings once admission has happened. That is a **success**,
 * `{ success: true, state: <DrawdownState> }` — the poll treats a `null` answer as a
 * terminal-but-healthy stop (see `use-drawdown-poll.ts`); this action is also `call-client.tsx`'s
 * post-join RE-RESOLVE, called once when the RSC's verdict was stale `false`.
 *
 * ⚠⚠ **EVERY DENIAL COLLAPSES INTO THE SAME INERT ARM AS ABSENCE.** ADR-1029 requires a denial
 * to be indistinguishable from "does not exist" on the wire. No session, a denied participation
 * check, and a denied membership + capability read all answer `{ success: true, state: null }`;
 * the real reason (which check failed, for whom) goes to `log.warn` INSIDE
 * `resolveInCallDrawdown`, never here and never to the wire.
 *
 * ⚠ `retryable` DISTINGUISHES A TRANSPORT BLIP FROM A VERDICT. Every denial folds into the SAME
 * inert success arm above — the poll stops rather than spending eight requests confirming an
 * answer it already has.
 *
 * ⚠⚠ THE ID THAT REACHES THE BROWSER: `sessionId` rides back on the SUCCESS ARM, never on the
 * registration (`meeting-panels.ts`'s `MeetingBalancePanelActions` stays id-free). It is an
 * opaque UUID that authorizes nothing by itself — `nudgeAdminAction` re-gates it independently
 * with its own IDOR check, and `getSessionDrawdownState` re-gates THIS read on membership.
 */
export async function getMeetingDrawdownStateAction(
  input: unknown
): Promise<GetMeetingDrawdownResult> {
  const entry = await enterCallAction(() => requireUser(), inputSchema, input);
  if (!entry.ok) {
    // ⚠ NO `log.error` HERE — this action is POLLED (every 10-30s for the length of a call), so
    // an expired session would write an error line per tick. Same posture as
    // `get-meeting-guests.ts` / `get-meeting-state.ts`.
    return { success: false, error: entry.error, retryable: false };
  }
  const { meetingId } = entry.data;
  const { id: userId } = entry.user;

  try {
    const result = await resolveInCallDrawdown(meetingId, userId);
    if (result === null) {
      // ⚠⚠ THE INERT / DENIED PATH. See the module docblock — this is a SUCCESS, and every
      // denial (no session, denied participation, denied membership) is indistinguishable here.
      return { success: true, state: null };
    }
    return { success: true, state: result.state, sessionId: result.sessionId };
  } catch (error) {
    // ⚠ A CAUGHT BOUNDARY RETURNING A USER-FACING ERROR — CLAUDE.md's `log.error` rule.
    log.error('Could not read the in-call drawdown state', {
      meetingId,
      ...callActionErrorFields(error),
    });
    return {
      success: false,
      error: 'Could not load your balance right now.',
      retryable: true,
    };
  }
}
