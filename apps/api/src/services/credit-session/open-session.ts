/**
 * BAL-378 (ADR-1040 Lane 2) — `openSession`: resolve the acting member's company + wallet,
 * gate CONSUME_CREDITS (company-scoped, fail-closed), then delegate to the repo's atomic
 * gate+hold+create-pending primitive. Thin — all money/rate logic lives in `@balo/db`.
 */
import {
  creditSessionsRepository,
  creditWalletsRepository,
  partyMembershipsRepository,
  usersRepository,
} from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import type { OpenSessionServiceInput, OpenSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/**
 * Resolve the acting user's PRIMARY company (the load-bearing `findWithCompany` seam orders
 * owner→admin→member, then joinedAt). No live-call / company-picker flow exists yet (Booking
 * is future work), so a Case draws down the member's primary company wallet. A user with zero
 * company memberships → `undefined` → the gate fails closed.
 */
async function resolvePrimaryCompanyId(userId: string): Promise<string | undefined> {
  const user = await usersRepository.findWithCompany(userId);
  const [membership] = user?.companyMemberships ?? [];
  return membership?.company?.id;
}

export async function openSession(
  input: OpenSessionServiceInput
): Promise<OpenSessionServiceResult> {
  const { initiatingMemberId, expertProfileId, estimatedMinutes } = input;

  // 1. Resolve the acting member's company.
  const companyId = await resolvePrimaryCompanyId(initiatingMemberId);
  if (companyId === undefined) {
    log.info({ userId: initiatingMemberId }, 'openSession denied — no company membership');
    return { ok: false, code: 'forbidden' };
  }

  // 2. Capability gate — CONSUME_CREDITS, company-scoped, fail-closed for non-members.
  const role = await partyMembershipsRepository.getMemberRole(
    'company',
    companyId,
    initiatingMemberId
  );
  if (role === undefined || !roleHasCapability(role, CAPABILITIES.CONSUME_CREDITS)) {
    log.warn(
      { userId: initiatingMemberId, companyId },
      'openSession denied — missing CONSUME_CREDITS'
    );
    return { ok: false, code: 'forbidden' };
  }

  // 3. Resolve the company wallet (one-per-company; provisioned in BAL-376).
  const wallet = await creditWalletsRepository.findByCompanyId(companyId);
  if (wallet === undefined) {
    log.error({ companyId }, 'openSession — company has no credit wallet');
    return { ok: false, code: 'wallet_missing' };
  }

  // 4. Delegate to the atomic gate + hold + create-pending primitive.
  const result = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId,
    expertProfileId,
    initiatingMemberId,
    estimatedMinutes,
  });

  if (!result.ok) {
    log.info({ companyId, walletId: wallet.id, code: result.code }, 'openSession gate rejected');
    return { ok: false, code: result.code };
  }

  log.info(
    { sessionId: result.session.id, companyId, walletId: wallet.id, estimatedMinutes },
    'Session opened (pending)'
  );
  return {
    ok: true,
    sessionId: result.session.id,
    status: 'pending',
    holdId: result.session.holdId,
  };
}
