import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ publish: vi.fn(), trackServer: vi.fn(), warn: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mocks.publish },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mocks.trackServer,
  CALL_NOW_SERVER_EVENTS: { RING_ENDED: 'call_now_ring_ended' },
}));

import type { MeetingRing } from '@balo/db';
import { publishCallEvent, trackRingEnded } from './call-now-events.js';

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
  mocks.publish.mockResolvedValue(undefined);
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
  it('reports whole seconds, the caller lens and the caller as distinct id', () => {
    trackRingEnded(ring());

    expect(mocks.trackServer).toHaveBeenCalledWith('call_now_ring_ended', {
      outcome: 'connected',
      ring_seconds: 61,
      caller_lens: 'expert',
      reached_by: 'sms',
      placement: 'in_place',
      meeting_id: 'meeting-1',
      distinct_id: 'caller',
    });
  });

  it('falls back to updatedAt when endedAt is missing', () => {
    trackRingEnded(ring({ status: 'declined', endedAt: null }));

    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ outcome: 'declined', ring_seconds: 61 })
    );
  });

  it('never reports a ring that is still ringing', () => {
    trackRingEnded(ring({ status: 'ringing', endedAt: null }));

    expect(mocks.trackServer).not.toHaveBeenCalled();
  });

  it('never throws', () => {
    mocks.trackServer.mockImplementation(() => {
      throw new Error('posthog');
    });

    expect(() => trackRingEnded(ring())).not.toThrow();
    expect(mocks.warn).toHaveBeenCalled();
  });
});
