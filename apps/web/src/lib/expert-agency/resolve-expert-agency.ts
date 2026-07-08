import 'server-only';

import {
  extractEmailDomain,
  isBlockedDomain,
  suggestCompanyNameFromEmail,
} from '@balo/shared/domains';
import { partyDomainsRepository, agenciesRepository } from '@balo/db';
import type { ResolveExpertAgencyResult } from './types';

export type { ResolveExpertAgencyResult } from './types';

/**
 * BAL-356 / ADR-1034 — the PURE, read-only expert→agency resolver. Shared by the
 * read Server Action (`resolveExpertAgencyAction`, advisory display) AND the
 * authoritative write orchestrator (`runLinkExpertAgency`, which re-resolves so the
 * outcome is never trusted from the client). Performs ZERO writes — only the read
 * repositories `findActiveByDomain` + `getSummaryById`.
 *
 * Decision tree (Decision 3 of the plan):
 *   - blocked / no usable domain            → SOLO  (freemail/disposable — independent)
 *   - domain unowned                        → PROVISION (signer becomes owner)
 *   - domain owned by a COMPANY             → SOLO  (an agency can't claim a company
 *                                                     domain — the collision → solo path)
 *   - domain owned by an AGENCY (row found) → JOIN that agency (unconditional — no
 *                                             mode/authority/isPersonal gating; that is
 *                                             the company-only path)
 *   - domain owned by an AGENCY (row gone)  → PROVISION (defensive: dangling owner)
 *
 * Agency JOIN is deliberately unconditional once `partyType==='agency'` — unlike
 * `resolveOnboardingCompanyAction`, agency membership is DETERMINED BY EMAIL and never
 * mode-gated.
 */
export async function resolveExpertAgency(email: string): Promise<ResolveExpertAgencyResult> {
  const domain = extractEmailDomain(email);
  if (domain === null || isBlockedDomain(domain)) {
    return { kind: 'solo' };
  }

  const owner = await partyDomainsRepository.findActiveByDomain(domain);
  if (owner === undefined) {
    return { kind: 'provision', name: suggestCompanyNameFromEmail(email) };
  }

  // A company owns this domain — an agency cannot claim or join it → collision → solo.
  if (owner.partyType !== 'agency') {
    return { kind: 'solo' };
  }

  const summary = await agenciesRepository.getSummaryById(owner.partyId);
  if (summary === undefined) {
    // Dangling domain owner with no agency row — fall back to provisioning.
    return { kind: 'provision', name: suggestCompanyNameFromEmail(email) };
  }

  return { kind: 'join', agency: summary };
}
