/**
 * BAL-378 (ADR-1040 Lane 2) — the SINGLE cross-tenant authorization guard for the per-session
 * lifecycle handlers (`connect` / `end` / `nudge` / `drawdown-state`). `openSession` gates the
 * actor against their OWN company; every sibling handler receives a session UUID from the wire
 * and MUST re-verify that the authenticated actor is a live member of the session's company —
 * otherwise any authenticated user could force-connect/force-end a victim's session (triggering
 * an off_session card charge), spam nudges, or read the victim's live wallet balance (IDOR).
 *
 * Loads the session (`findById`, excludes soft-deleted → `not_found`), resolves the actor's LIVE
 * company-membership role (fail-closed → `forbidden` for non-members), and — when a capability
 * is required — checks it against the same pure `@balo/shared/authz` map `openSession` uses. The
 * loaded session + role are threaded back so callers never re-read for authz.
 */
import { creditSessionsRepository, partyMembershipsRepository, type CreditSession } from '@balo/db';
import { roleHasCapability, type Capability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import type { SessionActorErrorCode } from './types.js';

const log = createLogger('credit-session');

export interface AuthorizeSessionActorInput {
  sessionId: string;
  userId: string;
  /** When set, the actor's role must grant this capability (company-scoped) or `forbidden`. */
  requireCapability?: Capability;
}

export type AuthorizeSessionActorResult =
  | { ok: true; session: CreditSession; role: string }
  | { ok: false; code: SessionActorErrorCode };

/**
 * Fail-closed actor-vs-session-company authorization. `not_found` when the session is missing or
 * soft-deleted; `forbidden` when the actor is not a live member of the session's company (or,
 * with `requireCapability`, lacks that capability). Returns the loaded session + role on success.
 */
export async function authorizeSessionActor(
  input: AuthorizeSessionActorInput
): Promise<AuthorizeSessionActorResult> {
  const { sessionId, userId, requireCapability } = input;

  const session = await creditSessionsRepository.findById(sessionId);
  if (session === undefined) {
    return { ok: false, code: 'not_found' };
  }

  const role = await partyMembershipsRepository.getMemberRole('company', session.companyId, userId);
  if (role === undefined) {
    log.warn(
      { sessionId, userId, companyId: session.companyId },
      'Session actor denied — not a member of the session company (cross-tenant)'
    );
    return { ok: false, code: 'forbidden' };
  }

  if (requireCapability !== undefined && !roleHasCapability(role, requireCapability)) {
    log.warn(
      { sessionId, userId, companyId: session.companyId, requireCapability },
      'Session actor denied — role lacks the required capability'
    );
    return { ok: false, code: 'forbidden' };
  }

  return { ok: true, session, role };
}
