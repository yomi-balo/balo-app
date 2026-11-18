import { CALL_NOW_SCHEDULED_MINUTES } from '@balo/shared/meetings';
import type { CallNowFundingGateReason } from '@balo/analytics/events';
import type { BookingFundingRequest } from '@/lib/booking/actions/booking-funding-types';
import type { CallNowFundingCode } from './call-now-types';

/**
 * The funding pre-flight request for a call that starts now: the exact window the server checks
 * (the 15-minute minimum from `nowMs`), against the case the call belongs to. Built once when the
 * funding step opens so `useBookingFunding`'s request key stays stable.
 */
export function callNowFundingRequest(input: {
  expertProfileId: string;
  engagementId: string;
  nowMs: number;
}): BookingFundingRequest {
  const { expertProfileId, engagementId, nowMs } = input;
  return {
    expertProfileId,
    slot: {
      startIso: new Date(nowMs).toISOString(),
      endIso: new Date(nowMs + CALL_NOW_SCHEDULED_MINUTES * 60_000).toISOString(),
      durationMinutes: CALL_NOW_SCHEDULED_MINUTES,
    },
    caseChoice: { kind: 'existing', engagementId },
  };
}

const GATE_REASONS: Readonly<Record<CallNowFundingCode, CallNowFundingGateReason>> = {
  account_on_hold: 'account_on_hold',
  booking_unfunded: 'insufficient',
  booking_reserved: 'reserved_by_upcoming',
};

/** The analytics reason for the api's funding refusal code. */
export function fundingGateReason(code: CallNowFundingCode): CallNowFundingGateReason {
  return GATE_REASONS[code];
}

const FUNDING_CODES: ReadonlySet<string> = new Set(Object.keys(GATE_REASONS));

/** Whether an api error literal is one of the three funding refusals. */
export function isCallNowFundingCode(code: string): code is CallNowFundingCode {
  return FUNDING_CODES.has(code);
}
