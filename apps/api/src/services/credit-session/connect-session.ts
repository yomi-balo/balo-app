/**
 * BAL-378 (ADR-1040 Lane 2) — `connectSession`: authorize the actor against the session's
 * company (fail-closed), then pending → active (idempotent on already-active). No money, no
 * wallet lock.
 *
 * ⚠ THE CLIENT DOES NOT FIRE `session_started`. The only production render of `InSessionPanel` is
 * `variant="embedded"`, whose `expertProfileId` is typed `never`, so its effect always early-returns. The event
 * fires SERVER-SIDE as `SESSION_SERVER_EVENTS.SESSION_STARTED`, at the real connect seam
 * (`services/credit-session/start-billing.ts`, the BAL-474 Rule A start-billing seam), and only for the caller
 * that performed `pending → active`.
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
 * ⚠ `transitioned` IS `true` ONLY FOR THE CALL THAT PERFORMED `pending → active` (R6F-6). Two callers can
 * race to connect (the presence writer and the meter sweep's billing-start pass); the second gets the already-
 * active row back with `transitioned: false`, and must not emit `session_started`, log "Billing started" or
 * count a start.
 *
 * ⚠⚠ **SYSTEM-ONLY. NEVER CALL THIS FROM A ROUTE** — the same warning `endSessionAsSystem` and
 * `settleSessionFromPresence` carry, for the same reason: it performs NO ACTOR AUTHORIZATION.
 * Its ONE presence caller is `start-billing.ts` (BAL-474 Rule A), which the presence writer and the meter
 * sweep drive, and which has no acting human by construction. It is never called before the meeting's
 * scheduled start. A route reaching it would let any caller who can name a `sessionId` start a victim's meter.
 * Route-facing connect goes through {@link connectSession}, which authorizes the actor.
 *
 * ⚠ IT THROWS. `SessionNotFoundError` / `InvalidSessionTransitionError` propagate exactly as
 * they do from `connectSession`; the caller decides. `start-billing.ts` treats the transition error as an
 * expected race and contains every other failure, because a webhook must not fail on a metering fault.
 */
export async function connectSessionAsSystem(
  sessionId: string,
  opts: { now?: Date } = {}
): Promise<{ readonly session: CreditSession; readonly transitioned: boolean }> {
  const result = await creditSessionsRepository.connectWithTransition(sessionId, opts);
  log.info(
    { sessionId, status: result.session.status, transitioned: result.transitioned },
    'Session connected (system)'
  );
  return result;
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

  // A `'presence'` session's `pending → active` transition is driven ONLY by the start-billing seam
  // (`start-billing.ts`, called by the presence writer and the meter sweep) via `connectSessionAsSystem`.
  // This ACTOR-facing wrapper's only gate is CONSUME_CREDITS (any live company member), so it refuses a
  // presence session: connecting early — before real co-presence — starts the meter ahead of the Q1
  // no-refund clamp, permanently overcharging for minutes nobody was actually on the call for.
  if (auth.session.durationSource === 'presence') {
    log.warn(
      { sessionId, userId },
      'Session actor denied — presence-sourced session is connected by the system only'
    );
    return { ok: false, code: 'forbidden' };
  }

  const { session } = await connectSessionAsSystem(sessionId, opts);
  log.info({ sessionId, userId, status: session.status }, 'Session connected');
  return { ok: true, session };
}
