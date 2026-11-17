/**
 * BAL-652 — WHETHER A RING ALSO REACHES THE CALLEE BY SMS.
 *
 * Decided once, synchronously, in `startCallNow` before the ring row is written: the answer sets
 * the ring's `reachedBy` and with it the ring window (120 s with SMS, 45 s without). The SMS
 * itself is sent later by the `call.ringing` rule, and only when `reachedBy` is `sms`.
 *
 * ⚠ THE DAILY CAP IS CONSUMED LAST, only for a callee who passed every other check, so a ring that
 * could never have sent an SMS never spends a slot. It is checked here and nowhere else: the SMS
 * job re-running on a BullMQ retry must not spend a second slot.
 */
import type { MeetingRing } from '@balo/db';
import { usersRepository } from '@balo/db';
import { CALL_NOW_SERVER_EVENTS, trackServer } from '@balo/analytics/server';
import { createLogger } from '@balo/shared/logging';
import { canonicalTimezone } from '@balo/shared/timezone';
import {
  isWithinCallHours,
  type CallSide,
  type CallSmsSuppressReason,
} from '@balo/shared/meetings';
import { getRedis } from '../../lib/redis.js';
import {
  checkRateLimit,
  RATE_LIMIT_DEADLINE_MS,
  releaseRateLimitSlot,
  type RateLimitConfig,
} from '../../lib/rate-limiter.js';
import { withDeadline } from '../../lib/with-deadline.js';

const log = createLogger('call-now-sms-reach');

/** Ring SMS per (caller, callee) in a rolling day. */
export const CALL_NOW_SMS_CAP: RateLimitConfig = {
  keyPrefix: 'ratelimit:call-now-sms',
  maxRequests: 3,
  windowSeconds: 86_400,
};

export type CallReachDecision =
  | { reachedBy: 'sms' }
  | { reachedBy: 'app'; suppressedBy: CallSmsSuppressReason | null };

export interface SmsEligibilityFacts {
  calleeSide: CallSide;
  consent:
    | { phone: string | null; phoneVerifiedAt: Date | null; clientSmsOptedInAt: Date | null }
    | undefined;
  calleeOnline: boolean;
  withinCallHours: boolean;
}

export type SmsEligibility =
  | { eligible: true }
  | { eligible: false; reason: Exclude<CallSmsSuppressReason, 'cap'> };

/**
 * Every check but the cap, in report order: the first failing check is the reason. Experts are
 * reached by default once they have a verified number; clients must also have opted in.
 */
export function smsEligibility(facts: SmsEligibilityFacts): SmsEligibility {
  const { consent } = facts;
  if (consent === undefined || consent.phone === null || consent.phoneVerifiedAt === null) {
    return { eligible: false, reason: 'no_number' };
  }
  if (facts.calleeSide === 'client' && consent.clientSmsOptedInAt === null) {
    return { eligible: false, reason: 'not_opted_in' };
  }
  if (facts.calleeOnline) {
    return { eligible: false, reason: 'active_in_app' };
  }
  if (!facts.withinCallHours) {
    return { eligible: false, reason: 'outside_hours' };
  }
  return { eligible: true };
}

/** A zone that names no place: any UTC spelling (`GMT`, `Etc/UTC`, `Zulu`…) or an unparseable one. */
function isUnknownZone(timeZone: string): boolean {
  const canonical = canonicalTimezone(timeZone);
  return canonical === null || canonical === 'UTC';
}

/**
 * Is the callee inside the hours an SMS may arrive? A CLIENT whose zone reads as UTC is treated as
 * an unknown zone and never inside hours: `resolve-callee` falls back to `'UTC'` for a client with
 * no stored timezone, and 12:00 UTC says nothing about where that person is. This is the same
 * convention `recipientDisplayZone` applies to email. An expert's UTC zone is taken at face value.
 */
function isInsideSmsHours(now: Date, timeZone: string, calleeSide: CallSide): boolean {
  if (calleeSide === 'client' && isUnknownZone(timeZone)) {
    return false;
  }
  return isWithinCallHours(now, timeZone);
}

function capIdentifier(callerUserId: string, calleeUserId: string): string {
  return `${callerUserId}:${calleeUserId}`;
}

export interface ResolveCallReachInput {
  callerUserId: string;
  callee: { userId: string; timeZone: string };
  calleeSide: CallSide;
  calleeOnline: boolean;
  now: Date;
}

export async function resolveCallReach(input: ResolveCallReachInput): Promise<CallReachDecision> {
  const { callerUserId, callee, calleeSide, calleeOnline, now } = input;
  let consent: SmsEligibilityFacts['consent'];
  try {
    consent = await usersRepository.findClientSmsConsent(callee.userId);
  } catch (error) {
    log.warn(
      {
        calleeUserId: callee.userId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Call now SMS consent read failed — ringing in app only'
    );
    return { reachedBy: 'app', suppressedBy: null };
  }
  const eligibility = smsEligibility({
    calleeSide,
    consent,
    calleeOnline,
    withinCallHours: isInsideSmsHours(now, callee.timeZone, calleeSide),
  });
  if (!eligibility.eligible) {
    return { reachedBy: 'app', suppressedBy: eligibility.reason };
  }

  try {
    const result = await withDeadline(
      () =>
        checkRateLimit(getRedis(), CALL_NOW_SMS_CAP, capIdentifier(callerUserId, callee.userId)),
      { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: 'call-now sms cap' }
    );
    return result.allowed ? { reachedBy: 'sms' } : { reachedBy: 'app', suppressedBy: 'cap' };
  } catch (error) {
    log.warn(
      {
        keyPrefix: CALL_NOW_SMS_CAP.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
      },
      'Call now SMS cap check failed — ringing in app only'
    );
    return { reachedBy: 'app', suppressedBy: null };
  }
}

/**
 * Give back the cap slot a start spent on a ring that was never written. Best-effort and never
 * throws: a slot that is not given back only expires with its window.
 */
export async function releaseCallSmsSlot(
  callerUserId: string,
  calleeUserId: string
): Promise<void> {
  try {
    await withDeadline(
      () =>
        releaseRateLimitSlot(
          getRedis(),
          CALL_NOW_SMS_CAP,
          capIdentifier(callerUserId, calleeUserId)
        ),
      { deadlineMs: RATE_LIMIT_DEADLINE_MS, label: 'release call-now sms slot' }
    );
  } catch (error) {
    log.warn(
      {
        keyPrefix: CALL_NOW_SMS_CAP.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
      },
      'Call now SMS cap slot could not be given back — it expires with its window'
    );
  }
}

/** `call_sms_suppressed`, once per ring written as `app` with a reason. Never throws. */
export function trackCallSmsSuppressed(ring: MeetingRing, reason: CallSmsSuppressReason): void {
  try {
    trackServer(CALL_NOW_SERVER_EVENTS.SMS_SUPPRESSED, {
      audience: ring.callerSide === 'client' ? 'expert' : 'client',
      ring_id: ring.id,
      reason,
      distinct_id: ring.callerUserId,
    });
  } catch (error) {
    log.warn(
      { ringId: ring.id, error: error instanceof Error ? error.message : String(error) },
      'Failed to track call_sms_suppressed'
    );
  }
}
