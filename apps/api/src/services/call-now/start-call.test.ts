import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class RingAlreadyLive extends Error {}
  return {
    RingAlreadyLive,
    authorize: vi.fn(),
    loadGates: vi.fn(),
    endRing: vi.fn(),
    findRingingForEngagement: vi.fn(),
    startWithNewMeeting: vi.fn(),
    startOnMeeting: vi.fn(),
    provision: vi.fn(),
    enqueueExpiry: vi.fn(),
    enqueueRebuild: vi.fn(),
    publish: vi.fn(),
    // Things a Call now start must NEVER do (a call in progress is not a booking).
    enqueueProjection: vi.fn(),
    publishInvites: vi.fn(),
    meterCallee: vi.fn(),
    releaseCallee: vi.fn(),
    checkFunding: vi.fn(),
    resolveReach: vi.fn(),
    releaseSmsSlot: vi.fn(),
    trackSuppressed: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  MeetingRingAlreadyLiveError: mocks.RingAlreadyLive,
  meetingRingsRepository: {
    findRingingForEngagement: mocks.findRingingForEngagement,
    startWithNewMeeting: mocks.startWithNewMeeting,
    startOnMeeting: mocks.startOnMeeting,
  },
}));
vi.mock('./authorize-call-now.js', () => ({ authorizeCallNow: mocks.authorize }));
vi.mock('./call-now-gates.js', () => ({ loadCallNowGates: mocks.loadGates }));
vi.mock('./end-ring.js', () => ({ endRing: mocks.endRing }));
vi.mock('./sms-reach.js', () => ({
  resolveCallReach: mocks.resolveReach,
  releaseCallSmsSlot: mocks.releaseSmsSlot,
  trackCallSmsSuppressed: mocks.trackSuppressed,
}));
vi.mock('../meetings/case-booking-funding.js', () => ({
  checkCaseBookingFunding: mocks.checkFunding,
}));
vi.mock('../meetings/provision-meeting.js', () => ({ provisionCallNowVenue: mocks.provision }));
vi.mock('../../jobs/booking-calendar-projection-job.js', () => ({
  enqueueBookingCalendarProjection: mocks.enqueueProjection,
}));
vi.mock('../../jobs/call-now-ring-expiry.js', () => ({
  enqueueCallNowRingExpiry: mocks.enqueueExpiry,
}));
vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mocks.enqueueRebuild,
}));
vi.mock('../calendar-invites/publish-calendar-invites.js', () => ({
  publishBookingCalendarInvites: mocks.publishInvites,
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mocks.publish },
}));

import type { FastifyBaseLogger } from 'fastify';
import {
  CALL_NOW_RING_MS,
  CALL_NOW_RING_SMS_MS,
  CALL_NOW_SCHEDULED_MINUTES,
} from '@balo/shared/meetings';
import { startCallNow } from './start-call.js';

const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const EXPERT_USER = '22222222-2222-4222-8222-222222222222';
const BOOKER = '55555555-5555-4555-8555-555555555555';
const RING_ID = '88888888-8888-4888-8888-888888888888';
const NEW_MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOOKED_MEETING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-16T10:00:00.000Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

const CASE_ROW = { id: ENGAGEMENT_ID, companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID };

function ring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RING_ID,
    meetingId: NEW_MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    callerUserId: CLIENT,
    calleeUserId: EXPERT_USER,
    callerSide: 'client',
    placement: 'new_meeting',
    status: 'ringing',
    reachedBy: 'app',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: new Date(NOW.getTime() + CALL_NOW_RING_MS),
    endedAt: null,
    ...overrides,
  };
}

function gates(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    availability: { canCallNow: true },
    callee: { userId: EXPERT_USER, timeZone: 'Australia/Sydney' },
    calleeOnline: false,
    inPlaceCandidate: null,
    expertProfileId: EXPERT_PROFILE_ID,
    companyId: COMPANY_ID,
    ...overrides,
  };
}

const CANDIDATE = {
  meetingId: BOOKED_MEETING_ID,
  scheduledStart: new Date('2026-11-16T15:00:00.000Z'),
};

function start(overrides: Record<string, unknown> = {}) {
  return startCallNow({
    engagementId: ENGAGEMENT_ID,
    userId: CLIENT,
    now: NOW,
    log,
    meterCallee: mocks.meterCallee,
    releaseCallee: mocks.releaseCallee,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ ok: true, side: 'client', caseRow: CASE_ROW, mayRing: true });
  mocks.loadGates.mockResolvedValue(gates());
  mocks.meterCallee.mockResolvedValue(false);
  mocks.checkFunding.mockResolvedValue({ ok: true });
  mocks.releaseCallee.mockResolvedValue(undefined);
  mocks.resolveReach.mockResolvedValue({ reachedBy: 'app', suppressedBy: null });
  mocks.releaseSmsSlot.mockResolvedValue(undefined);
  mocks.findRingingForEngagement.mockResolvedValue(undefined);
  mocks.startWithNewMeeting.mockResolvedValue({
    ring: ring(),
    meeting: { id: NEW_MEETING_ID },
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mocks.startOnMeeting.mockResolvedValue({
    ring: ring({ placement: 'in_place', meetingId: BOOKED_MEETING_ID }),
    meeting: { id: BOOKED_MEETING_ID },
    expertProfileId: null,
  });
  mocks.provision.mockResolvedValue({ provisioned: true, dailyRoomName: 'r', joinUrl: 'u' });
  mocks.enqueueExpiry.mockResolvedValue(undefined);
  mocks.enqueueRebuild.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(undefined);
  mocks.endRing.mockResolvedValue({ ended: true });
});

describe('startCallNow — placement', () => {
  it('client without the field → new_meeting at [now, now + the 15-minute floor)', async () => {
    const result = await start();

    expect(result).toEqual({
      ok: true,
      ringId: RING_ID,
      meetingId: NEW_MEETING_ID,
      placement: 'new_meeting',
      expiresAt: new Date(NOW.getTime() + CALL_NOW_RING_MS),
    });
    expect(mocks.startWithNewMeeting).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      callerUserId: CLIENT,
      calleeUserId: EXPERT_USER,
      callerSide: 'client',
      reachedBy: 'app',
      expiresAt: new Date(NOW.getTime() + CALL_NOW_RING_MS),
      scheduledStart: NOW,
      scheduledEnd: new Date(NOW.getTime() + CALL_NOW_SCHEDULED_MINUTES * 60_000),
    });
    expect(mocks.startOnMeeting).not.toHaveBeenCalled();
  });

  it('client naming the candidate → in_place on the booked meeting, with no room or rebuild', async () => {
    mocks.loadGates.mockResolvedValue(gates({ inPlaceCandidate: CANDIDATE }));

    const result = await start({ inPlaceOfMeetingId: BOOKED_MEETING_ID });

    expect(result).toMatchObject({ ok: true, placement: 'in_place', meetingId: BOOKED_MEETING_ID });
    expect(mocks.startOnMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: BOOKED_MEETING_ID, callerSide: 'client' })
    );
    expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.enqueueRebuild).not.toHaveBeenCalled();
  });

  it.each([
    [
      'names a meeting that is not the candidate',
      CANDIDATE,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ],
    ['names a meeting when there is no candidate', null, BOOKED_MEETING_ID],
  ])('client that %s → in_place_not_eligible, nothing written', async (_label, candidate, sent) => {
    mocks.loadGates.mockResolvedValue(gates({ inPlaceCandidate: candidate }));

    await expect(start({ inPlaceOfMeetingId: sent })).resolves.toEqual({
      ok: false,
      code: 'in_place_not_eligible',
    });
    expect(mocks.startOnMeeting).not.toHaveBeenCalled();
    expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
  });

  it('the booked meeting having moved on (repository miss) → in_place_not_eligible', async () => {
    mocks.loadGates.mockResolvedValue(gates({ inPlaceCandidate: CANDIDATE }));
    mocks.startOnMeeting.mockResolvedValue(undefined);

    await expect(start({ inPlaceOfMeetingId: BOOKED_MEETING_ID })).resolves.toEqual({
      ok: false,
      code: 'in_place_not_eligible',
    });
    expect(mocks.enqueueExpiry).not.toHaveBeenCalled();
  });

  describe('expert caller (decision 9)', () => {
    beforeEach(() => {
      mocks.authorize.mockResolvedValue({
        ok: true,
        side: 'expert',
        caseRow: CASE_ROW,
        mayRing: true,
      });
      mocks.loadGates.mockResolvedValue(
        gates({ callee: { userId: BOOKER, timeZone: 'UTC' }, inPlaceCandidate: null })
      );
      mocks.startWithNewMeeting.mockResolvedValue({
        ring: ring({ callerSide: 'expert', callerUserId: EXPERT_USER, calleeUserId: BOOKER }),
        meeting: { id: NEW_MEETING_ID },
        expertProfileId: EXPERT_PROFILE_ID,
      });
    });

    it('always rings on a NEW meeting', async () => {
      await expect(start({ userId: EXPERT_USER })).resolves.toMatchObject({
        ok: true,
        placement: 'new_meeting',
      });
      expect(mocks.startWithNewMeeting).toHaveBeenCalledWith(
        expect.objectContaining({ callerSide: 'expert', calleeUserId: BOOKER })
      );
    });

    it('sending `inPlaceOfMeetingId` is in_place_not_allowed (a 400), before any gate or write', async () => {
      await expect(
        start({ userId: EXPERT_USER, inPlaceOfMeetingId: BOOKED_MEETING_ID })
      ).resolves.toEqual({ ok: false, code: 'in_place_not_allowed' });
      expect(mocks.loadGates).not.toHaveBeenCalled();
      expect(mocks.startOnMeeting).not.toHaveBeenCalled();
      expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
    });

    it('passes `mayRing` from the authorization into the gates', async () => {
      mocks.authorize.mockResolvedValue({
        ok: true,
        side: 'expert',
        caseRow: CASE_ROW,
        mayRing: false,
      });
      mocks.loadGates.mockResolvedValue(
        gates({
          callee: null,
          availability: { canCallNow: false, refusal: 'callee_unavailable', reason: null },
        })
      );

      await expect(start({ userId: EXPERT_USER })).resolves.toMatchObject({
        ok: false,
        code: 'call_now_unavailable',
        reason: null,
      });
      expect(mocks.loadGates).toHaveBeenCalledWith(expect.objectContaining({ mayRing: false }));
      expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
    });
  });
});

describe('startCallNow — the per-callee ring budget (S2)', () => {
  it('meters the resolved CALLEE against the client caller’s COMPANY, then rings', async () => {
    await expect(start()).resolves.toMatchObject({ ok: true });
    expect(mocks.meterCallee).toHaveBeenCalledWith(EXPERT_USER, {
      kind: 'company',
      id: COMPANY_ID,
    });
  });

  it('meters an expert caller against the case’s delivering EXPERT PROFILE', async () => {
    mocks.authorize.mockResolvedValue({
      ok: true,
      side: 'expert',
      caseRow: CASE_ROW,
      mayRing: true,
    });
    mocks.loadGates.mockResolvedValue(gates({ callee: { userId: BOOKER, timeZone: 'UTC' } }));

    await expect(start({ userId: EXPERT_USER })).resolves.toMatchObject({ ok: true });
    expect(mocks.meterCallee).toHaveBeenCalledWith(BOOKER, {
      kind: 'expert_profile',
      id: EXPERT_PROFILE_ID,
    });
  });

  it('a spent budget answers rate_limited and writes nothing', async () => {
    mocks.meterCallee.mockResolvedValue(true);

    await expect(start()).resolves.toEqual({ ok: false, code: 'rate_limited' });
    expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('a refused attempt never spends the callee’s budget', async () => {
    mocks.loadGates.mockResolvedValue(
      gates({ availability: { canCallNow: false, refusal: 'callee_busy', reason: 'busy' } })
    );

    await start();
    await start({ inPlaceOfMeetingId: BOOKED_MEETING_ID });

    expect(mocks.meterCallee).not.toHaveBeenCalled();
  });
});

describe('startCallNow — refusals', () => {
  it('an unauthorized caller is case_not_found and nothing else runs', async () => {
    mocks.authorize.mockResolvedValue({ ok: false, code: 'case_not_found' });

    await expect(start()).resolves.toEqual({ ok: false, code: 'case_not_found' });
    expect(mocks.loadGates).not.toHaveBeenCalled();
    expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
  });

  it('a refused gate answers call_now_unavailable with the refusal and display reason', async () => {
    mocks.loadGates.mockResolvedValue(
      gates({ availability: { canCallNow: false, refusal: 'callee_busy', reason: 'busy' } })
    );

    await expect(start()).resolves.toEqual({
      ok: false,
      code: 'call_now_unavailable',
      refusal: 'callee_busy',
      reason: 'busy',
    });
    expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
  });

  it('MeetingRingAlreadyLiveError → call_now_unavailable / ring_in_progress / reason null', async () => {
    mocks.startWithNewMeeting.mockRejectedValue(new mocks.RingAlreadyLive('race'));

    await expect(start()).resolves.toEqual({
      ok: false,
      code: 'call_now_unavailable',
      refusal: 'ring_in_progress',
      reason: null,
    });
    expect(mocks.enqueueExpiry).not.toHaveBeenCalled();
  });

  it('an unexpected repository error propagates to the route’s log.error boundary', async () => {
    mocks.startWithNewMeeting.mockRejectedValue(new Error('db down'));

    await expect(start()).rejects.toThrow('db down');
  });
});

describe('startCallNow — stale ring cleanup', () => {
  it('ends a ringing ring past expires_at before reading the gates', async () => {
    mocks.findRingingForEngagement.mockResolvedValue(
      ring({ expiresAt: new Date(NOW.getTime() - 1000) })
    );

    await start();

    expect(mocks.endRing).toHaveBeenCalledWith({
      ringId: RING_ID,
      to: 'unanswered',
      actorUserId: null,
      now: NOW,
    });
    expect(mocks.endRing.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.loadGates.mock.invocationCallOrder[0] as number
    );
  });

  it('leaves a LIVE ring alone for the gates to refuse', async () => {
    mocks.findRingingForEngagement.mockResolvedValue(ring());

    await start();

    expect(mocks.endRing).not.toHaveBeenCalled();
  });
});

describe('startCallNow — new_meeting post-commit', () => {
  it('rebuilds availability, then provisions the room', async () => {
    await start();

    expect(mocks.enqueueRebuild).toHaveBeenCalledWith(EXPERT_PROFILE_ID, expect.anything());
    expect(mocks.provision).toHaveBeenCalledWith({ id: NEW_MEETING_ID }, log);
    expect(mocks.enqueueRebuild.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.provision.mock.invocationCallOrder[0] as number
    );
  });

  it('a room that cannot be provisioned stops the ring (unannounced) and answers venue_unavailable', async () => {
    mocks.provision.mockResolvedValue({ provisioned: false, dailyRoomName: null, joinUrl: null });

    await expect(start()).resolves.toEqual({ ok: false, code: 'venue_unavailable' });

    expect(mocks.endRing).toHaveBeenCalledWith(
      expect.objectContaining({
        ringId: RING_ID,
        to: 'stopped',
        actorUserId: null,
        announce: false,
      })
    );
    expect(mocks.enqueueExpiry).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('⚠ a ring stopped for want of a room gives its callee slot back and warns — the caller made no call', async () => {
    mocks.provision.mockResolvedValue({ provisioned: false, dailyRoomName: null, joinUrl: null });

    await start();

    expect(mocks.releaseCallee).toHaveBeenCalledTimes(1);
    expect(mocks.releaseCallee).toHaveBeenCalledWith(EXPERT_USER, {
      kind: 'company',
      id: COMPANY_ID,
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID, meetingId: NEW_MEETING_ID }),
      expect.stringContaining('could not be provisioned')
    );
  });

  it('a ring that starts never gives its callee slot back', async () => {
    await start();

    expect(mocks.releaseCallee).not.toHaveBeenCalled();
  });

  it('uses an injected provisioner', async () => {
    const provision = vi
      .fn()
      .mockResolvedValue({ provisioned: true, dailyRoomName: 'r', joinUrl: 'u' });

    await start({ deps: { provision } });

    expect(provision).toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });
});

describe('startCallNow — expiry job and events', () => {
  it('enqueues the expiry with the ring id, its expiresAt and now', async () => {
    await start();

    expect(mocks.enqueueExpiry).toHaveBeenCalledWith(
      RING_ID,
      new Date(NOW.getTime() + CALL_NOW_RING_MS),
      NOW
    );
  });

  it('an expiry enqueue failure warns and the ring still starts (the sweep is the backstop)', async () => {
    mocks.enqueueExpiry.mockRejectedValue(new Error('redis down'));

    await expect(start()).resolves.toMatchObject({ ok: true, ringId: RING_ID });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID }),
      expect.stringContaining('sweep')
    );
  });

  it('publishes call.ringing after the expiry is scheduled', async () => {
    await start();

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(
      'call.ringing',
      expect.objectContaining({ ringId: RING_ID, calleeUserId: EXPERT_USER })
    );
    expect(mocks.enqueueExpiry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0] as number
    );
  });

  it('⚠ is not a booking: no calendar projection, no invites, no booking.confirmed', async () => {
    await start();

    expect(mocks.enqueueProjection).not.toHaveBeenCalled();
    expect(mocks.publishInvites).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls.map(([event]) => event)).not.toContain('booking.confirmed');
  });

  it('defaults `now` to the clock when none is injected', async () => {
    const before = Date.now();

    const result = await startCallNow({
      engagementId: ENGAGEMENT_ID,
      userId: CLIENT,
      log,
      meterCallee: mocks.meterCallee,
      releaseCallee: mocks.releaseCallee,
    });

    expect(result.ok).toBe(true);
    const call = mocks.startWithNewMeeting.mock.calls[0]?.[0] as { scheduledStart: Date };
    expect(call.scheduledStart.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('startCallNow — SMS reach (BAL-652)', () => {
  it('asks for the reach decision with the callee, its side, presence and now', async () => {
    await start();

    expect(mocks.resolveReach).toHaveBeenCalledWith({
      callerUserId: CLIENT,
      callee: { userId: EXPERT_USER, timeZone: 'Australia/Sydney' },
      calleeSide: 'expert',
      calleeOnline: false,
      now: NOW,
    });
  });

  it('an expert caller rings a client-side callee and passes the gates’ presence read', async () => {
    mocks.authorize.mockResolvedValue({
      ok: true,
      side: 'expert',
      caseRow: CASE_ROW,
      mayRing: true,
    });
    mocks.loadGates.mockResolvedValue(
      gates({ callee: { userId: BOOKER, timeZone: 'UTC' }, calleeOnline: true })
    );

    await start({ userId: EXPERT_USER });

    expect(mocks.resolveReach).toHaveBeenCalledWith(
      expect.objectContaining({ calleeSide: 'client', calleeOnline: true })
    );
  });

  it('an eligible callee → the ring is written as `sms` with the SMS window', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'sms' });
    mocks.startWithNewMeeting.mockResolvedValue({
      ring: ring({ reachedBy: 'sms' }),
      meeting: { id: NEW_MEETING_ID },
      expertProfileId: EXPERT_PROFILE_ID,
    });
    const expected = new Date(NOW.getTime() + CALL_NOW_RING_SMS_MS);

    const result = await start();

    expect(result).toMatchObject({ ok: true, expiresAt: expected });
    expect(mocks.startWithNewMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ reachedBy: 'sms', expiresAt: expected })
    );
    expect(mocks.enqueueExpiry).toHaveBeenCalledWith(RING_ID, expected, NOW);
    expect(mocks.trackSuppressed).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ reachedBy: 'sms' }),
      'Call now ring started'
    );
  });

  it('a suppressed SMS → `app`, the app window, and the reason tracked once after the write', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'app', suppressedBy: 'outside_hours' });

    await start();

    expect(mocks.startWithNewMeeting).toHaveBeenCalledWith(
      expect.objectContaining({
        reachedBy: 'app',
        expiresAt: new Date(NOW.getTime() + CALL_NOW_RING_MS),
      })
    );
    expect(mocks.trackSuppressed).toHaveBeenCalledTimes(1);
    expect(mocks.trackSuppressed).toHaveBeenCalledWith(expect.anything(), 'outside_hours');
    expect(mocks.startWithNewMeeting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.trackSuppressed.mock.invocationCallOrder[0] as number
    );
    expect(mocks.releaseSmsSlot).not.toHaveBeenCalled();
  });

  it('an `app` ring with no suppression reason (a cap-check outage) tracks nothing', async () => {
    await start();

    expect(mocks.trackSuppressed).not.toHaveBeenCalled();
  });

  it('a failed write gives the cap slot back and tracks nothing', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'sms' });
    mocks.startWithNewMeeting.mockRejectedValue(new mocks.RingAlreadyLive('race'));

    await expect(start()).resolves.toMatchObject({ ok: false });

    expect(mocks.releaseSmsSlot).toHaveBeenCalledWith(CLIENT, EXPERT_USER);
    expect(mocks.trackSuppressed).not.toHaveBeenCalled();
  });

  it('a THROWING write gives the cap slot back, rethrows the original error and tracks nothing', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'sms' });
    mocks.startWithNewMeeting.mockRejectedValue(new Error('db down'));

    await expect(start()).rejects.toThrow('db down');

    expect(mocks.releaseSmsSlot).toHaveBeenCalledWith(CLIENT, EXPERT_USER);
    expect(mocks.trackSuppressed).not.toHaveBeenCalled();
    expect(mocks.enqueueExpiry).not.toHaveBeenCalled();
  });

  it('a throwing write on an `app` ring has no slot to give back', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'app', suppressedBy: 'cap' });
    mocks.startWithNewMeeting.mockRejectedValue(new Error('db down'));

    await expect(start()).rejects.toThrow('db down');

    expect(mocks.releaseSmsSlot).not.toHaveBeenCalled();
  });

  it('a failed write on an `app` ring has no slot to give back', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'app', suppressedBy: 'cap' });
    mocks.startWithNewMeeting.mockRejectedValue(new mocks.RingAlreadyLive('race'));

    await start();

    expect(mocks.releaseSmsSlot).not.toHaveBeenCalled();
    expect(mocks.trackSuppressed).not.toHaveBeenCalled();
  });

  it('a room that cannot be provisioned gives the cap slot back', async () => {
    mocks.resolveReach.mockResolvedValue({ reachedBy: 'sms' });
    mocks.provision.mockResolvedValue({ provisioned: false, dailyRoomName: null, joinUrl: null });

    await expect(start()).resolves.toEqual({ ok: false, code: 'venue_unavailable' });

    expect(mocks.releaseSmsSlot).toHaveBeenCalledWith(CLIENT, EXPERT_USER);
  });

  it('a refused gate never reaches the SMS decision', async () => {
    mocks.loadGates.mockResolvedValue(
      gates({ availability: { canCallNow: false, refusal: 'callee_busy', reason: 'busy' } })
    );

    await start();

    expect(mocks.resolveReach).not.toHaveBeenCalled();
  });

  it('a spent callee budget never reaches the SMS decision', async () => {
    mocks.meterCallee.mockResolvedValue(true);

    await start();

    expect(mocks.resolveReach).not.toHaveBeenCalled();
  });
});

describe('startCallNow — the client funding check (BAL-650)', () => {
  const WINDOW_END = new Date(NOW.getTime() + CALL_NOW_SCHEDULED_MINUTES * 60_000);

  it('a client new_meeting start checks funding over [now, now + 15 min) for the case company and expert', async () => {
    await expect(start()).resolves.toMatchObject({ ok: true });

    expect(mocks.checkFunding).toHaveBeenCalledTimes(1);
    expect(mocks.checkFunding).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      scheduledStart: NOW,
      scheduledEnd: WINDOW_END,
      now: NOW,
    });
  });

  it('⚠ passes NO excludeMeetingId — the meeting does not exist yet when this check runs', async () => {
    await start();
    expect(mocks.checkFunding.mock.calls[0]?.[0]).not.toHaveProperty('excludeMeetingId');
  });

  it.each([
    ['account_on_hold', 4_200],
    ['booking_unfunded', 12_500],
    ['booking_reserved', 30_000],
    ['booking_funding_unavailable', null],
  ])(
    'a %s refusal answers its code and figure, spends no budget and writes nothing',
    async (code, suggestedTopUpMinor) => {
      mocks.checkFunding.mockResolvedValue({ ok: false, code, suggestedTopUpMinor });

      await expect(start()).resolves.toEqual({ ok: false, code, suggestedTopUpMinor });

      expect(mocks.meterCallee).not.toHaveBeenCalled();
      expect(mocks.resolveReach).not.toHaveBeenCalled();
      expect(mocks.startWithNewMeeting).not.toHaveBeenCalled();
      expect(mocks.startOnMeeting).not.toHaveBeenCalled();
      expect(mocks.provision).not.toHaveBeenCalled();
      expect(mocks.enqueueRebuild).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.info).toHaveBeenCalledWith(
        expect.objectContaining({ code }),
        'Call now start refused — funding'
      );
    }
  );

  it('an in-place start never calls the guard (the client’s own booking is already reserved)', async () => {
    mocks.loadGates.mockResolvedValue(gates({ inPlaceCandidate: CANDIDATE }));

    await expect(start({ inPlaceOfMeetingId: BOOKED_MEETING_ID })).resolves.toMatchObject({
      ok: true,
      placement: 'in_place',
    });
    expect(mocks.checkFunding).not.toHaveBeenCalled();
  });

  it('an expert caller never reaches the guard — the client commits later, on answer', async () => {
    mocks.authorize.mockResolvedValue({
      ok: true,
      side: 'expert',
      caseRow: CASE_ROW,
      mayRing: true,
    });
    mocks.loadGates.mockResolvedValue(gates({ callee: { userId: BOOKER, timeZone: 'UTC' } }));

    await expect(start({ userId: EXPERT_USER })).resolves.toMatchObject({ ok: true });
    expect(mocks.checkFunding).not.toHaveBeenCalled();
  });

  it('a passing check (an active mandate passes as at booking) proceeds to meter and write', async () => {
    mocks.checkFunding.mockResolvedValue({ ok: true });

    await expect(start()).resolves.toMatchObject({ ok: true });
    expect(mocks.meterCallee).toHaveBeenCalledTimes(1);
    expect(mocks.startWithNewMeeting).toHaveBeenCalledTimes(1);
  });

  it('the order is gates, then placement, then funding, then the callee meter', async () => {
    await start();

    const order = (fn: { mock: { invocationCallOrder: number[] } }): number => {
      const [first] = fn.mock.invocationCallOrder;
      if (first === undefined) {
        throw new Error('expected the mock to have been called');
      }
      return first;
    };
    expect(order(mocks.loadGates)).toBeLessThan(order(mocks.checkFunding));
    expect(order(mocks.checkFunding)).toBeLessThan(order(mocks.meterCallee));
    expect(order(mocks.meterCallee)).toBeLessThan(order(mocks.startWithNewMeeting));
  });

  it('a gate refusal or a bad placement never reaches the guard', async () => {
    mocks.loadGates.mockResolvedValue(
      gates({ availability: { canCallNow: false, refusal: 'callee_busy', reason: 'busy' } })
    );
    await start();
    mocks.loadGates.mockResolvedValue(gates({ inPlaceCandidate: null }));
    await start({ inPlaceOfMeetingId: BOOKED_MEETING_ID });

    expect(mocks.checkFunding).not.toHaveBeenCalled();
  });
});
