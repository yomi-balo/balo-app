/**
 * BAL-649 — the Call now routes' rate limits. Enforced with `enforceBookingRateLimit`
 * (`routes/meetings/guards.ts`), which FAILS CLOSED with a 503 when Redis is unreachable: ringing
 * someone is a write that interrupts a person, so an outage must not become an unmetered ring.
 *
 * Separate buckets: starting a ring is the expensive, intrusive act (a meeting, a Daily room,
 * a notification) and gets the tighter ceilings — one per CALLER and one per (CALLEE, calling
 * party), so a company's members cannot together ring one person past it; declining, stopping and
 * answering are the callee's or caller's reply to a ring that already exists and must stay available
 * to a person who is being rung repeatedly (an answer is a read plus one join); the read view is
 * generous but metered, so it cannot be polled as a "who is on a call right now" probe.
 *
 * The decline cooldown is NOT here: it is a gate read from Postgres (`recently_declined`).
 */
import { createLogger } from '@balo/shared/logging';
import { getRedis } from '../../lib/redis.js';
import {
  RATE_LIMIT_DEADLINE_MS,
  releaseRateLimitSlot,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { withDeadline } from '../../lib/with-deadline.js';
import type { CallNowCallingParty } from '../../services/call-now/start-call.js';

const log = createLogger('call-now-guards');

const TEN_MINUTES_SECONDS = 600;

/** `POST /cases/:engagementId/call-now`, per user. */
export const CALL_NOW_START_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:call-now-start',
  maxRequests: 10,
  windowSeconds: TEN_MINUTES_SECONDS,
};

/** `POST /call-now/rings/:ringId/decline`, `/stop` and `/answer`, per user. */
export const CALL_NOW_RING_ACTION_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:call-now-ring',
  maxRequests: 30,
  windowSeconds: TEN_MINUTES_SECONDS,
};

/**
 * Rings TO one callee FROM one calling party, keyed by {@link calleeRateLimitIdentifier}. ≤ 6 per
 * 10 minutes: each ring interrupts a person (and becomes an SMS once BAL-652 lands). Keyed per
 * calling party, not per callee alone, so one company's members cannot exhaust a callee's budget
 * for every other party that may ring them.
 */
export const CALL_NOW_CALLEE_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:call-now-callee',
  maxRequests: 6,
  windowSeconds: TEN_MINUTES_SECONDS,
};

/**
 * The {@link CALL_NOW_CALLEE_RATE_LIMIT} identifier: the callee plus the calling party — the
 * caller's company for a client caller, the delivering expert's profile for an expert caller.
 */
export function calleeRateLimitIdentifier(
  calleeUserId: string,
  callingParty: CallNowCallingParty
): string {
  return `${calleeUserId}:${callingParty.kind}:${callingParty.id}`;
}

/**
 * Give back the {@link CALL_NOW_CALLEE_RATE_LIMIT} slot a start spent on a ring the callee was
 * never shown (its room could not be provisioned): that is not a ring the caller made. Best-effort
 * and never throws — a slot that is not given back only expires with its window.
 */
export async function releaseCalleeRateLimitSlot(
  calleeUserId: string,
  callingParty: CallNowCallingParty
): Promise<void> {
  try {
    await withDeadline(
      () =>
        releaseRateLimitSlot(
          getRedis(),
          CALL_NOW_CALLEE_RATE_LIMIT,
          calleeRateLimitIdentifier(calleeUserId, callingParty)
        ),
      { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: 'release call-now callee slot' }
    );
  } catch (error) {
    log.warn(
      {
        keyPrefix: CALL_NOW_CALLEE_RATE_LIMIT.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
      },
      'Call now callee rate-limit slot could not be given back — it expires with its window'
    );
  }
}

/** `GET /cases/:engagementId/call-now`, per user. Generous: the case page reads it on render. */
export const CALL_NOW_VIEW_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'ratelimit:call-now-view',
  maxRequests: 120,
  windowSeconds: TEN_MINUTES_SECONDS,
};
