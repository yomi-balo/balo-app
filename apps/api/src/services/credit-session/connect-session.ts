/**
 * BAL-378 (ADR-1040 Lane 2) — `connectSession`: authorize the actor against the session's
 * company (fail-closed), then pending → active (idempotent on already-active). No money, no
 * wallet lock.
 *
 * ⚠ BAL-466 (D7) — THE CLIENT DOES NOT FIRE `session_started`, AND NEVER DID. That claim was
 * false on `main`: the only production render of `InSessionPanel` is `variant="embedded"`,
 * whose `expertProfileId` is typed `never`, so the effect always early-returned. The event now
 * fires SERVER-SIDE as `SESSION_SERVER_EVENTS.SESSION_STARTED`, at the real connect seam
 * (`services/meetings/presence-writer.ts`'s co-presence transition), and the client constant
 * was removed.
 */
import { creditSessionsRepository, type CreditSession } from '@balo/db';
import { CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { authorizeSessionActor } from './authorize-session-actor.js';
import type { ConnectSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/**
 * BAL-466 (D6) — SYSTEM connect: `pending → active`, stamping `connectedAt` (the metering
 * anchor). No money, no wallet lock, idempotent on an already-`active` session.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE** — the same warning `endSessionAsSystem` and
 * `settleSessionFromPresence` carry, for the same reason: it performs NO ACTOR AUTHORIZATION.
 * Its ONE caller is `presence-writer.ts`'s co-presence transition, which is driven by the Daily
 * webhook and the meeting-lifecycle sweep and has no acting human by construction. A route
 * reaching it would let any caller who can name a `sessionId` start a victim's meter.
 * Route-facing connect goes through {@link connectSession}, which authorizes the actor.
 *
 * ⚠ IT THROWS. `SessionNotFoundError` / `InvalidSessionTransitionError` propagate exactly as
 * they do from `connectSession`; the caller decides. `presence-writer.ts` catches and logs,
 * because a webhook must not fail on a metering fault.
 */
export async function connectSessionAsSystem(
  sessionId: string,
  opts: { now?: Date } = {}
): Promise<CreditSession> {
  const session = await creditSessionsRepository.connect(sessionId, opts);
  log.info({ sessionId, status: session.status }, 'Session connected (system)');
  return session;
}

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

  // BAL-466 (F1, review fix round) — a `'presence'` session's `pending → active` transition is
  // driven ONLY by the Daily co-presence webhook, via `connectSessionAsSystem` from
  // `presence-writer.ts`. This ACTOR-facing wrapper's only gate is CONSUME_CREDITS (any live
  // company member), and until this PR no `'presence'` session existed, so it was never taught
  // to refuse one. Connecting early — before real co-presence — starts the meter ahead of the
  // Q1 no-refund clamp, permanently overcharging for minutes nobody was actually on the call for.
  if (auth.session.durationSource === 'presence') {
    log.warn(
      { sessionId, userId },
      'Session actor denied — presence-sourced session is connected by the system only'
    );
    return { ok: false, code: 'forbidden' };
  }

  const session = await connectSessionAsSystem(sessionId, opts);
  log.info({ sessionId, userId, status: session.status }, 'Session connected');
  return { ok: true, session };
}
