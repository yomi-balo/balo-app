/**
 * BAL-399 — the EXPERT-side cross-tenant authorization guard for the money-block route. Sibling
 * of `authorizeSessionActor` (which gates COMPANY membership only, with no expert path). The
 * money-block route resolves the lens by trying the actor gate first (company member → client
 * lens); if that fails it tries THIS gate (the session's expert → expert lens); if neither holds
 * it 404s. So an expert can NEVER reach the client/admin lens, and a client NEVER the expert lens.
 *
 * Grants when the authenticated user IS the expert (`userId === profile.userId`, independent
 * expert) OR is a live member of the expert's agency (rights sit on agency membership, ADR-1029).
 * Fail-closed: `not_found` when the session is missing/soft-deleted; `forbidden` otherwise (logged
 * as a cross-tenant attempt, mirroring `authorizeSessionActor`).
 */
import {
  creditSessionsRepository,
  expertsRepository,
  partyMembershipsRepository,
  type CreditSession,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('credit-session');

export type AuthorizeSessionExpertResult =
  | { ok: true; session: CreditSession; expertProfileId: string }
  | { ok: false; code: 'not_found' | 'forbidden' };

/**
 * Fail-closed expert-vs-session authorization. Returns the loaded session + the session's
 * `expertProfileId` on success (so the caller never re-reads for the projection lookup).
 */
export async function authorizeSessionExpert(input: {
  sessionId: string;
  userId: string;
}): Promise<AuthorizeSessionExpertResult> {
  const { sessionId, userId } = input;

  const session = await creditSessionsRepository.findById(sessionId);
  if (session === undefined) {
    return { ok: false, code: 'not_found' };
  }

  const profile = await expertsRepository.findProfileById(session.expertProfileId);
  if (profile === undefined) {
    log.warn(
      { sessionId, userId, expertProfileId: session.expertProfileId },
      'Session expert denied — expert profile not found'
    );
    return { ok: false, code: 'forbidden' };
  }

  // Independent expert: the authenticated user owns the profile.
  if (profile.userId === userId) {
    return { ok: true, session, expertProfileId: session.expertProfileId };
  }

  // Agency-based expert: a LIVE agency membership grants access (rights sit on membership).
  if (profile.agencyId !== null) {
    const role = await partyMembershipsRepository.getMemberRole('agency', profile.agencyId, userId);
    if (role !== undefined) {
      return { ok: true, session, expertProfileId: session.expertProfileId };
    }
  }

  log.warn(
    { sessionId, userId, expertProfileId: session.expertProfileId },
    'Session expert denied — not the expert and not a member of the expert agency (cross-tenant)'
  );
  return { ok: false, code: 'forbidden' };
}
