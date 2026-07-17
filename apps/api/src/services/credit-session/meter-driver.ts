/**
 * BAL-378 (ADR-1040 Lane 2) — the single-authority metering driver.
 *
 * `driveSession` posts the missing `session_consume` ticks via the authoritative repo
 * primitive (`meterSessionToNow`) and then publishes notifications + analytics for the
 * NEWLY-crossed transitions ONLY. A re-meter that crosses nothing publishes nothing (the repo
 * returns an empty transition set), so notices/analytics never double-fire on idempotent
 * replays. This is the ONLY place transition notices are published (the reaper calls it).
 */
import {
  creditSessionsRepository,
  creditWalletsRepository,
  type MeterSessionResult,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  publishGraceEntered,
  publishLowBalance,
  publishNearWrap,
  trackCeilingHit,
} from './notify.js';

const log = createLogger('credit-session');

/**
 * Meter a session to `now` and publish on the newly-crossed transitions. Returns the repo
 * result so callers (the reaper, `endSession`) can read the advanced session/state.
 */
export async function driveSession(sessionId: string, now: Date): Promise<MeterSessionResult> {
  const result = await creditSessionsRepository.meterSessionToNow(sessionId, now);
  const { session, transitions } = result;

  const hasTransition =
    transitions.low === true ||
    transitions.graceEntered === true ||
    transitions.nearWrap === true ||
    transitions.ceilingHit === true;
  if (!hasTransition) {
    return result;
  }

  // A transition fired — read the live balance once to size the notices/analytics.
  const wallet = await creditWalletsRepository.findById(session.walletId);
  const balanceMinor = wallet?.balanceMinor ?? 0;

  if (transitions.low === true) {
    await publishLowBalance(session, balanceMinor);
  }
  if (transitions.graceEntered === true) {
    await publishGraceEntered(session, balanceMinor, now);
  }
  if (transitions.nearWrap === true) {
    await publishNearWrap(session, now);
  }
  if (transitions.ceilingHit === true) {
    trackCeilingHit(session, balanceMinor);
  }

  log.info(
    {
      sessionId,
      ticksPosted: result.ticksPosted,
      low: transitions.low === true,
      graceEntered: transitions.graceEntered === true,
      nearWrap: transitions.nearWrap === true,
      wrapped: transitions.wrapped === true,
      ceilingHit: transitions.ceilingHit === true,
    },
    'Metered session — published transition notices'
  );

  return result;
}
