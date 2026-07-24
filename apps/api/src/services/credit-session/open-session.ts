/**
 * BAL-378 (ADR-1040 Lane 2) — `openSession`: resolve the acting member's billing company + wallet,
 * gate CONSUME_CREDITS (company-scoped, fail-closed), then delegate to the repo's atomic
 * gate+hold+create-pending primitive. Thin — all money/rate logic lives in `@balo/db`.
 *
 * BAL-401 — removes the silent "first membership" inference: the service builds the member's
 * ELIGIBLE billing-company set (memberships holding CONSUME_CREDITS) and either honours an explicit
 * (capability-gated) `companyId`, auto-selects the single eligible company, or returns
 * `company_selection_required` when more than one is eligible and none was chosen.
 */
import { creditSessionsRepository, creditWalletsRepository, usersRepository } from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import type { EligibleCompany } from '@balo/shared/credit';
import type { OpenSessionServiceInput, OpenSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/**
 * The acting member's CONSUME_CREDITS-eligible billing companies, projected narrow
 * ({id,name,logoUrl}) from their LIVE company memberships. Reuses `findWithCompany`
 * (deterministic, soft-delete filtered) — NO new repo method, and NO per-company wallet
 * lookup (wallet resolution stays keyed off the single chosen companyId). The narrow
 * projection is load-bearing: it stops company internals (creditBalance / isPersonal)
 * reaching the client.
 */
async function resolveEligibleCompanies(userId: string): Promise<EligibleCompany[]> {
  const user = await usersRepository.findWithCompany(userId);
  const memberships = user?.companyMemberships ?? [];
  const eligible: EligibleCompany[] = [];
  for (const m of memberships) {
    if (!roleHasCapability(m.role, CAPABILITIES.CONSUME_CREDITS)) continue;
    const { company } = m; // company_members.companyId is a NOT NULL FK ⇒ relation hydrates
    eligible.push({ id: company.id, name: company.name, logoUrl: company.logoUrl });
  }
  return eligible;
}

export async function openSession(
  input: OpenSessionServiceInput
): Promise<OpenSessionServiceResult> {
  const { initiatingMemberId, expertProfileId, estimatedMinutes, companyId } = input;

  // 1. Build the member's CONSUME_CREDITS-eligible billing-company set (subsumes the old
  //    findWithCompany + getMemberRole gate: membership ∈ eligible IS the capability check).
  const eligible = await resolveEligibleCompanies(initiatingMemberId);

  // No eligible company (no membership / lacks CONSUME_CREDITS) → fail closed.
  if (eligible.length === 0) {
    log.info({ userId: initiatingMemberId }, 'openSession denied — no CONSUME_CREDITS company');
    return { ok: false, code: 'forbidden' };
  }

  // 2. Resolve the chosen billing company.
  let chosenCompanyId: string;
  if (companyId !== undefined) {
    // Explicit choice MUST be one the caller holds CONSUME_CREDITS on (fail-closed IDOR guard).
    const match = eligible.find((c) => c.id === companyId);
    if (match === undefined) {
      log.warn(
        { userId: initiatingMemberId, companyId },
        'openSession denied — companyId not in eligible set'
      );
      return { ok: false, code: 'forbidden' };
    }
    chosenCompanyId = match.id;
  } else if (eligible.length === 1) {
    const [only] = eligible;
    if (only === undefined) return { ok: false, code: 'forbidden' }; // unreachable; satisfies noUncheckedIndexedAccess
    chosenCompanyId = only.id;
  } else {
    log.info(
      { userId: initiatingMemberId, count: eligible.length },
      'openSession — company selection required'
    );
    return { ok: false, code: 'company_selection_required', companies: eligible };
  }

  // 3. Resolve the company wallet (one-per-company; the mandate rides on the wallet row).
  const wallet = await creditWalletsRepository.findByCompanyId(chosenCompanyId);
  if (wallet === undefined) {
    log.error({ companyId: chosenCompanyId }, 'openSession — company has no credit wallet');
    return { ok: false, code: 'wallet_missing' };
  }

  // 4. Delegate to the atomic gate + hold + create-pending primitive.
  const result = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId: chosenCompanyId,
    expertProfileId,
    initiatingMemberId,
    estimatedMinutes,
  });

  if (!result.ok) {
    log.info(
      { companyId: chosenCompanyId, walletId: wallet.id, code: result.code },
      'openSession gate rejected'
    );
    return { ok: false, code: result.code };
  }

  log.info(
    {
      sessionId: result.session.id,
      companyId: chosenCompanyId,
      walletId: wallet.id,
      estimatedMinutes,
    },
    'Session opened (pending)'
  );
  return {
    ok: true,
    sessionId: result.session.id,
    status: 'pending',
    holdId: result.session.holdId,
  };
}
