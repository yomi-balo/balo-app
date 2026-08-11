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
 *
 * ⚠⚠ BAL-419 — THE NAME SAYS **VISIBILITY**, AND THE RULE IS CONSUMED, NOT DEFINED HERE. The
 * grant decision is `actorHasExpertSideVisibility` (`@balo/shared/authz`), the single definition
 * on the platform, shared with `authorizeEngagementConversation` and `authorizeMeetingFileAccess`
 * in `apps/web`. It grants the delivering expert ∪ ANY live agency member, INCLUDING agency role
 * `expert`.
 *
 * ⚠ THAT IS DELIBERATELY WIDER THAN THE ACT AXIS (`resolveHostRole` /
 * `hasEngagementCapability`, which excludes agency role `expert`), and the width is the point.
 * ADR-1046 §7, resolved 2026-08-03: "visibility and act rights are different rules by design. Do
 * not narrow it." Reading one's own earnings on a session is visibility, not an act. The two
 * predicates are pinned side by side over one role table in
 * `packages/shared/src/authz/expert-side-visibility.test.ts` — that is where an "alignment"
 * fails.
 */
import {
  creditSessionsRepository,
  expertsRepository,
  partyMembershipsRepository,
  type CreditSession,
} from '@balo/db';
import { actorHasExpertSideVisibility } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';

const log = createLogger('credit-session');

export type AuthorizeSessionExpertVisibilityResult =
  | { ok: true; session: CreditSession; expertProfileId: string }
  | { ok: false; code: 'not_found' | 'forbidden' };

/**
 * Fail-closed expert-vs-session authorization. Returns the loaded session + the session's
 * `expertProfileId` on success (so the caller never re-reads for the projection lookup).
 */
export async function authorizeSessionExpertVisibility(input: {
  sessionId: string;
  userId: string;
}): Promise<AuthorizeSessionExpertVisibilityResult> {
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

  // The delivering expert ∪ ANY live member of their agency — the SHARED visibility rule, not a
  // local one. The delivering expert and an INDEPENDENT expert both resolve with NO agency
  // lookup at all (the callback is never invoked); that short-circuit is asserted by call-count
  // in this module's own test suite, for BOTH profile shapes.
  //
  // ⚠ The lookup takes `actorId` as a PARAMETER rather than capturing `userId`, so a callback
  // can never answer for an actor other than the one being authorized (the confused-deputy
  // shape `HostContext.resolvedForActorId` closes on the act axis). Do not "simplify" it.
  const onExpertSide = await actorHasExpertSideVisibility(profile, userId, (agencyId, actorId) =>
    partyMembershipsRepository.getMemberRole('agency', agencyId, actorId)
  );
  if (onExpertSide) {
    return { ok: true, session, expertProfileId: session.expertProfileId };
  }

  log.warn(
    { sessionId, userId, expertProfileId: session.expertProfileId },
    'Session expert denied — not the expert and not a member of the expert agency (cross-tenant)'
  );
  return { ok: false, code: 'forbidden' };
}
