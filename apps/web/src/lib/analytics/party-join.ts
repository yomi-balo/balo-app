import 'server-only';

import {
  trackServerAndFlush,
  PARTY_JOIN_SERVER_EVENTS,
  PARTY_DOMAIN_SERVER_EVENTS,
} from '@/lib/analytics/server';

/**
 * Domain auto-join analytics helpers (BAL-345 §7.3). All six events are SERVER
 * events, decided in the match engine / Server Actions and fired AFTER the DB tx
 * commits (via `trackServerAndFlush`). `@balo/db` never emits — the repos return
 * structured results and these wrappers run in the web caller post-commit.
 *
 * NB none of these are client events, so there is NO change to the
 * `vi.mock('@/lib/analytics')` client-export list in `apps/web/src/test/setup.ts`.
 */

type PartyType = 'company' | 'agency';

/** A verified domain matched a shareable party (any of the 4 matched outcomes). */
export function emitSignupDomainMatched(
  partyType: PartyType,
  mode: 'auto' | 'request',
  userId: string
): void {
  trackServerAndFlush(PARTY_JOIN_SERVER_EVENTS.SIGNUP_DOMAIN_MATCHED, {
    party_type: partyType,
    mode,
    distinct_id: userId,
  });
}

/** A new membership was created via auto-join. */
export function emitAutoJoinCompleted(partyType: PartyType, userId: string): void {
  trackServerAndFlush(PARTY_JOIN_SERVER_EVENTS.DOMAIN_AUTO_JOIN_COMPLETED, {
    party_type: partyType,
    distinct_id: userId,
  });
}

/** A pending join request was created via request-mode. */
export function emitJoinRequestCreated(partyType: PartyType, userId: string): void {
  trackServerAndFlush(PARTY_JOIN_SERVER_EVENTS.REQUEST_CREATED, {
    party_type: partyType,
    distinct_id: userId,
  });
}

/**
 * An admin resolved a pending join request. `distinct_id` is the REQUESTER (the
 * subject of the request), not the resolving admin. `timeToResolutionSeconds` is
 * whole seconds from request creation to resolution.
 */
export function emitJoinRequestResolved(
  resolution: 'approved' | 'declined',
  input: { partyType: PartyType; timeToResolutionSeconds: number; requesterUserId: string }
): void {
  const event =
    resolution === 'approved'
      ? PARTY_JOIN_SERVER_EVENTS.REQUEST_APPROVED
      : PARTY_JOIN_SERVER_EVENTS.REQUEST_DECLINED;
  trackServerAndFlush(event, {
    party_type: input.partyType,
    time_to_resolution_seconds: input.timeToResolutionSeconds,
    distinct_id: input.requesterUserId,
  });
}

/** A user used the escape hatch to leave a domain party (durable opt-out recorded). */
export function emitDomainJoinOptedOut(path: 'auto' | 'request', userId: string): void {
  trackServerAndFlush(PARTY_JOIN_SERVER_EVENTS.DOMAIN_JOIN_OPTED_OUT, {
    path,
    distinct_id: userId,
  });
}

/**
 * BAL-347 admin settings surface. An admin explicitly ADDED a domain (source is
 * always 'admin_added' — the signup auto path emits CAPTURED). Fired post-commit
 * from the add-domain Server Action on a `captured` outcome only.
 */
export function emitPartyDomainAdded(
  partyType: PartyType,
  source: 'admin_added',
  userId: string
): void {
  trackServerAndFlush(PARTY_DOMAIN_SERVER_EVENTS.ADDED, {
    party_type: partyType,
    source,
    distinct_id: userId,
  });
}

/** BAL-347. An admin soft-removed a domain (fired post-commit on a `removed` outcome). */
export function emitPartyDomainRemoved(partyType: PartyType, userId: string): void {
  trackServerAndFlush(PARTY_DOMAIN_SERVER_EVENTS.REMOVED, {
    party_type: partyType,
    distinct_id: userId,
  });
}

/** BAL-347 (company only). An admin changed the domain join mode (fired only when it changed). */
export function emitDomainJoinModeChanged(
  from: 'auto' | 'request' | 'off',
  to: 'auto' | 'request' | 'off',
  userId: string
): void {
  trackServerAndFlush(PARTY_JOIN_SERVER_EVENTS.MODE_CHANGED, {
    from,
    to,
    distinct_id: userId,
  });
}
