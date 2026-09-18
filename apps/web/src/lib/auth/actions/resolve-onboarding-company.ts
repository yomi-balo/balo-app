'use server';

import 'server-only';

import {
  extractEmailDomain,
  isBlockedDomain,
  suggestCompanyNameFromEmail,
} from '@balo/shared/domains';
import { partyDomainsRepository, partyMembershipsRepository, companiesRepository } from '@balo/db';
import { getSession } from '@/lib/auth/session';
import { accountRefusalFor } from '@/lib/auth/account-liveness';
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
 * The JOIN arm: read the owning company and shape the `matched` result, or stand down to `new`.
 *
 * ⚠ EXTRACTED ONLY TO SHED COGNITIVE COMPLEXITY (SonarCloud caps the action at 15; BAL-568's
 * liveness gate took the inlined version to 16). The body moved VERBATIM, including the BAL-372
 * blank-name reasoning below.
 */
async function resolveMatchedCompany(
  email: string,
  partyId: string,
  domainJoinMode: string
): Promise<ResolveOnboardingCompanyResult> {
  const company = await companiesRepository.findWithMembers(partyId);
  const name = company?.name?.trim();
  // BAL-372 defense-in-depth: under S2 the name + domain claim commit in ONE tx, so a
  // domain-owning org structurally always has a non-empty name. If that invariant is
  // ever violated, a blank name would render "Join ?" with a blank avatar — so treat a
  // missing/empty/whitespace name as non-actionable and fall through to CREATE.
  if (name === undefined || name === '') {
    return { status: 'new', suggestion: suggestCompanyNameFromEmail(email) };
  }
  return {
    status: 'matched',
    company: {
      name, // trimmed
      // Primitive count only — no member rows cross to the client (no PII).
      memberCount: company?.members?.length ?? 0,
      joinMode: domainJoinMode === 'request' ? 'request' : 'auto',
    },
    suggestion: suggestCompanyNameFromEmail(email),
  };
}

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
 *
 * ⚠ THIS DOCBLOCK BELONGS TO THE ACTION, AND IT BRIEFLY DID NOT (fix round 1, F10): extracting
 * `resolveMatchedCompany` above left it attached to the helper. Keep the helper BELOW this
 * function, or move this block with it.
 */
export async function resolveOnboardingCompanyAction(): Promise<ResolveOnboardingCompanyResult> {
  const session = await getSession();
  const email = session?.user?.email;
  const userId = session?.user?.id;
  if (!email || !userId) return { status: 'new', suggestion: '' }; // no auth/email → fail open

  // BAL-568 — ACCOUNT LIVENESS against the LIVE row; one of the bounded `getSession()`-only set.
  // ⚠⚠ IT SITS **ABOVE** THE `try`, DELIBERATELY. This action fails OPEN on any throw, so a gate
  // inside the `try` would be swallowed by the catch below and silently do nothing. A refused
  // account lands on the same safe default an anonymous one does: no company is disclosed, and
  // this path writes nothing.
  if ((await accountRefusalFor(userId)) !== null) return { status: 'new', suggestion: '' };

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
      return await resolveMatchedCompany(email, owner.partyId, settings.domainJoinMode);
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
