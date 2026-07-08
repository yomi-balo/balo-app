import 'server-only';

import { extractEmailDomain, isBlockedDomain } from '@balo/shared/domains';
import { partyDomainsRepository, partyMembershipsRepository } from '@balo/db';
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
 * DORMANT in v1: `isActionableDomainMatch` stands down for every party while the
 * `isPersonal` guard holds, so this returns `null` in production today. It lights
 * up together with the shared-org creation seam (same predicate the engine reads).
 */
export async function resolveActionableCompanyForSession(
  email: string | undefined
): Promise<ActionableCompany | null> {
  if (!email) return null;
  const domain = extractEmailDomain(email);
  if (domain === null || isBlockedDomain(domain)) return null;

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
