/**
 * BAL-378 (ADR-1040 Lane 2) — `connectSession`: authorize the actor against the session's
 * company (fail-closed), then pending → active (idempotent on already-active). No money, no
 * wallet lock. The client fires `SESSION_EVENTS.STARTED` on success.
 */
import { creditSessionsRepository } from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { authorizeSessionActor } from './authorize-session-actor.js';
import type { ConnectSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

export async function connectSession(
  sessionId: string,
  userId: string,
  opts: { now?: Date } = {}
): Promise<ConnectSessionServiceResult> {
  const auth = await authorizeSessionActor({
    sessionId,
    userId,
    requireCapability: CAPABILITIES.CONSUME_CREDITS,
  });
  if (!auth.ok) {
    return auth;
  }

  const session = await creditSessionsRepository.connect(sessionId, opts);
  log.info({ sessionId, userId, status: session.status }, 'Session connected');
  return { ok: true, session };
}
