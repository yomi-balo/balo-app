import { randomUUID } from 'node:crypto';
import { meetingRingsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { RuleContext } from '../engine/rules.js';
import type { CallMissedEmailDuePayload } from '../events.js';
import { scheduleNotification } from './schedule.js';
import type { ScheduledRecheck } from './rechecks.js';

const log = createLogger('call-missed-email');

/**
 * BAL-652 — the delayed missed-call EMAIL. The bell item is immediate (a `call.no_answer` rule);
 * only the email waits, so a burst of missed rings from one person folds into one message and a
 * callback inside the window cancels it.
 *
 * ⚠ `first_wins` on a key naming only the (caller, callee) pair: the window is anchored on the
 * FIRST missed ring and later misses fold into the same promise. The recheck rebuilds the count,
 * the latest case and the latest instant from live state at fire time.
 *
 * ⚠ THE RECHECK IS THE AUTHORITY, NOT THE KEY. The dedup folds on `status = 'pending'` only, so
 * between a claim and its terminal mark a second promise can be inserted; the guard is what keeps
 * a stale or already-answered miss from sending.
 */

/** Dedup + cancel handle: one pending promise per (caller, callee). */
export function callMissedKey(callerUserId: string, calleeUserId: string): string {
  return `call-missed:${callerUserId}:${calleeUserId}`;
}

/** The collapse window: ten minutes from the first missed ring. */
export const CALL_MISSED_EMAIL_DELAY_MS = 10 * 60 * 1000;

/** The registry key under which {@link callMissedEmailRecheck} is registered. */
export const CALL_MISSED_EMAIL_RECHECK = 'call_missed_email';

/** A string field off an untyped payload, or `undefined`. */
function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `'client'`/`'expert'` off an untyped payload, or `undefined`. */
function readSide(payload: Record<string, unknown>): 'client' | 'expert' | undefined {
  const side = payload.callerSide;
  return side === 'client' || side === 'expert' ? side : undefined;
}

/**
 * Schedule the email promise from one `call.no_answer` event. Malformed → a warn and nothing
 * scheduled. Called by the worker's follow-up hook after the immediate rules have dispatched.
 */
export async function scheduleMissedCallEmailFromContext(ctx: RuleContext): Promise<void> {
  const callerUserId = readString(ctx.payload, 'callerUserId');
  const calleeUserId = readString(ctx.payload, 'calleeUserId');
  const engagementId = readString(ctx.payload, 'engagementId');
  const startedAt = readString(ctx.payload, 'startedAt');
  const callerSide = readSide(ctx.payload);

  if (
    callerUserId === undefined ||
    calleeUserId === undefined ||
    engagementId === undefined ||
    startedAt === undefined ||
    callerSide === undefined
  ) {
    log.warn(
      { event: ctx.event, ringId: ctx.payload.ringId },
      'Missed-call email not scheduled — incomplete ring payload'
    );
    return;
  }

  const payload: CallMissedEmailDuePayload = {
    // An occurrence id minted per promise, NOT the (caller, callee) pair: a pair-stable value would
    // collide with its own earlier send in the shared queue's completed set and drop a later email.
    // `first_wins` discards the uuid of a folded schedule, so there is one uuid per row.
    correlationId: randomUUID(),
    callerUserId,
    calleeUserId,
    callerSide,
    engagementId,
    firstMissedAtIso: startedAt,
    lastMissedAtIso: startedAt,
    missedCount: 1,
  };

  const { outcome } = await scheduleNotification('call.missed_email_due', payload, {
    key: callMissedKey(callerUserId, calleeUserId),
    delayMs: CALL_MISSED_EMAIL_DELAY_MS,
    mode: 'first_wins',
    recheck: CALL_MISSED_EMAIL_RECHECK,
  });

  log.info({ callerUserId, calleeUserId, outcome }, 'Missed-call email scheduled');
}

/**
 * THE FIRE-TIME GUARD. Skips when the call connected in either direction, when the callee chose
 * "Not now", when a ring between the pair is still live, or when no unanswered ring remains in the
 * window; otherwise it publishes with the live count, the latest missed ring's case, caller side
 * and instant.
 *
 * ⚠ A LIVE RING HANDS THE EMAIL TO THAT RING'S OUTCOME. Mailing "you missed a call" while the
 * pair is ringing again would be wrong, so the recheck skips (`ring_live`) and the skip frees the
 * pending slot. If that ring ends unanswered its own `call.no_answer` schedules a fresh email; if
 * it connects, the drop-on-connect rule above holds; if it is declined, the "Not now" rule holds.
 * TWO ACCEPTED LOSSES: the fresh email counts misses from the new ring only, and a live ring that
 * ends `stopped` (the caller hangs up, or the room can't be provisioned) schedules nothing, so the
 * earlier miss gets no email. Its bell item from `call.no_answer` still records it.
 */
export const callMissedEmailRecheck: ScheduledRecheck = async (row) => {
  const callerUserId = readString(row.payload, 'callerUserId');
  const calleeUserId = readString(row.payload, 'calleeUserId');
  const firstMissedAtIso = readString(row.payload, 'firstMissedAtIso');
  const since = firstMissedAtIso === undefined ? undefined : new Date(firstMissedAtIso);
  if (
    callerUserId === undefined ||
    calleeUserId === undefined ||
    since === undefined ||
    Number.isNaN(since.getTime())
  ) {
    return { publish: false, reason: 'malformed_payload' };
  }

  const summary = await meetingRingsRepository.summarizeMissedCallWindow({
    callerUserId,
    calleeUserId,
    since,
    now: new Date(),
  });

  if (summary.connectedSince) {
    return { publish: false, reason: 'connected_before_send' };
  }
  if (summary.calleeDeclinedSince) {
    return { publish: false, reason: 'declined_before_send' };
  }
  if (summary.liveRingBetween) {
    return { publish: false, reason: 'ring_live' };
  }
  if (summary.unansweredCount === 0 || summary.latestUnanswered === null) {
    return { publish: false, reason: 'no_missed_ring' };
  }

  return {
    publish: true,
    payload: {
      // ⚠ SPREAD FIRST — it carries `correlationId`, which the tick re-validates because the
      // publisher derives the BullMQ jobId from it.
      ...row.payload,
      missedCount: summary.unansweredCount,
      engagementId: summary.latestUnanswered.engagementId,
      callerSide: summary.latestUnanswered.callerSide,
      lastMissedAtIso: summary.latestUnanswered.createdAt.toISOString(),
    },
  };
};
