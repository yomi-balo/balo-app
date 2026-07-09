import 'server-only';

import { agenciesRepository, partyDomainsRepository, type PartyDomainWithCreator } from '@balo/db';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import type { AgencyDomainsTabData } from '../_components/settings-tabs';

export interface AgencyDomainsTabResult {
  canManageAgency: boolean;
  agencyDomains: AgencyDomainsTabData | null;
}

const AGENCY_NAME_FALLBACK = 'Your agency';

/**
 * Resolve the agency Domains tab payload (BAL-347). Only surfaced when the expert can
 * MANAGE_MEMBERS on their linked agency; `agencyId === null` (solo/no agency) or a
 * non-admin yields no tab.
 *
 * The tab's own reads are CONTAINED here (`Promise.allSettled`) so a failure degrades to
 * the tab's own error state — `domains: null` → `SectionError` + retry in
 * `AgencyDomainsTab` — instead of rejecting up to the page-level catch, which would blank
 * the ENTIRE expert-settings surface. `partyName` still resolves from the agency summary
 * when available, falling back to a sensible label on the failure path.
 */
export async function resolveAgencyDomainsTab(
  user: { id: string },
  agencyId: string | null
): Promise<AgencyDomainsTabResult> {
  if (!agencyId) {
    return { canManageAgency: false, agencyDomains: null };
  }
  const canManageAgency = await hasCapability(user, CAPABILITIES.MANAGE_MEMBERS, { agencyId });
  if (!canManageAgency) {
    return { canManageAgency: false, agencyDomains: null };
  }

  const [summaryResult, domainsResult] = await Promise.allSettled([
    agenciesRepository.getSummaryById(agencyId),
    partyDomainsRepository.listByPartyWithCreator('agency', agencyId),
  ]);

  const partyName =
    summaryResult.status === 'fulfilled'
      ? (summaryResult.value?.name ?? AGENCY_NAME_FALLBACK)
      : AGENCY_NAME_FALLBACK;

  let domains: PartyDomainWithCreator[] | null = null;
  if (domainsResult.status === 'fulfilled') {
    domains = domainsResult.value;
  } else {
    log.error('Failed to load agency domains for the settings Domains tab', {
      agencyId,
      error:
        domainsResult.reason instanceof Error
          ? domainsResult.reason.message
          : String(domainsResult.reason),
      stack: domainsResult.reason instanceof Error ? domainsResult.reason.stack : undefined,
    });
  }

  return { canManageAgency: true, agencyDomains: { agencyId, partyName, domains } };
}
