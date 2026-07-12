'use server';

import 'server-only';

import {
  extractEmailDomain,
  isBlockedDomain,
  suggestCompanyNameFromEmail,
} from '@balo/shared/domains';
import { partyDomainsRepository, partyMembershipsRepository, companiesRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { isActionableDomainMatch } from '@/lib/domain-join/match-stand-down';
import { log } from '@/lib/logging';

/**
 * The effective workspace identity the onboarding company step needs:
 *  - `new`     → CREATE branch, prefill the field with `suggestion` (may be '')
 *  - `blocked` → CREATE branch, empty prefill (freemail/disposable domain)
 *  - `matched` → JOIN branch (reachable: a same-domain company that was promoted
 *                to a shared organization at the onboarding Intent step (BAL-369)
 *                produces an actionable match here)
 */
export type ResolveOnboardingCompanyResult =
  | { status: 'new'; suggestion: string }
  | { status: 'blocked'; suggestion: '' }
  | {
      status: 'matched';
      company: { name: string; memberCount: number; joinMode: 'auto' | 'request' };
      // BAL-346: email-derived name that powers the JOIN branch's escape hatch
      // ("This isn't my company") — prefilling the create field rather than
      // landing the user on a blank one.
      suggestion: string;
    };

/**
 * READ-ONLY, authenticated Server Action that resolves the signed-in user's
 * workspace identity from their email domain. Unlike PR #134's pre-auth endpoint
 * this reads the email from the SESSION (never a client arg), which removes the
 * rate-limit / info-disclosure concern entirely.
 *
 * Uses `getSession()` directly — NOT `requireUser()` (which throws on a MISSING
 * user) — so a missing session simply fails open instead of throwing mid-onboarding.
 * Performs ZERO writes: only the read repositories `findActiveByDomain`,
 * `getPartyJoinSettings`, `findWithMembers`.
 *
 * FAIL-OPEN: any thrown error → `{ status: 'new', suggestion }` so onboarding is
 * never blocked on a resolve failure (logged at `warn`, since it is recoverable).
 */
export async function resolveOnboardingCompanyAction(): Promise<ResolveOnboardingCompanyResult> {
  const session = await getSession();
  const email = session?.user?.email;
  if (!email) return { status: 'new', suggestion: '' }; // no auth/email → fail open, empty prefill

  try {
    const domain = extractEmailDomain(email);
    if (domain === null) return { status: 'new', suggestion: '' };
    if (isBlockedDomain(domain)) return { status: 'blocked', suggestion: '' };

    // Owner lookup (single live owner platform-wide). Company-type GATE via the
    // returned row — an agency-owned domain is never a company join target.
    const owner = await partyDomainsRepository.findActiveByDomain(domain);
    if (owner === undefined || owner.partyType !== 'company') {
      return { status: 'new', suggestion: suggestCompanyNameFromEmail(email) };
    }

    const settings = await partyMembershipsRepository.getPartyJoinSettings(
      owner.partyType,
      owner.partyId
    );
    if (settings === undefined) {
      return { status: 'new', suggestion: suggestCompanyNameFromEmail(email) };
    }

    // Only an ACTIONABLE match (non-personal, non-directory, mode on) becomes a
    // JOIN — a personal workspace stands down to 'new'. This is reachable: once
    // the owning company is promoted to a shared organization (BAL-369, at the
    // onboarding Intent step) its `isPersonal` flips false and a same-domain
    // second signup resolves 'matched' here — the same predicate the detect
    // engine reads.
    if (isActionableDomainMatch(owner.partyType, settings)) {
      const company = await companiesRepository.findWithMembers(owner.partyId);
      return {
        status: 'matched',
        company: {
          name: company?.name ?? '',
          // Primitive count only — no member rows cross to the client (no PII).
          memberCount: company?.members?.length ?? 0,
          joinMode: settings.domainJoinMode === 'request' ? 'request' : 'auto',
        },
        suggestion: suggestCompanyNameFromEmail(email),
      };
    }
    return { status: 'new', suggestion: suggestCompanyNameFromEmail(email) };
  } catch (error) {
    log.warn('Onboarding company resolve failed (failing open to create)', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Fail open: behave as an unmatched corporate domain so onboarding is never blocked.
    return { status: 'new', suggestion: suggestCompanyNameFromEmail(email) };
  }
}
