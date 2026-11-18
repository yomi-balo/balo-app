import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findConsent: vi.fn(),
  checkRateLimit: vi.fn(),
  releaseSlot: vi.fn(),
  trackServer: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({ usersRepository: { findClientSmsConsent: mocks.findConsent } }));
vi.mock('@balo/analytics/server', () => ({
  CALL_NOW_SERVER_EVENTS: { SMS_SUPPRESSED: 'call_sms_suppressed' },
  trackServer: mocks.trackServer,
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({ tag: 'redis' }) }));
vi.mock('../../lib/rate-limiter.js', () => ({
  RATE_LIMIT_DEADLINE_MS: 2000,
  checkRateLimit: mocks.checkRateLimit,
  releaseRateLimitSlot: mocks.releaseSlot,
}));

import type { MeetingRing } from '@balo/db';
import {
  CALL_NOW_SMS_CAP,
  releaseCallSmsSlot,
  resolveCallReach,
  smsEligibility,
  trackCallSmsSuppressed,
  type SmsEligibilityFacts,
} from './sms-reach.js';

const CALLER = '11111111-1111-4111-8111-111111111111';
const CALLEE = '22222222-2222-4222-8222-222222222222';
/** 10:00 in Sydney (UTC+11). */
const IN_HOURS = new Date('2026-11-17T23:00:00.000Z');
const OUT_OF_HOURS = new Date('2026-11-18T10:30:00.000Z');
const VERIFIED = new Date('2026-01-01T00:00:00.000Z');
const PHONE = '+61400000000';

const FULL_CONSENT = { phone: PHONE, phoneVerifiedAt: VERIFIED, clientSmsOptedInAt: VERIFIED };
const NO_OPT_IN = { phone: PHONE, phoneVerifiedAt: VERIFIED, clientSmsOptedInAt: null };

function facts(overrides: Partial<SmsEligibilityFacts> = {}): SmsEligibilityFacts {
  return {
    calleeSide: 'expert',
    consent: NO_OPT_IN,
    calleeOnline: false,
    withinCallHours: true,
    ...overrides,
  };
}

describe('smsEligibility', () => {
  it('an expert with a verified phone and no consent timestamp is eligible', () => {
    expect(smsEligibility(facts())).toEqual({ eligible: true });
  });

  it('a client who opted in is eligible', () => {
    expect(smsEligibility(facts({ calleeSide: 'client', consent: FULL_CONSENT }))).toEqual({
      eligible: true,
    });
  });

  it.each([
    ['no consent row', undefined],
    ['no phone', { phone: null, phoneVerifiedAt: VERIFIED, clientSmsOptedInAt: null }],
    ['an unverified phone', { phone: PHONE, phoneVerifiedAt: null, clientSmsOptedInAt: null }],
  ])('%s → no_number', (_label, consent) => {
    expect(smsEligibility(facts({ consent }))).toEqual({ eligible: false, reason: 'no_number' });
  });

  it('a client who has not opted in → not_opted_in', () => {
    expect(smsEligibility(facts({ calleeSide: 'client', consent: NO_OPT_IN }))).toEqual({
      eligible: false,
      reason: 'not_opted_in',
    });
  });

  it('an online callee → active_in_app', () => {
    expect(smsEligibility(facts({ calleeOnline: true }))).toEqual({
      eligible: false,
      reason: 'active_in_app',
    });
  });

  it('outside the callee’s hours → outside_hours', () => {
    expect(smsEligibility(facts({ withinCallHours: false }))).toEqual({
      eligible: false,
      reason: 'outside_hours',
    });
  });

  it('reports the first failing check, in order', () => {
    const all = facts({
      calleeSide: 'client',
      consent: undefined,
      calleeOnline: true,
      withinCallHours: false,
    });

    expect(smsEligibility(all)).toEqual({ eligible: false, reason: 'no_number' });
    expect(smsEligibility({ ...all, consent: NO_OPT_IN })).toEqual({
      eligible: false,
      reason: 'not_opted_in',
    });
    expect(smsEligibility({ ...all, consent: FULL_CONSENT })).toEqual({
      eligible: false,
      reason: 'active_in_app',
    });
    expect(smsEligibility({ ...all, consent: FULL_CONSENT, calleeOnline: false })).toEqual({
      eligible: false,
      reason: 'outside_hours',
    });
  });
});

describe('resolveCallReach', () => {
  const callee = { userId: CALLEE, timeZone: 'Australia/Sydney' };

  function resolve(overrides: Record<string, unknown> = {}) {
    return resolveCallReach({
      callerUserId: CALLER,
      callee,
      calleeSide: 'expert',
      calleeOnline: false,
      now: IN_HOURS,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findConsent.mockResolvedValue(FULL_CONSENT);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 100 });
    mocks.releaseSlot.mockResolvedValue(undefined);
  });

  it('an eligible callee under the cap → sms, spending one slot keyed on the pair', async () => {
    await expect(resolve()).resolves.toEqual({ reachedBy: 'sms' });
    expect(mocks.findConsent).toHaveBeenCalledWith(CALLEE);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      { tag: 'redis' },
      CALL_NOW_SMS_CAP,
      `${CALLER}:${CALLEE}`
    );
  });

  it('the cap is 3 per fixed 24 h window', () => {
    expect(CALL_NOW_SMS_CAP).toMatchObject({ maxRequests: 3, windowSeconds: 86_400 });
  });

  it('an expert callee with a verified phone and no consent timestamp is reached', async () => {
    mocks.findConsent.mockResolvedValue(NO_OPT_IN);

    await expect(resolve()).resolves.toEqual({ reachedBy: 'sms' });
  });

  it('a client callee who has not opted in → not_opted_in, cap untouched', async () => {
    mocks.findConsent.mockResolvedValue(NO_OPT_IN);

    await expect(resolve({ calleeSide: 'client' })).resolves.toEqual({
      reachedBy: 'app',
      suppressedBy: 'not_opted_in',
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('no number → no_number, cap untouched', async () => {
    mocks.findConsent.mockResolvedValue(undefined);

    await expect(resolve()).resolves.toEqual({ reachedBy: 'app', suppressedBy: 'no_number' });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('an online callee → active_in_app, cap untouched', async () => {
    await expect(resolve({ calleeOnline: true })).resolves.toEqual({
      reachedBy: 'app',
      suppressedBy: 'active_in_app',
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('outside the callee’s zone hours → outside_hours, cap untouched', async () => {
    await expect(resolve({ now: OUT_OF_HOURS })).resolves.toEqual({
      reachedBy: 'app',
      suppressedBy: 'outside_hours',
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('an unusable callee zone fails closed on hours', async () => {
    await expect(resolve({ callee: { userId: CALLEE, timeZone: 'Not/AZone' } })).resolves.toEqual({
      reachedBy: 'app',
      suppressedBy: 'outside_hours',
    });
  });

  describe('a client on a UTC zone', () => {
    const NOON_UTC = new Date('2026-11-17T12:00:00.000Z');

    it.each(['UTC', 'Etc/UTC', 'GMT', 'Etc/Universal', 'Not/AZone'])(
      '%s is an unknown zone → outside_hours, cap untouched',
      async (tz) => {
        mocks.findConsent.mockResolvedValue(FULL_CONSENT);

        await expect(
          resolve({ calleeSide: 'client', callee: { userId: CALLEE, timeZone: tz }, now: NOON_UTC })
        ).resolves.toEqual({ reachedBy: 'app', suppressedBy: 'outside_hours' });
        expect(mocks.checkRateLimit).not.toHaveBeenCalled();
      }
    );

    it('a client on a real zone inside hours is eligible', async () => {
      mocks.findConsent.mockResolvedValue(FULL_CONSENT);

      await expect(
        resolve({
          calleeSide: 'client',
          callee: { userId: CALLEE, timeZone: 'Australia/Melbourne' },
          now: IN_HOURS,
        })
      ).resolves.toEqual({ reachedBy: 'sms' });
    });

    it('an expert on UTC at 12:00 UTC is unchanged — reached', async () => {
      await expect(
        resolve({
          calleeSide: 'expert',
          callee: { userId: CALLEE, timeZone: 'UTC' },
          now: NOON_UTC,
        })
      ).resolves.toEqual({ reachedBy: 'sms' });
    });
  });

  it('a spent cap → cap', async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, current: 4, ttlSeconds: 100 });

    await expect(resolve()).resolves.toEqual({ reachedBy: 'app', suppressedBy: 'cap' });
  });

  it('a Redis error rings in app only, with no suppression reason, and warns', async () => {
    mocks.checkRateLimit.mockRejectedValue(new Error('redis down'));

    await expect(resolve()).resolves.toEqual({ reachedBy: 'app', suppressedBy: null });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'redis down' }),
      'Call now SMS cap check failed — ringing in app only'
    );
  });

  it('a failed consent read rings in app only, with no suppression reason, and warns', async () => {
    mocks.findConsent.mockRejectedValue(new Error('db down'));

    await expect(resolve()).resolves.toEqual({ reachedBy: 'app', suppressedBy: null });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ calleeUserId: CALLEE, error: 'db down' }),
      'Call now SMS consent read failed — ringing in app only'
    );
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('releaseCallSmsSlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the pair’s slot back', async () => {
    mocks.releaseSlot.mockResolvedValue(undefined);

    await releaseCallSmsSlot(CALLER, CALLEE);

    expect(mocks.releaseSlot).toHaveBeenCalledWith(
      { tag: 'redis' },
      CALL_NOW_SMS_CAP,
      `${CALLER}:${CALLEE}`
    );
  });

  it('never throws — a failed release warns', async () => {
    mocks.releaseSlot.mockRejectedValue(new Error('redis down'));

    await expect(releaseCallSmsSlot(CALLER, CALLEE)).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'redis down' }),
      expect.stringContaining('could not be given back')
    );
  });
});

describe('trackCallSmsSuppressed', () => {
  const ring = {
    id: 'ring-1',
    callerUserId: CALLER,
    calleeUserId: CALLEE,
    callerSide: 'client',
  } as unknown as MeetingRing;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the reason with the callee’s audience and the caller as distinct id', () => {
    trackCallSmsSuppressed(ring, 'cap');

    expect(mocks.trackServer).toHaveBeenCalledWith('call_sms_suppressed', {
      audience: 'expert',
      ring_id: 'ring-1',
      reason: 'cap',
      distinct_id: CALLER,
    });
  });

  it('an expert caller’s ring is for a client audience', () => {
    trackCallSmsSuppressed({ ...ring, callerSide: 'expert' } as MeetingRing, 'no_number');

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_sms_suppressed',
      expect.objectContaining({ audience: 'client' })
    );
  });

  it('never throws', () => {
    mocks.trackServer.mockImplementation(() => {
      throw new Error('posthog down');
    });

    expect(() => trackCallSmsSuppressed(ring, 'cap')).not.toThrow();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: 'ring-1', error: 'posthog down' }),
      'Failed to track call_sms_suppressed'
    );
  });
});
