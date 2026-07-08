import 'server-only';

import { expertsRepository, agenciesRepository } from '@balo/db';
import { extractEmailDomain } from '@balo/shared/domains';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { resolveExpertAgency } from './resolve-expert-agency';
import type { LinkExpertAgencyOutcome } from './types';

/**
 * BAL-356 / ADR-1034 — the authoritative expert→agency WRITE orchestrator. Mirrors
 * `run-domain-join.ts`: a pure orchestrator that composes the already-built
 * `agenciesRepository` transactions and returns a structured result; the caller
 * (`linkExpertAgencyAction`) maps that result to analytics + notifications AFTER the
 * tx commits (never inside it — `@balo/db` emits neither).
 *
 * The outcome is RE-RESOLVED server-side from the session email — the client-supplied
 * `kind` is never trusted. An idempotency guard makes resume / double-click a no-op.
 */

export interface LinkExpertAgencyInput {
  userId: string;
  email: string;
  /** For the SOLO internal payout-entity name (never surfaced to the solo expert). */
  firstName: string | null;
  lastName: string | null;
  expertProfileId: string;
}

export interface LinkResult {
  outcome: LinkExpertAgencyOutcome;
  agencyId: string;
  /** True only on a fresh create/join — gates the post-commit notification publish. */
  fresh: boolean;
  membershipId?: string;
}

/**
 * The internal payout-entity name for a SOLO agency (agency-of-one). Locked Decision
 * 5: `"${firstName} ${lastName}".trim() || 'Independent Expert'`. This is an internal
 * label only — the UI NEVER surfaces it to the solo expert as "your agency".
 */
function soloAgencyName(firstName: string | null, lastName: string | null): string {
  const composed = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  return composed || 'Independent Expert';
}

export async function runLinkExpertAgency(input: LinkExpertAgencyInput): Promise<LinkResult> {
  // 0. Idempotency: if the draft already has an agencyId, this step already ran
  //    (resume / double-click) → no-op. No second agency, no notification.
  const existing = await expertsRepository.findProfileById(input.expertProfileId);
  if (existing?.agencyId) {
    return { outcome: 'already_linked', agencyId: existing.agencyId, fresh: false };
  }

  // 1. Authoritative re-resolve from the (session) email — never trust the client.
  const resolved = await resolveExpertAgency(input.email);
  const actorUserId = input.userId;

  switch (resolved.kind) {
    case 'join': {
      const result = await agenciesRepository.joinExisting({
        agencyId: resolved.agency.id,
        userId: input.userId,
        expertProfileId: input.expertProfileId,
        actorUserId,
      });
      return {
        outcome: 'join',
        agencyId: resolved.agency.id,
        fresh: result.outcome === 'joined',
        membershipId: result.membershipId,
      };
    }
    case 'provision': {
      const domain = extractEmailDomain(input.email);
      if (domain === null) {
        // Defensive: the provision branch is only reached for a real corporate
        // domain, so this cannot happen — but guard rather than assert non-null.
        throw new Error('runLinkExpertAgency: provision resolved without a usable domain');
      }
      const result = await agenciesRepository.provision({
        name: resolved.name || soloAgencyName(input.firstName, input.lastName),
        domain,
        userId: input.userId,
        expertProfileId: input.expertProfileId,
        actorUserId,
      });
      return { outcome: 'provision', agencyId: result.agencyId, fresh: true };
    }
    case 'solo': {
      const result = await agenciesRepository.provisionSolo({
        name: soloAgencyName(input.firstName, input.lastName),
        userId: input.userId,
        expertProfileId: input.expertProfileId,
        actorUserId,
      });
      return { outcome: 'solo', agencyId: result.agencyId, fresh: true };
    }
  }
}

/**
 * Post-commit notifications for a resolution result (§10). Best-effort — swallows +
 * logs so a notification hiccup can NEVER turn a committed write into a user-facing
 * failure. Published only on the freshly-created branch:
 *   - JOIN     → reuse the existing `party.member_joined_via_domain` (partyType agency)
 *   - PROVISION→ the new `agency.provisioned` event (rule/template deferred to BAL-348)
 *   - SOLO / already_linked → nothing (never say "agency" to a solo expert).
 * Idempotent on retries via the stable `correlationId` (membershipId / agencyId) →
 * BullMQ jobId dedup.
 */
export async function publishAgencyResolutionNotifications(
  result: LinkResult,
  userId: string
): Promise<void> {
  try {
    if (result.outcome === 'join' && result.membershipId !== undefined) {
      await publishNotificationEvent('party.member_joined_via_domain', {
        correlationId: result.membershipId,
        partyType: 'agency',
        partyId: result.agencyId,
        userId,
      });
      return;
    }
    if (result.outcome === 'provision') {
      await publishNotificationEvent('agency.provisioned', {
        correlationId: result.agencyId,
        agencyId: result.agencyId,
        ownerUserId: userId,
      });
    }
  } catch (error) {
    log.error('Agency resolution notification publish failed (write unaffected)', {
      userId,
      outcome: result.outcome,
      agencyId: result.agencyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Swallow — a notification failure must never fail the committed write.
  }
}
