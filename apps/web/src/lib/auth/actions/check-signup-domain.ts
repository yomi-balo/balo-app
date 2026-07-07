'use server';

import 'server-only';

import { extractEmailDomain, isBlockedDomain } from '@balo/shared/domains';
import { partyDomainsRepository, partyMembershipsRepository } from '@balo/db';
import { isActionableDomainMatch } from '@/lib/domain-join/match-stand-down';
import { emailSchema, type CheckSignupDomainResult } from '@/components/balo/auth/schemas';
import { log } from '@/lib/logging';

/**
 * Side-effect-free (READ-ONLY) pre-submit domain check for CLIENT signup. Returns
 * the EFFECTIVE status the UI needs to decide whether to show the compulsory
 * company-name field. NO membership writes, NO auto-join, NO capture — it never
 * calls runDomainJoin, so BAL-345's verified-email gate is untouched. Intentionally
 * unauthenticated (signup precedes auth); returns only a coarse status (no PII / no
 * company names), so information disclosure is negligible.
 *
 * FAIL-OPEN: any lookup error or unusable input → `{ status: 'new' }` so the client
 * shows the field and signup is never blocked on a domain-check failure.
 */
export async function checkSignupDomainAction(email: string): Promise<CheckSignupDomainResult> {
  try {
    // Validate shape; incomplete/invalid email ⇒ fail open (show the field).
    const parsed = emailSchema.safeParse({ email });
    if (!parsed.success) return { status: 'new' };

    const domain = extractEmailDomain(parsed.data.email);
    if (domain === null) return { status: 'new' };

    // 1. Blocked (freemail/disposable) → show field.
    if (isBlockedDomain(domain)) return { status: 'blocked' };

    // 2. Owner lookup (pure — does NOT consider isPersonal).
    const owner = await partyDomainsRepository.findActiveByDomain(domain);
    if (owner === undefined) return { status: 'new' };

    // 3. Owning party's join settings; undefined ⇒ party row absent ⇒ effectively new.
    const settings = await partyMembershipsRepository.getPartyJoinSettings(
      owner.partyType,
      owner.partyId
    );
    if (settings === undefined) return { status: 'new' };

    // 4. Objection B: only an ACTIONABLE match (non-personal, non-directory, mode on)
    //    hides the field. A personal-owner match ⇒ stand-down ⇒ 'new' ⇒ show field.
    return isActionableDomainMatch(owner.partyType, settings)
      ? { status: 'matched' }
      : { status: 'new' };
  } catch (error) {
    log.warn('Signup domain check failed (failing open to show company field)', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'new' };
  }
}
