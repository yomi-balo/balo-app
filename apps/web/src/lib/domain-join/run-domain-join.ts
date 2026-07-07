import 'server-only';

import {
  partyDomainsRepository,
  partyMembershipsRepository,
  partyJoinRequestsRepository,
  partyJoinOptoutsRepository,
} from '@balo/db';
import { extractEmailDomain, isBlockedDomain } from '@balo/shared/domains';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import {
  emitSignupDomainMatched,
  emitAutoJoinCompleted,
  emitJoinRequestCreated,
} from '@/lib/analytics/party-join';

/**
 * Domain auto-join match engine (BAL-345 §4). A PURE orchestrator: `runDomainJoin`
 * looks up a NEW user's verified email domain and — governed by the owning party's
 * join settings — auto-joins, files a pending request, or does nothing, returning
 * a structured result and NO side-effects. `runDomainJoinAndEmit` (the shared
 * post-commit helper wired into all four `createWithWorkspace` seams) then fires
 * analytics + notifications, wrapped in a swallow-and-log so a domain-join failure
 * can NEVER break auth.
 *
 * ⚑ v1: the engine ships INERT behind the isPersonal STAND-DOWN (step 5a) — every
 * `party_domains` row currently maps a domain → someone's PERSONAL workspace, so a
 * company match stands down. The full engine is built; the guard makes it dormant
 * safely until a shared-org creation seam ships.
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
    | 'auto_joined'
    | 'auto_already_member'
    | 'request_created'
    | 'request_already_pending';
  partyType?: 'company' | 'agency';
  partyId?: string;
  mode?: 'auto' | 'request';
  membershipId?: string;
  joinRequestId?: string;
}

export interface RunDomainJoinInput {
  userId: string;
  email: string;
  emailVerified: boolean;
}

/**
 * The §4.3 decision tree. Does NO analytics/notifications — returns a structured
 * result the caller maps to side-effects post-commit. Every write is find-or-create
 * against a partial-unique arbiter, so a stray second call is a clean no-op.
 */
export async function runDomainJoin(input: RunDomainJoinInput): Promise<DomainJoinResult> {
  // 1. Verified gate (HARD, defence-in-depth) — never match an unverified email.
  //    A dedicated 'unverified' stand-down (distinct from 'no_domain', which means
  //    a verified email had no usable/owned domain). Like every non-matched outcome
  //    it carries no `mode`/`partyType`, so it fires NO analytics and NO notification.
  if (!input.emailVerified) return { outcome: 'unverified' };

  // 2. Extract + normalise the email domain.
  const domain = extractEmailDomain(input.email);
  if (domain === null) return { outcome: 'no_domain' };

  // 3. Freemail / disposable — never a shareable corporate identity.
  if (isBlockedDomain(domain)) return { outcome: 'blocked' };

  // 4. Which live party owns this domain (partial-unique ⇒ ≤1)?
  const owner = await partyDomainsRepository.findActiveByDomain(domain);
  if (!owner) return { outcome: 'no_match' };

  // 5. The owning party's join settings. Undefined ⇒ party row absent ⇒ no match
  //    (MUST be guarded first — the type is `... | undefined`).
  const settings = await partyMembershipsRepository.getPartyJoinSettings(
    owner.partyType,
    owner.partyId
  );
  if (!settings) return { outcome: 'no_match' };

  // 5a. isPersonal STAND-DOWN — the matched company is someone's personal
  //     workspace; the engine stands down entirely (no trace, no write). In v1
  //     this fires for EVERY company match (all companies are personal).
  if (owner.partyType === 'company' && settings.isPersonal) return { outcome: 'no_match' };

  // 5b. Directory-authoritative party — membership is managed externally.
  if (settings.membershipAuthority === 'directory') return { outcome: 'directory_authority' };

  // 5c. Join mode off.
  if (settings.domainJoinMode === 'off') return { outcome: 'mode_off' };

  // 6. The user previously escaped this party (durable opt-out).
  if (await partyJoinOptoutsRepository.exists(owner.partyType, owner.partyId, input.userId)) {
    return { outcome: 'opted_out' };
  }

  // 7. Auto mode → find-or-create the membership (idempotent).
  if (settings.domainJoinMode === 'auto') {
    const result = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: owner.partyType,
      partyId: owner.partyId,
      userId: input.userId,
      actorUserId: input.userId,
    });
    return {
      outcome: result.outcome === 'joined' ? 'auto_joined' : 'auto_already_member',
      partyType: owner.partyType,
      partyId: owner.partyId,
      mode: 'auto',
      membershipId: result.membershipId,
    };
  }

  // 8. Request mode → find-or-create the pending request (idempotent).
  const result = await partyJoinRequestsRepository.findOrCreatePending({
    partyType: owner.partyType,
    partyId: owner.partyId,
    userId: input.userId,
  });
  return {
    outcome: result.outcome === 'created' ? 'request_created' : 'request_already_pending',
    partyType: owner.partyType,
    partyId: owner.partyId,
    mode: 'request',
    joinRequestId: result.request.id,
  };
}

/**
 * Analytics for a match result (§7.3). `SIGNUP_DOMAIN_MATCHED` fires on the four
 * matched outcomes only (they alone carry a `mode`); the completion events fire
 * ONLY on the freshly-created outcomes (never the idempotent repeats). The
 * stand-down outcomes emit nothing.
 */
function emitDomainJoinAnalytics(result: DomainJoinResult, userId: string): void {
  if (result.partyType !== undefined && result.mode !== undefined) {
    emitSignupDomainMatched(result.partyType, result.mode, userId);
  }
  if (result.outcome === 'auto_joined' && result.partyType !== undefined) {
    emitAutoJoinCompleted(result.partyType, userId);
  } else if (result.outcome === 'request_created' && result.partyType !== undefined) {
    emitJoinRequestCreated(result.partyType, userId);
  }
}

/**
 * Notifications for a match result (§6). Published ONLY on the freshly-created
 * outcomes (`auto_joined` / `request_created`) — the idempotent repeats already
 * notified. `userId` is the joiner/requester subject (correlationId is the stable
 * membership/request id ⇒ BullMQ jobId dedup).
 */
async function publishDomainJoinNotifications(
  result: DomainJoinResult,
  userId: string
): Promise<void> {
  if (
    result.outcome === 'auto_joined' &&
    result.membershipId !== undefined &&
    result.partyType !== undefined &&
    result.partyId !== undefined
  ) {
    await publishNotificationEvent('party.member_joined_via_domain', {
      correlationId: result.membershipId,
      partyType: result.partyType,
      partyId: result.partyId,
      userId,
    });
    return;
  }
  if (
    result.outcome === 'request_created' &&
    result.joinRequestId !== undefined &&
    result.partyType !== undefined &&
    result.partyId !== undefined
  ) {
    await publishNotificationEvent('party.join_request_created', {
      correlationId: result.joinRequestId,
      partyType: result.partyType,
      partyId: result.partyId,
      userId,
    });
  }
}

/**
 * The shared post-commit helper wired into all four `createWithWorkspace` seams.
 * Runs the engine, then emits analytics + publishes notifications. The WHOLE body
 * is wrapped in a try/catch that swallows + logs — a domain-join failure must
 * NEVER break auth (mirrors `emitDomainCapture` / `publishNotificationEvent`'s
 * fire-and-forget contract). No side-effect ever runs inside a db.transaction (the
 * repos self-wrap + commit before returning; this helper runs after).
 */
export async function runDomainJoinAndEmit(input: RunDomainJoinInput): Promise<void> {
  try {
    const result = await runDomainJoin(input);
    emitDomainJoinAnalytics(result, input.userId);
    await publishDomainJoinNotifications(result, input.userId);
  } catch (error) {
    log.error('Domain join failed (auth unaffected)', {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Swallow — a domain-join failure must never break auth.
  }
}
