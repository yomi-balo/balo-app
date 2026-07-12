import 'server-only';

import {
  partyDomainsRepository,
  partyMembershipsRepository,
  partyJoinOptoutsRepository,
} from '@balo/db';
import { extractEmailDomain, isBlockedDomain, classifyEmailDomain } from '@balo/shared/domains';
import { log } from '@/lib/logging';
import { emitSignupDomainMatched } from '@/lib/analytics/party-join';
import { emitSignupDomainClassified } from '@/lib/analytics/signup-domain';

/**
 * Domain-join DETECT engine (BAL-345 §4, detect-only as of BAL-371 / S3). A PURE
 * orchestrator: `runDomainJoin` looks up a NEW user's verified email domain and —
 * governed by the owning company's join settings — reports whether an actionable
 * company match exists (`detected` + `mode`) or stands down, returning a structured
 * result and NO side-effects. It writes NOTHING: membership creation / request
 * filing is DEFERRED to the onboarding JOIN interstitial's consent actions
 * (`joinMatchedCompanyAction` / `requestJoinCompanyAction`), which own both the
 * durable write AND the resulting notification. `runDomainJoinAndEmit` (the shared
 * post-commit helper wired into all four `createWithWorkspace` seams) records the
 * detection via the `SIGNUP_DOMAIN_MATCHED` analytics event only, wrapped in a
 * swallow-and-log so a domain-join failure can NEVER break auth.
 *
 * One-party-per-domain contract: the engine is the CLIENT-join detection surface,
 * so it acts only on COMPANY-owned domains (step 4a). An agency-owned domain is a
 * no-match here — expert-agency resolution owns that path — which keeps the emitted
 * `SIGNUP_DOMAIN_MATCHED` telemetry company-only.
 */

export interface DomainJoinResult {
  outcome:
    | 'unverified'
    | 'no_domain'
    | 'blocked'
    | 'no_match'
    | 'mode_off'
    | 'directory_authority'
    | 'opted_out'
    | 'detected';
  partyType?: 'company';
  partyId?: string;
  mode?: 'auto' | 'request';
}

export interface RunDomainJoinInput {
  userId: string;
  email: string;
  emailVerified: boolean;
}

/**
 * The §4.3 decision tree. Does NO writes and NO analytics/notifications — returns a
 * structured result the caller records (detection) or the wizard consent action
 * acts on (write). A `detected` outcome carries the matched company's id + the
 * effective join mode; every other outcome is a stand-down carrying nothing.
 */
export async function runDomainJoin(input: RunDomainJoinInput): Promise<DomainJoinResult> {
  // 1. Verified gate (HARD, defence-in-depth) — never match an unverified email.
  //    A dedicated 'unverified' stand-down (distinct from 'no_domain', which means
  //    a verified email had no usable/owned domain). Like every non-matched outcome
  //    it carries no `mode`/`partyType`, so it fires NO analytics.
  if (!input.emailVerified) return { outcome: 'unverified' };

  // 2. Extract + normalise the email domain.
  const domain = extractEmailDomain(input.email);
  if (domain === null) return { outcome: 'no_domain' };

  // 3. Freemail / disposable — never a shareable corporate identity.
  if (isBlockedDomain(domain)) return { outcome: 'blocked' };

  // 4. Which live party owns this domain (partial-unique ⇒ ≤1)?
  const owner = await partyDomainsRepository.findActiveByDomain(domain);
  if (!owner) return { outcome: 'no_match' };

  // 4a. Company-only gate (one-party-per-domain contract). The client join surface
  //     acts ONLY on company-owned domains; an agency-owned domain is a no-match
  //     here — expert-agency resolution owns that path. This also scopes the
  //     detection telemetry (SIGNUP_DOMAIN_MATCHED) to companies.
  if (owner.partyType !== 'company') return { outcome: 'no_match' };

  // 5. The owning party's join settings. Undefined ⇒ party row absent ⇒ no match
  //    (MUST be guarded first — the type is `... | undefined`).
  const settings = await partyMembershipsRepository.getPartyJoinSettings(
    owner.partyType,
    owner.partyId
  );
  if (!settings) return { outcome: 'no_match' };

  // 5a. isPersonal STAND-DOWN — the matched company is someone's personal
  //     workspace; the engine stands down entirely (no trace).
  if (settings.isPersonal) return { outcome: 'no_match' };

  // 5b. Directory-authoritative party — membership is managed externally.
  if (settings.membershipAuthority === 'directory') return { outcome: 'directory_authority' };

  // 5c. Join mode off.
  if (settings.domainJoinMode === 'off') return { outcome: 'mode_off' };

  // 6. The user previously escaped this party (durable opt-out).
  if (await partyJoinOptoutsRepository.exists(owner.partyType, owner.partyId, input.userId)) {
    return { outcome: 'opted_out' };
  }

  // 7. DETECT-ONLY — an actionable company match. The join mode tells the wizard
  //    consent action whether to auto-join or file a request; the engine writes
  //    NOTHING (membership / request creation is deferred to the interstitial).
  return {
    outcome: 'detected',
    partyType: 'company',
    partyId: owner.partyId,
    mode: settings.domainJoinMode === 'request' ? 'request' : 'auto',
  };
}

/**
 * Detection analytics for a match result (§7.3). `SIGNUP_DOMAIN_MATCHED` fires on
 * the `detected` outcome only (it alone carries a `mode`); the completion events
 * (`emitAutoJoinCompleted` / `emitJoinRequestCreated`) now fire from the wizard
 * consent actions on the fresh durable write, not here. The stand-down outcomes
 * emit nothing.
 */
function emitDomainJoinAnalytics(result: DomainJoinResult, userId: string): void {
  if (result.partyType !== undefined && result.mode !== undefined) {
    emitSignupDomainMatched(result.partyType, result.mode, userId);
  }
}

/**
 * The shared post-commit helper wired into all four `createWithWorkspace` seams.
 * Runs the DETECT engine and records the detection via analytics — it performs NO
 * write and publishes NO notification (both are owned by the wizard consent
 * actions). The WHOLE body is wrapped in a try/catch that swallows + logs — a
 * domain-join failure must NEVER break auth. No side-effect ever runs inside a
 * db.transaction (the repos self-wrap + commit before returning; this helper runs
 * after).
 */
export async function runDomainJoinAndEmit(input: RunDomainJoinInput): Promise<void> {
  try {
    // BAL-368 (S1 / ADR-1038): TYPE the signup domain (corporate vs freemail) and
    // record it via analytics ONCE per signup. Independent of the join engine's
    // emailVerified gate below — a freemail/unverified/no-match signup is still a
    // classified signup. Pure classifier; no org is created and no domain is claimed
    // here (claim happens at the Intent step, S2/BAL-369).
    emitSignupDomainClassified(classifyEmailDomain(input.email), input.userId);

    const result = await runDomainJoin(input);
    emitDomainJoinAnalytics(result, input.userId);
  } catch (error) {
    log.error('Domain join failed (auth unaffected)', {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Swallow — a domain-join failure must never break auth.
  }
}
