import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  trackServer: vi.fn(),
  warn: vi.fn(),
  countCallerRingsToCallee: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mocks.publish },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mocks.trackServer,
  CALL_NOW_SERVER_EVENTS: { RING_ENDED: 'call_now_ring_ended', REFUSED: 'call_now_refused' },
}));
vi.mock('@balo/db', () => ({
  meetingRingsRepository: { countCallerRingsToCallee: mocks.countCallerRingsToCallee },
}));

import type { MeetingRing } from '@balo/db';
import { publishCallEvent, trackCallNowRefused, trackRingEnded } from './call-now-events.js';

const START = new Date('2026-11-16T10:00:00.000Z');

function ring(overrides: Partial<MeetingRing> = {}): MeetingRing {
  return {
    id: 'ring-1',
    meetingId: 'meeting-1',
    engagementId: 'eng-1',
    callerUserId: 'caller',
    calleeUserId: 'callee',
    callerSide: 'expert',
    placement: 'in_place',
    status: 'connected',
    reachedBy: 'sms',
    attemptId: 'attempt-1',
    calleeOnlineAtStart: false,
    createdAt: START,
    updatedAt: new Date(START.getTime() + 61_400),
    expiresAt: new Date(START.getTime() + 120_000),
    endedAt: new Date(START.getTime() + 61_400),
    deletedAt: null,
    ...overrides,
  } as MeetingRing;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trackServer.mockReset();
  mocks.publish.mockResolvedValue(undefined);
  mocks.countCallerRingsToCallee.mockResolvedValue(1);
});

describe('publishCallEvent', () => {
  it('publishes the closed payload keyed on the ring id', async () => {
    await publishCallEvent('call.ringing', ring());

    expect(mocks.publish).toHaveBeenCalledWith('call.ringing', {
      correlationId: 'ring-1',
      ringId: 'ring-1',
      meetingId: 'meeting-1',
      engagementId: 'eng-1',
      callerUserId: 'caller',
      calleeUserId: 'callee',
      callerSide: 'expert',
      placement: 'in_place',
      reachedBy: 'sms',
      expiresAt: '2026-11-16T10:02:00.000Z',
      startedAt: '2026-11-16T10:00:00.000Z',
    });
  });

  it('never throws: a publish failure is a warn', async () => {
    mocks.publish.mockRejectedValue(new Error('queue down'));

    await expect(publishCallEvent('call.declined', ring())).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'call.declined', ringId: 'ring-1', error: 'queue down' }),
      expect.any(String)
    );
  });
});

describe('trackRingEnded', () => {
  it('reports whole seconds, the caller lens, the attempt and the caller as distinct id', async () => {
    await trackRingEnded(ring());

    expect(mocks.trackServer).toHaveBeenCalledWith('call_now_ring_ended', {
      outcome: 'connected',
      ring_seconds: 61,
      caller_lens: 'expert',
      reached_by: 'sms',
      placement: 'in_place',
      meeting_id: 'meeting-1',
      attempt_id: 'attempt-1',
      callee_presence_at_start: 'offline',
      in_place_of_booking: true,
      attempt_number_today: 1,
      distinct_id: 'caller',
    });
  });

  it('pins a connected ring_seconds as connect − start: the time to answer', async () => {
    const connectedAt = new Date(START.getTime() + 18_000);
    await trackRingEnded(
      ring({ status: 'connected', endedAt: connectedAt, updatedAt: connectedAt })
    );

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ outcome: 'connected', ring_seconds: 18 })
    );
  });

  it('falls back to updatedAt when endedAt is missing', async () => {
    await trackRingEnded(ring({ status: 'declined', endedAt: null }));

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ outcome: 'declined', ring_seconds: 61 })
    );
  });

  it('carries a null attempt id for a ring started without one', async () => {
    await trackRingEnded(ring({ attemptId: null }));

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ attempt_id: null })
    );
  });

  it.each([
    { stored: true, expected: 'online' },
    { stored: false, expected: 'offline' },
    { stored: null, expected: 'offline' },
  ])('reports callee_presence_at_start $expected for a stored $stored', async (row) => {
    await trackRingEnded(ring({ calleeOnlineAtStart: row.stored }));

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ callee_presence_at_start: row.expected })
    );
  });

  it('reports in_place_of_booking false for a new-meeting ring', async () => {
    await trackRingEnded(ring({ placement: 'new_meeting' }));

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ in_place_of_booking: false })
    );
  });

  it('counts this caller’s rings to this callee in the rolling 24 hours ending at the ring', async () => {
    mocks.countCallerRingsToCallee.mockResolvedValue(3);
    const createdAt = new Date('2026-11-16T23:59:30.000Z');

    await trackRingEnded(ring({ createdAt }));

    expect(mocks.countCallerRingsToCallee).toHaveBeenCalledWith({
      callerUserId: 'caller',
      calleeUserId: 'callee',
      endingAt: createdAt,
    });
    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ attempt_number_today: 3 })
    );
  });

  it('sends null when the count fails, and still sends the event', async () => {
    mocks.countCallerRingsToCallee.mockRejectedValue(new Error('db down'));

    await trackRingEnded(ring());

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: 'ring-1', error: 'db down' }),
      expect.any(String)
    );
    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ attempt_number_today: null, outcome: 'connected' })
    );
  });

  it('never reports a ring that is still ringing', async () => {
    await trackRingEnded(ring({ status: 'ringing', endedAt: null }));

    expect(mocks.trackServer).not.toHaveBeenCalled();
    expect(mocks.countCallerRingsToCallee).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mocks.trackServer.mockImplementation(() => {
      throw new Error('posthog');
    });

    await expect(trackRingEnded(ring())).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalled();
  });
});

describe('trackCallNowRefused', () => {
  it('reports the side, the caller as distinct id and the result code', () => {
    trackCallNowRefused({ side: 'client', userId: 'caller', result: { code: 'rate_limited' } });

    expect(mocks.trackServer).toHaveBeenCalledWith('call_now_refused', {
      caller_lens: 'client',
      reason: 'rate_limited',
      distinct_id: 'caller',
    });
  });

  it('refines call_now_unavailable to its display reason', () => {
    trackCallNowRefused({
      side: 'expert',
      userId: 'caller',
      result: { code: 'call_now_unavailable', reason: 'outside_hours' },
    });

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_refused',
      expect.objectContaining({ caller_lens: 'expert', reason: 'outside_hours' })
    );
  });

  it('keeps call_now_unavailable when it carries no display reason', () => {
    trackCallNowRefused({
      side: 'client',
      userId: 'caller',
      result: { code: 'call_now_unavailable', reason: null },
    });

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_refused',
      expect.objectContaining({ reason: 'call_now_unavailable' })
    );
  });

  it('never throws', () => {
    mocks.trackServer.mockImplementation(() => {
      throw new Error('posthog');
    });

    expect(() =>
      trackCallNowRefused({
        side: 'client',
        userId: 'caller',
        result: { code: 'venue_unavailable' },
      })
    ).not.toThrow();
    expect(mocks.warn).toHaveBeenCalled();
  });
});
