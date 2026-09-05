// ⚠⚠ BAL-466 (F5, review fix round) — NO `'use server'` HERE, DELIBERATELY. That directive makes
// EVERY export in a file directly callable from the browser — this module's residual predicate
// (live member of `credit_sessions.company_id`) is weaker than the composed gate
// (`resolveInCallDrawdown` → `authorizeMeetingParticipation`), so a direct Server Action call
// would let any co-member of the session's company read the funding state of a call they have
// no participation in, bypassing the participation gate entirely. The only non-test importer is
// `resolve-in-call-drawdown.ts`, itself `server-only` — there is no legitimate reason for a
// browser to reach this function directly. Do NOT re-add this directive "for symmetry" with
// `session-mutations.ts` — that file's actions are genuinely meant to be browser-callable.
import 'server-only';

import {
  creditSessionsRepository,
  creditWalletsRepository,
  partyMembershipsRepository,
} from '@balo/db';
import {
  deriveDrawdownState,
  walletAllowsOverdraftGrace,
  type DrawdownState,
} from '@balo/shared/credit';
import { MIN_MEETING_MINUTES } from '@balo/shared/meetings';
import { getCurrentUser } from '@/lib/auth/session';
import { roleHasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';

/**
 * BAL-378 (ADR-1040 Lane 2) — the web-side read of the `DrawdownState` for the
 * in-session components. Server-only: it reads `@balo/db`, so it must never reach a
 * client bundle (the components consume the pure `@balo/shared/credit` type only).
 *
 * Mirrors the api's `services/credit-session/drawdown.ts` so the web and the
 * `GET /sessions/:id/drawdown-state` route project an IDENTICAL state:
 *  - the session comes through the CLIENT projection (`findForClientView`), so
 *    `expertRate*` / `baloFeeBps` / `expertAccruedMinor` / `stripePaymentIntentId`
 *    are structurally absent (the fee/PII boundary — these credit tables carry no RLS);
 *  - the full wallet row is read SERVER-SIDE only to compute the `graceAvailable`
 *    boolean (BAL-523: `walletAllowsOverdraftGrace`); no mandate secret ever enters the
 *    returned `DrawdownState`;
 *  - MEMBERSHIP gates the read — a viewer who is NOT a live member of the session's
 *    company gets `null` (deny), never a leaked wallet balance / billing-admin name;
 *  - `lens = MANAGE_BILLING ? 'client' : 'member'`, chosen ONLY after membership holds.
 */

/**
 * Assemble the `DrawdownState` for a session + the current viewer.
 *
 * ⚠⚠ BAL-466 (D9.1) — `userId` IS REQUIRED, AND IT IS ASSERTED AGAINST THE DERIVED VIEWER,
 * NOT TRUSTED. This is belt-and-braces defence in depth, not the primary control: since F5
 * removed `'use server'` from this module (see the top-of-file note), it is no longer directly
 * browser-callable at all — its only caller is `resolve-in-call-drawdown.ts`, `server-only`
 * itself. This assertion still matters because a future in-process caller could pass a
 * different id than the one it authorized. `resolveInCallDrawdown` authorizes actor A on the
 * participation axis and then reads here — before this parameter existed, a future caller
 * passing a different id would have authorized A and returned B's state. Now that is a denial.
 *
 * ⚠ IT ALSO ALIGNS THE WEB MIRROR WITH ITS API TWIN, `services/credit-session/drawdown.ts`'s
 * `getSessionDrawdownState(sessionId, userId, now)`. The two same-named functions now take the
 * same arguments.
 *
 * Returns `null` when the viewer is not signed in, the requested `userId` does not match the
 * derived viewer, or the session / its wallet is not found, so the caller can render the
 * error state.
 */
export async function getSessionDrawdownState(
  sessionId: string,
  userId: string,
  now: Date = new Date()
): Promise<DrawdownState | null> {
  const viewer = await getCurrentUser();
  if (viewer === null) {
    return null;
  }
  if (viewer.id !== userId) {
    // ⚠ `error`, not `warn`: the only ways to get here are a coding mistake in a caller or a
    // direct Server-Action invocation with a forged subject. Both are worth an alert.
    log.error('Drawdown read refused — the authorized actor is not the session viewer', {
      sessionId,
      requestedUserId: userId,
      viewerId: viewer.id,
    });
    return null;
  }

  const session = await creditSessionsRepository.findForClientView(sessionId);
  if (session === undefined) {
    return null;
  }

  const wallet = await creditWalletsRepository.findById(session.walletId);
  if (wallet === undefined) {
    return null;
  }

  // Membership GATES the read: this action reads `@balo/db` directly (not via the gated api),
  // so a non-member of the session's company must be denied here, not silently handed a member
  // lens. The web authz seam only exposes a boolean `hasCapability`; resolve the live role
  // directly so "no membership" is distinguishable from "member without MANAGE_BILLING".
  const role = await partyMembershipsRepository.getMemberRole(
    'company',
    session.companyId,
    viewer.id
  );
  if (role === undefined) {
    return null;
  }
  const lens: 'client' | 'member' = roleHasCapability(role, CAPABILITIES.MANAGE_BILLING)
    ? 'client'
    : 'member';
  const adminName =
    lens === 'member'
      ? await partyMembershipsRepository.resolveBillingAdminName(session.companyId)
      : undefined;

  return deriveDrawdownState({
    status: session.status,
    connectedAt: session.connectedAt,
    clientRateMinorPerMinute: session.clientRateMinorPerMinute,
    effectiveCeilingMinor: session.effectiveCeilingMinor,
    graceBoundMinutes: session.graceBoundMinutes,
    graceEnteredAt: session.graceEnteredAt,
    balanceMinor: wallet.balanceMinor,
    // BAL-412 (D5, Q5) / BAL-466 — ⚠ THE ONE NAMED DIVERGENCE, AND IT IS NOW REACHABLE. This
    // web mirror uses the SHIPPED default `MIN_MEETING_MINUTES` rather than the env-resolved
    // floor, because the env reader (`resolveBillingFloorMinutes`, `apps/api/src/config/
    // billing-floor.ts`) lives in `apps/api` ALONE (ADR-1049 D8) and `@balo/shared/meetings` is
    // deliberately client-reachable (no `process.env` there).
    //
    // ⚠ WHAT IT COSTS: if a deployment sets `MEETING_NO_SHOW_FLOOR_MINUTES`, the in-call
    // panel's `minutesOfRunway` ESTIMATE drifts from the api's by the override delta. The
    // CHARGE does not: settlement is computed api-side by `resolveMeetingSettlement` with the
    // real floor. This is a display divergence, never a money one.
    // ⚠ SO: do NOT set that env var while this mirror exists, and do NOT mirror it into Vercel.
    // Routing this read through the gated api instead of a direct `@balo/db` read is the real
    // fix and is a follow-up ticket — it is NOT done here, because it would give the in-call
    // surface a second gate and re-open the round-2 disagreement `resolveInCallDrawdown` exists
    // to prevent.
    billingFloorMinutes: MIN_MEETING_MINUTES,
    minutesAlreadyDrawn: session.connectedMinutes,
    graceAvailable: walletAllowsOverdraftGrace(wallet),
    lens,
    ...(adminName === undefined ? {} : { adminName }),
    now,
  });
}
