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
  type MeterTransitions,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { resolveBillingFloorMinutes } from '../../config/billing-floor.js';
import {
  publishGraceEntered,
  publishLowBalance,
  publishNearWrap,
  trackCeilingHit,
} from './notify.js';

const log = createLogger('credit-session');

type CapReached = NonNullable<MeterTransitions['maxSessionMinutesReached']>;

/**
 * Logged once, on the run that first lands the meter on `MAX_SESSION_MINUTES`. It is an error when
 * the cap was reached abnormally (a presence meeting still running past its scheduled end, or a
 * live_capture backfill more than one sweep late) and a warning when a legitimate long booking or a
 * one-sweep delay reached it.
 */
function logCapReached(
  sessionId: string,
  durationSource: string,
  { withheldTicks, pastScheduledEnd }: CapReached
): void {
  const context = { sessionId, durationSource, withheldTicks, pastScheduledEnd };
  const abnormal =
    (durationSource === 'presence' && pastScheduledEnd === true) ||
    (durationSource === 'live_capture' && withheldTicks > 1);
  if (abnormal) {
    log.error(
      context,
      "Session meter reached MAX_SESSION_MINUTES abnormally — no further ticks are drawn; a presence session's meeting ends via the lifecycle sweep's overrun_stop rule"
    );
    return;
  }
  log.warn(
    context,
    'Session reached the billable cap within its booking or one sweep late — no further ticks are drawn'
  );
}

/**
 * Meter a session to `now` and publish on the newly-crossed transitions. Returns the repo
 * result so callers (the reaper, `endSession`) can read the advanced session/state.
 */
export async function driveSession(sessionId: string, now: Date): Promise<MeterSessionResult> {
  // BAL-412 (F13/D6) — the billing floor is INJECTED into the metering primitive because
  // `@balo/db` reads no env. It must be the SAME value `publishLowBalance` uses to SIZE the
  // notice (`notify.ts`), or the threshold that fires and the figure reported would disagree —
  // which is precisely the split brain F13 closed. Both read `resolveBillingFloorMinutes()`.
  const result = await creditSessionsRepository.meterSessionToNow(sessionId, now, {
    floorMinutes: resolveBillingFloorMinutes(),
  });
  const { session, transitions } = result;

  if (transitions.maxSessionMinutesReached !== undefined) {
    logCapReached(sessionId, session.durationSource, transitions.maxSessionMinutesReached);
  }

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
