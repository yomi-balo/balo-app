import { describe, expect, it } from 'vitest';
import { callNowFundingRequest, fundingGateReason, isCallNowFundingCode } from './call-now-funding';

describe('callNowFundingRequest', () => {
  it('is the 15-minute window from now, on the existing case', () => {
    const nowMs = Date.UTC(2026, 10, 19, 4, 0, 0);
    expect(
      callNowFundingRequest({ expertProfileId: 'ep-1', engagementId: 'eng-1', nowMs })
    ).toEqual({
      expertProfileId: 'ep-1',
      slot: {
        startIso: '2026-11-19T04:00:00.000Z',
        endIso: '2026-11-19T04:15:00.000Z',
        durationMinutes: 15,
      },
      caseChoice: { kind: 'existing', engagementId: 'eng-1' },
    });
  });
});

describe('callNowFundingRequest ringId', () => {
  const base = { expertProfileId: 'ep-1', engagementId: 'eng-1', nowMs: 0 };

  it('carries the ring id for the server to resolve, never a meeting id', () => {
    const request = callNowFundingRequest({ ...base, ringId: 'r-1' });
    expect(request.ringId).toBe('r-1');
    expect(request).not.toHaveProperty('excludeMeetingId');
  });

  it('omits the key entirely when there is none', () => {
    expect(callNowFundingRequest(base)).not.toHaveProperty('ringId');
  });
});

describe('fundingGateReason', () => {
  it.each([
    ['account_on_hold', 'account_on_hold'],
    ['booking_unfunded', 'insufficient'],
    ['booking_reserved', 'reserved_by_upcoming'],
  ] as const)('maps %s to %s', (code, reason) => {
    expect(fundingGateReason(code)).toBe(reason);
  });
});

describe('isCallNowFundingCode', () => {
  it('accepts exactly the three funding refusals', () => {
    expect(isCallNowFundingCode('booking_unfunded')).toBe(true);
    expect(isCallNowFundingCode('booking_funding_unavailable')).toBe(false);
    expect(isCallNowFundingCode('call_now_unavailable')).toBe(false);
  });
});
