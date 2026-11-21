import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BAL-652 / BAL-651 (R10) — the presence port, end to end through `startCallNow`.
 *
 * `sms-reach.js` is deliberately NOT mocked: only its Redis, rate-limit and consent reads are, so
 * the real eligibility decision runs. The gates are stubbed to ask the injected presence port, so
 * the test proves `deps.presence` reaches the decision and that an online callee is rung in the
 * app and never texted. The shipped default port (`callee-presence.ts`) is unchanged and answers
 * offline for everyone.
 */
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadGates: vi.fn(),
  findRingingForEngagement: vi.fn(),
  startWithNewMeeting: vi.fn(),
  findConsent: vi.fn(),
  checkRateLimit: vi.fn(),
  releaseSlot: vi.fn(),
  provision: vi.fn(),
  enqueueExpiry: vi.fn(),
  enqueueRepings: vi.fn(),
  enqueueRebuild: vi.fn(),
  publish: vi.fn(),
  checkFunding: vi.fn(),
  meterCallee: vi.fn(),
  releaseCallee: vi.fn(),
  trackServer: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  MeetingRingAlreadyLiveError: class extends Error {},
  meetingRingsRepository: {
    findRingingForEngagement: mocks.findRingingForEngagement,
    startWithNewMeeting: mocks.startWithNewMeeting,
    startOnMeeting: vi.fn(),
  },
  usersRepository: { findClientSmsConsent: mocks.findConsent },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mocks.trackServer,
  CALL_NOW_SERVER_EVENTS: {
    RING_ENDED: 'call_now_ring_ended',
    SMS_SUPPRESSED: 'call_sms_suppressed',
    REFUSED: 'call_now_refused',
  },
}));
vi.mock('./authorize-call-now.js', () => ({ authorizeCallNow: mocks.authorize }));
vi.mock('./call-now-gates.js', () => ({ loadCallNowGates: mocks.loadGates }));
vi.mock('./end-ring.js', () => ({ endRing: vi.fn() }));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({ tag: 'redis' }) }));
vi.mock('../../lib/rate-limiter.js', () => ({
  RATE_LIMIT_DEADLINE_MS: 2000,
  checkRateLimit: mocks.checkRateLimit,
  releaseRateLimitSlot: mocks.releaseSlot,
}));
vi.mock('../meetings/case-booking-funding.js', () => ({
  checkCaseBookingFunding: mocks.checkFunding,
}));
vi.mock('../meetings/provision-meeting.js', () => ({ provisionCallNowVenue: mocks.provision }));
vi.mock('../../jobs/call-now-ring-expiry.js', () => ({
  enqueueCallNowRingExpiry: mocks.enqueueExpiry,
}));
vi.mock('../../jobs/call-now-ring-reping.js', () => ({
  enqueueCallNowRingRepings: mocks.enqueueRepings,
}));
vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mocks.enqueueRebuild,
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mocks.publish },
}));

import type { FastifyBaseLogger } from 'fastify';
import { startCallNow } from './start-call.js';
import type { CalleePresence } from './callee-presence.js';

const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const EXPERT_USER = '22222222-2222-4222-8222-222222222222';
const RING_ID = '88888888-8888-4888-8888-888888888888';
const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** 10:00 in Sydney (UTC+11), inside the call hours. */
const NOW = new Date('2026-11-17T23:00:00.000Z');
const VERIFIED = new Date('2026-01-01T00:00:00.000Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
const CASE_ROW = { id: ENGAGEMENT_ID, companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID };

const online: CalleePresence = { isOnline: () => Promise.resolve(true) };
const offline: CalleePresence = { isOnline: () => Promise.resolve(false) };

function writtenRing(reachedBy: string): Record<string, unknown> {
  return {
    id: RING_ID,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    callerUserId: CLIENT,
    calleeUserId: EXPERT_USER,
    callerSide: 'client',
    placement: 'new_meeting',
    status: 'ringing',
    reachedBy,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 45_000),
    endedAt: null,
  };
}

function start(presence: CalleePresence): ReturnType<typeof startCallNow> {
  return startCallNow({
    engagementId: ENGAGEMENT_ID,
    userId: CLIENT,
    now: NOW,
    log,
    meterCallee: mocks.meterCallee,
    releaseCallee: mocks.releaseCallee,
    deps: { presence },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ ok: true, side: 'client', caseRow: CASE_ROW, mayRing: true });
  // The gates ask the injected port, exactly as `loadCallNowGates` does.
  mocks.loadGates.mockImplementation(async (input: { presence: CalleePresence }) => ({
    availability: { canCallNow: true },
    callee: { userId: EXPERT_USER, timeZone: 'Australia/Sydney' },
    calleeOnline: await input.presence.isOnline(EXPERT_USER),
    inPlaceCandidate: null,
  }));
  mocks.findConsent.mockResolvedValue({
    phone: '+61400000000',
    phoneVerifiedAt: VERIFIED,
    clientSmsOptedInAt: null,
  });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.checkFunding.mockResolvedValue({ ok: true });
  mocks.meterCallee.mockResolvedValue(false);
  mocks.releaseCallee.mockResolvedValue(undefined);
  mocks.findRingingForEngagement.mockResolvedValue(undefined);
  mocks.startWithNewMeeting.mockImplementation(async (input: { reachedBy: string }) => ({
    ring: writtenRing(input.reachedBy),
    meeting: { id: MEETING_ID },
    expertProfileId: EXPERT_PROFILE_ID,
  }));
  mocks.provision.mockResolvedValue({ provisioned: true });
  mocks.enqueueExpiry.mockResolvedValue(undefined);
  mocks.enqueueRepings.mockResolvedValue(undefined);
  mocks.enqueueRebuild.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(undefined);
});

describe('startCallNow — an online callee is rung in the app, never texted (BAL-652)', () => {
  it('writes the ring as `app` with the presence the gates read, and tracks call_sms_suppressed{active_in_app}', async () => {
    await expect(start(online)).resolves.toMatchObject({ ok: true, ringId: RING_ID });

    expect(mocks.startWithNewMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ reachedBy: 'app', calleeOnlineAtStart: true })
    );
    expect(mocks.trackServer).toHaveBeenCalledWith('call_sms_suppressed', {
      audience: 'expert',
      ring_id: RING_ID,
      reason: 'active_in_app',
      distinct_id: CLIENT,
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });

  it('control: the same callee offline is reached by SMS and suppresses nothing', async () => {
    await expect(start(offline)).resolves.toMatchObject({ ok: true });

    expect(mocks.startWithNewMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ reachedBy: 'sms', calleeOnlineAtStart: false })
    );
    expect(mocks.trackServer).not.toHaveBeenCalledWith('call_sms_suppressed', expect.anything());
  });
});
