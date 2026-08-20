'use server';

import 'server-only';

import {
  creditSessionsRepository,
  creditWalletsRepository,
  partyMembershipsRepository,
} from '@balo/db';
import {
  deriveDrawdownState,
  isWalletMandateActive,
  type DrawdownState,
} from '@balo/shared/credit';
import { MIN_MEETING_MINUTES } from '@balo/shared/meetings';
import { getCurrentUser } from '@/lib/auth/session';
import { roleHasCapability, CAPABILITIES } from '@/lib/authz';

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
 *  - the full wallet row is read SERVER-SIDE only to compute the `mandatePresent`
 *    boolean; no mandate secret ever enters the returned `DrawdownState`;
 *  - MEMBERSHIP gates the read — a viewer who is NOT a live member of the session's
 *    company gets `null` (deny), never a leaked wallet balance / billing-admin name;
 *  - `lens = MANAGE_BILLING ? 'client' : 'member'`, chosen ONLY after membership holds.
 */

/**
 * Assemble the `DrawdownState` for a session + the current viewer. Returns `null` when
 * the viewer is not signed in, or the session / its wallet is not found, so the caller
 * can render the error state.
 */
export async function getSessionDrawdownState(
  sessionId: string,
  now: Date = new Date()
): Promise<DrawdownState | null> {
  const viewer = await getCurrentUser();
  if (viewer === null) {
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
    // BAL-412 (D5, Q5) — ⚠ THE ONE NAMED DIVERGENCE: this web mirror uses the SHIPPED default
    // `MIN_MEETING_MINUTES` (`@balo/shared/meetings`) rather than the env-resolved floor,
    // because the env reader (`resolveBillingFloorMinutes`, `apps/api/src/config/
    // billing-floor.ts`) lives in `apps/api` ALONE (ADR-1049 D8) and `@balo/shared/meetings` is
    // deliberately client-reachable (no `process.env` there). If a deployment ever sets
    // `MEETING_NO_SHOW_FLOOR_MINUTES`, this mirror and the api route disagree by the override
    // delta. UNREACHABLE TODAY — `openSessionAction` has zero non-test callers, so nothing on
    // the web renders a live drawdown state. BAL-466 is the resolution (route this through the
    // gated api instead of a direct `@balo/db` read). Do NOT mirror the env var into Vercel and
    // do NOT add a money field to this payload (ADR-1050 keeps money structurally absent).
    billingFloorMinutes: MIN_MEETING_MINUTES,
    minutesAlreadyDrawn: session.connectedMinutes,
    mandatePresent: isWalletMandateActive(wallet),
    lens,
    ...(adminName === undefined ? {} : { adminName }),
    now,
  });
}
