import 'server-only';

import { extractEmailDomain, isBlockedDomain } from '@balo/shared/domains';
import { partyDomainsRepository, partyMembershipsRepository, usersRepository } from '@balo/db';
import { isActionableDomainMatch } from './match-stand-down';

export interface ActionableCompany {
  partyId: string;
  mode: 'auto' | 'request';
}

/**
 * Re-derive the actionable COMPANY that owns the session user's email domain —
 * the SAME read chain as `resolveOnboardingCompanyAction`, returning only the
 * authoritative party id + mode the write actions need. ZERO client input: the
 * party is never trusted from the browser (IDOR guard). Returns `null` when there
 * is no actionable company match (→ callers fail CLOSED).
 *
 * BAL-348 HARD SECURITY GATE: an unverified session must NEVER be able to
 * interstitial join / request-to-join a domain-matched company. `SessionUser` carries
 * no `emailVerified`, so this reads `users.emailVerified` from the DB (keyed by
 * `userId`) and FAILS CLOSED — an unverified or missing user resolves to `null`,
 * mirroring `runDomainJoin`'s step-1 `unverified` stand-down. The DB read is placed
 * AFTER the cheap email/domain/blocked guards (no needless read when there is
 * obviously no usable corporate domain) and BEFORE the owner lookup.
 *
 * DORMANT in v1: `isActionableDomainMatch` stands down for every party while the
 * `isPersonal` guard holds, so this returns `null` in production today. It lights
 * up together with the shared-org creation seam (same predicate the engine reads).
 */
export async function resolveActionableCompanyForSession(
  userId: string,
  email: string | undefined
): Promise<ActionableCompany | null> {
  if (!email) return null;
  const domain = extractEmailDomain(email);
  if (domain === null || isBlockedDomain(domain)) return null;

  // BAL-348 HARD gate (mirrors runDomainJoin step 1). Fails CLOSED — an unverified or
  // missing session user can never interstitial join / request.
  const user = await usersRepository.findById(userId);
  if (user?.emailVerified !== true) return null;

  const owner = await partyDomainsRepository.findActiveByDomain(domain);
  if (owner === undefined || owner.partyType !== 'company') return null; // company-type gate

  const settings = await partyMembershipsRepository.getPartyJoinSettings(
    owner.partyType,
    owner.partyId
  );
  if (settings === undefined) return null;
  // isPersonal / directory / mode-off stand-down — same predicate the resolve
  // action and the match engine read.
  if (!isActionableDomainMatch(owner.partyType, settings)) return null;

  return {
    partyId: owner.partyId,
    mode: settings.domainJoinMode === 'request' ? 'request' : 'auto',
  };
}
