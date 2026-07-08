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
 *   - email NOT verified                    → SOLO  (ADR-1034: agency membership is
 *                                                     determined by the VERIFIED signup
 *                                                     email — an unproven email must
 *                                                     never provision/join a domain)
 *   - blocked / no usable domain            → SOLO  (freemail/disposable — independent)
 *   - domain unowned                        → PROVISION (signer becomes owner)
 *   - domain owned by a COMPANY             → SOLO  (an agency can't claim a company
 *                                                     domain — the collision → solo path)
 *   - domain owned by an AGENCY (row found) → JOIN that agency (unconditional — no
 *                                             mode/authority/isPersonal gating; that is
 *                                             the company-only path)
 *   - domain owned by an AGENCY (row gone)  → PROVISION (defensive: dangling owner)
 *
 * The verified-email gate is the FIRST check and short-circuits to SOLO BEFORE any
 * domain lookup — so an unverified corporate email can neither provision (capture) a
 * domain nor join an existing agency. This fails SAFE to the independent path
 * (consistent with the "resolve fails open to solo" philosophy — never a hard block).
 *
 * Agency JOIN is deliberately unconditional once `partyType==='agency'` — unlike
 * `resolveOnboardingCompanyAction`, agency membership is DETERMINED BY EMAIL and never
 * mode-gated.
 */
export async function resolveExpertAgency(
  email: string,
  emailVerified: boolean
): Promise<ResolveExpertAgencyResult> {
  // ADR-1034 verified-email gate: an unverified email must NEVER provision or join a
  // domain. Short-circuit to solo BEFORE any domain lookup (fail safe to independent).
  if (emailVerified !== true) {
    return { kind: 'solo' };
  }

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
