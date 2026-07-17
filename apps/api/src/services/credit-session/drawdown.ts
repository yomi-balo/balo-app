/**
 * BAL-378 (ADR-1040 Lane 2) — build the read-only `DrawdownState` projection for the
 * `GET /sessions/:id/drawdown-state` route (and the connect response). Membership GATES the
 * read: a non-member of the session's company gets `undefined` (route → 404), never a leaked
 * live wallet balance or billing-admin name. Only AFTER membership is confirmed does
 * `MANAGE_BILLING` pick the lens (client vs member). No money moves.
 */
import { creditWalletsRepository, partyMembershipsRepository } from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import {
  deriveDrawdownState,
  isWalletMandateActive,
  type DrawdownState,
} from '@balo/shared/credit';
import { authorizeSessionActor } from './authorize-session-actor.js';

/**
 * Assemble the `DrawdownState` for a session + viewer. Returns `undefined` when the session is
 * not found OR the viewer is not a live member of its company (route 404 — deny), or when the
 * session has no live wallet. Membership gates the READ; `lens = MANAGE_BILLING ? client :
 * member` only picks the projection AFTER membership is confirmed.
 */
export async function getSessionDrawdownState(
  sessionId: string,
  viewerUserId: string,
  now: Date = new Date()
): Promise<DrawdownState | undefined> {
  const auth = await authorizeSessionActor({ sessionId, userId: viewerUserId });
  if (!auth.ok) {
    return undefined;
  }
  const { session, role } = auth;

  const wallet = await creditWalletsRepository.findById(session.walletId);
  if (wallet === undefined) {
    return undefined;
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
    mandatePresent: isWalletMandateActive(wallet),
    lens,
    ...(adminName === undefined ? {} : { adminName }),
    now,
  });
}
