import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRingingForMeeting: vi.fn(),
  connect: vi.fn(),
  enqueueRebuild: vi.fn(),
  enqueueAmend: vi.fn(),
  reportAmendFailure: vi.fn(),
  publish: vi.fn(),
  trackServer: vi.fn(),
  emitMeetingEnded: vi.fn(),
  deleteRoom: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  // Anything a connect must NOT touch (the copy sheet: "No message on any channel").
  publishGuestRescheduled: vi.fn(),
  publishInvites: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mocks.info,
    warn: mocks.warn,
    error: mocks.error,
  }),
}));
vi.mock('@balo/db', () => ({
  meetingRingsRepository: {
    findRingingForMeeting: mocks.findRingingForMeeting,
    connect: mocks.connect,
  },
}));
vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mocks.enqueueRebuild,
}));
vi.mock('../../jobs/meeting-calendar-amend.js', () => ({
  enqueueMeetingCalendarAmend: mocks.enqueueAmend,
}));
vi.mock('../meetings/meeting-availability.js', () => ({
  reportCalendarAmendEnqueueFailure: mocks.reportAmendFailure,
  publishGuestRescheduledNotifications: mocks.publishGuestRescheduled,
}));
vi.mock('../calendar-invites/publish-calendar-invites.js', () => ({
  publishRescheduleCalendarInvites: mocks.publishInvites,
}));
vi.mock('../daily/rooms.js', () => ({ dailyRoomTeardown: { deleteRoom: mocks.deleteRoom } }));
vi.mock('../meetings/end-meeting.js', () => ({ emitMeetingEnded: mocks.emitMeetingEnded }));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mocks.publish },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mocks.trackServer,
  CALL_NOW_SERVER_EVENTS: { RING_ENDED: 'call_now_ring_ended' },
}));

import type { Meeting } from '@balo/db';
import { connectRingIfRinging } from './connect-ring.js';

const RING_ID = '88888888-8888-4888-8888-888888888888';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const CALLER = '11111111-1111-4111-8111-111111111111';
const CALLEE = '55555555-5555-4555-8555-555555555555';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const AUDIT_ID = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-11-16T10:00:30.000Z');
const BOOKED_START = new Date('2026-11-16T15:00:00.000Z');
const MEETING = { id: MEETING_ID } as unknown as Meeting;
const CALENDAR_EVENTS = [
  { id: 'cal-client', party: 'client', deliveryMode: 'ics', sequence: 2 },
  { id: 'cal-expert', party: 'expert', deliveryMode: 'provider_event', sequence: 3 },
];

function connected(placement: 'new_meeting' | 'in_place', expertProfileId: string | null) {
  return {
    ring: {
      id: RING_ID,
      meetingId: MEETING_ID,
      engagementId: ENGAGEMENT_ID,
      callerUserId: CALLER,
      calleeUserId: CALLEE,
      callerSide: 'expert',
      placement,
      status: 'connected',
      reachedBy: 'app',
      createdAt: new Date('2026-11-16T10:00:00.000Z'),
      updatedAt: NOW,
      expiresAt: new Date('2026-11-16T10:00:45.000Z'),
      endedAt: NOW,
    },
    meeting: {
      id: MEETING_ID,
      scheduledStart: NOW,
      scheduledEnd: new Date('2026-11-16T10:30:30.000Z'),
    },
    previous: { scheduledStart: BOOKED_START, scheduledEnd: new Date('2026-11-16T15:30:00.000Z') },
    expertProfileId,
    calendarEvents: [],
    rescheduleAuditId: AUDIT_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRingingForMeeting.mockResolvedValue({ id: RING_ID });
  mocks.connect.mockResolvedValue(connected('in_place', EXPERT_PROFILE_ID));
  mocks.enqueueRebuild.mockResolvedValue(undefined);
  mocks.enqueueAmend.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(undefined);
  mocks.reportAmendFailure.mockResolvedValue(undefined);
  mocks.publishInvites.mockResolvedValue(undefined);
});

describe('connectRingIfRinging (AC6)', () => {
  it('in_place: connects, then rebuilds availability and amends the calendar keyed on the reschedule audit', async () => {
    const result = await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(result).toMatchObject({ connected: true, meeting: { id: MEETING_ID } });
    expect(mocks.connect).toHaveBeenCalledWith({ ringId: RING_ID, startedAt: NOW });
    expect(mocks.enqueueRebuild).toHaveBeenCalledWith(EXPERT_PROFILE_ID, expect.anything());
    expect(mocks.enqueueAmend).toHaveBeenCalledWith(MEETING_ID, EXPERT_PROFILE_ID, AUDIT_ID);
  });

  it('⚠ sends no message: no guest-rescheduled notice, no booking.rescheduled', async () => {
    await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(mocks.publishGuestRescheduled).not.toHaveBeenCalled();
    const events = mocks.publish.mock.calls.map(([event]) => event);
    expect(events).toEqual(['call.connected']);
  });

  it('in_place: sends the calendar update once, off the rows the connect already bumped', async () => {
    mocks.connect.mockResolvedValue({
      ...connected('in_place', EXPERT_PROFILE_ID),
      calendarEvents: CALENDAR_EVENTS,
    });

    await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(mocks.publishInvites).toHaveBeenCalledTimes(1);
    expect(mocks.publishInvites).toHaveBeenCalledWith(
      {
        meetingId: MEETING_ID,
        rescheduleAuditId: AUDIT_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        calendarEvents: CALENDAR_EVENTS,
      },
      expect.anything()
    );
  });

  it('a calendar update failure does not undo the connect', async () => {
    mocks.publishInvites.mockRejectedValue(new Error('publisher down'));

    const result = await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(result).toMatchObject({ connected: true, meeting: { id: MEETING_ID } });
    expect(mocks.publish).toHaveBeenCalledWith('call.connected', expect.anything());
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, error: 'publisher down' }),
      expect.any(String)
    );
  });

  it('publishes call.connected with the ring payload and tracks the connected outcome', async () => {
    await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(mocks.publish).toHaveBeenCalledWith(
      'call.connected',
      expect.objectContaining({ ringId: RING_ID, meetingId: MEETING_ID, callerUserId: CALLER })
    );
    expect(mocks.trackServer).toHaveBeenCalledWith(
      'call_now_ring_ended',
      expect.objectContaining({ outcome: 'connected', placement: 'in_place', ring_seconds: 30 })
    );
  });

  it('logs the connect with the moved start', async () => {
    await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        ringId: RING_ID,
        fromStart: BOOKED_START.toISOString(),
        toStart: NOW.toISOString(),
      }),
      expect.any(String)
    );
  });

  it('new_meeting: rebuilds availability but amends no calendar and sends no calendar update', async () => {
    mocks.connect.mockResolvedValue(connected('new_meeting', EXPERT_PROFILE_ID));

    await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(mocks.enqueueRebuild).toHaveBeenCalled();
    expect(mocks.enqueueAmend).not.toHaveBeenCalled();
    expect(mocks.publishInvites).not.toHaveBeenCalled();
  });

  it('in_place with no resolvable expert: no rebuild, no amend', async () => {
    mocks.connect.mockResolvedValue(connected('in_place', null));

    await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(mocks.enqueueRebuild).not.toHaveBeenCalled();
    expect(mocks.enqueueAmend).not.toHaveBeenCalled();
  });

  it('an amend enqueue failure goes to the calendar-amend alert, not to the caller', async () => {
    const failure = new Error('redis down');
    mocks.enqueueAmend.mockRejectedValue(failure);

    const result = await connectRingIfRinging({ meeting: MEETING, now: NOW });

    expect(result.connected).toBe(true);
    expect(mocks.reportAmendFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        trigger: 'reschedule',
        error: failure,
      }),
      expect.anything()
    );
  });

  it('survives even the alert failing', async () => {
    mocks.enqueueAmend.mockRejectedValue(new Error('redis down'));
    mocks.reportAmendFailure.mockRejectedValue(new Error('alert down'));

    await expect(connectRingIfRinging({ meeting: MEETING, now: NOW })).resolves.toMatchObject({
      connected: true,
    });
    expect(mocks.warn).toHaveBeenCalled();
  });
});

describe('connectRingIfRinging — the miss paths', () => {
  it('no ringing ring: connected false, nothing else read', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(undefined);

    await expect(connectRingIfRinging({ meeting: MEETING, now: NOW })).resolves.toEqual({
      connected: false,
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('a lost compare-and-set: connected false and no tail fires', async () => {
    mocks.connect.mockResolvedValue(undefined);

    await expect(connectRingIfRinging({ meeting: MEETING, now: NOW })).resolves.toEqual({
      connected: false,
    });
    expect(mocks.enqueueRebuild).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.trackServer).not.toHaveBeenCalled();
  });
});
