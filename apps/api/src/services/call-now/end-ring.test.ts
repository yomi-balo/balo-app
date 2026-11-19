import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repoEndRing: vi.fn(),
  findById: vi.fn(),
  findRingingForMeeting: vi.fn(),
  endNoAnswerMeeting: vi.fn(),
  countCallerRingsToCallee: vi.fn(),
  meetingFindById: vi.fn(),
  reconcile: vi.fn(),
  eject: vi.fn(),
  enqueueRebuild: vi.fn(),
  deleteRoom: vi.fn(),
  emitMeetingEnded: vi.fn(),
  publish: vi.fn(),
  trackServer: vi.fn(),
  settle: vi.fn(),
  recordingStop: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingRingsRepository: {
    endRing: mocks.repoEndRing,
    findById: mocks.findById,
    findRingingForMeeting: mocks.findRingingForMeeting,
    endNoAnswerMeeting: mocks.endNoAnswerMeeting,
    countCallerRingsToCallee: mocks.countCallerRingsToCallee,
  },
  meetingsRepository: { findById: mocks.meetingFindById },
}));
vi.mock('../meetings/presence-writer.js', () => ({ reconcileMeetingStatus: mocks.reconcile }));
vi.mock('../../jobs/availability-cache.js', () => ({
  enqueueAvailabilityCacheRebuild: mocks.enqueueRebuild,
}));
vi.mock('../daily/rooms.js', () => ({
  dailyRoomTeardown: { deleteRoom: mocks.deleteRoom },
  dailyParticipantEjector: { ejectParticipants: mocks.eject },
}));
vi.mock('../meetings/end-meeting.js', () => ({ emitMeetingEnded: mocks.emitMeetingEnded }));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mocks.publish },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mocks.trackServer,
  CALL_NOW_SERVER_EVENTS: { RING_ENDED: 'call_now_ring_ended' },
}));
// The three calls an unanswered ring must NEVER make (AC1). Mocked so a stray import is caught.
vi.mock('../credit-session/settle-sessionless-case-meeting.js', () => ({
  settleSessionlessCaseMeeting: mocks.settle,
}));
vi.mock('../../jobs/recording-capture.js', () => ({ enqueueRecordingStop: mocks.recordingStop }));

import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import { dailyParticipantIdFor, dailyRoomNameForMeeting } from '@balo/shared/meetings';
import { endRing, endRingForHumanEnd, terminateNoAnswerMeeting } from './end-ring.js';

const RING_ID = '88888888-8888-4888-8888-888888888888';
const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const CALLER = '11111111-1111-4111-8111-111111111111';
const CALLEE = '55555555-5555-4555-8555-555555555555';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const START = new Date('2026-11-16T10:00:00.000Z');
const ATTEMPT_ID = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-11-16T10:00:45.000Z');
const ROOM = dailyRoomNameForMeeting(MEETING_ID);

function ring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RING_ID,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    callerUserId: CALLER,
    calleeUserId: CALLEE,
    callerSide: 'client',
    placement: 'new_meeting',
    status: 'unanswered',
    reachedBy: 'app',
    attemptId: ATTEMPT_ID,
    calleeOnlineAtStart: false,
    createdAt: START,
    updatedAt: NOW,
    expiresAt: NOW,
    endedAt: NOW,
    ...overrides,
  };
}

const ENDED_MEETING = { id: MEETING_ID, dailyRoomName: 'balo-room', status: 'ended' };

function endedNewMeeting(status: string): Record<string, unknown> {
  return {
    ring: ring({ status }),
    endedMeeting: ENDED_MEETING,
    expertProfileId: EXPERT_PROFILE_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trackServer.mockReset();
  mocks.countCallerRingsToCallee.mockResolvedValue(1);
  mocks.deleteRoom.mockResolvedValue('deleted');
  mocks.emitMeetingEnded.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(undefined);
  mocks.enqueueRebuild.mockResolvedValue(undefined);
  mocks.eject.mockResolvedValue('ejected');
});

describe('endRing — new_meeting', () => {
  it.each(['unanswered', 'declined', 'stopped'] as const)(
    'ending as %s rebuilds availability, tears the room down and emits meeting_ended',
    async (to) => {
      mocks.repoEndRing.mockResolvedValue(endedNewMeeting(to));

      const outcome = await endRing({ ringId: RING_ID, to, actorUserId: CALLER, now: NOW });

      expect(outcome).toMatchObject({ ended: true, status: to });
      expect(mocks.repoEndRing).toHaveBeenCalledWith({
        ringId: RING_ID,
        to,
        now: NOW,
        actorUserId: CALLER,
      });
      expect(mocks.enqueueRebuild).toHaveBeenCalledWith(EXPERT_PROFILE_ID, expect.anything());
      expect(mocks.deleteRoom).toHaveBeenCalledWith('balo-room');
      expect(mocks.emitMeetingEnded).toHaveBeenCalledWith({
        meeting: ENDED_MEETING,
        endedBy: 'system_idle',
        actorUserId: null,
        now: NOW,
      });
    }
  );

  it('⚠ AC1: never settles, stops a recording or releases a credit hold', async () => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('unanswered'));

    await endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW });

    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.recordingStop).not.toHaveBeenCalled();
  });

  it('⚠ AC1: the ring-end modules do not even reference settlement, recording-stop or the hold release', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const file of ['end-ring.ts', 'post-commit.ts']) {
      const text = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      for (const forbidden of [
        'settleSessionlessCaseMeeting',
        'enqueueRecordingStop',
        'releaseCreditHoldBestEffort',
      ]) {
        expect(text, `${file} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('skips the room teardown when no room was ever provisioned', async () => {
    mocks.repoEndRing.mockResolvedValue({
      ...endedNewMeeting('unanswered'),
      endedMeeting: { ...ENDED_MEETING, dailyRoomName: null },
    });

    await endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW });

    expect(mocks.deleteRoom).not.toHaveBeenCalled();
    expect(mocks.emitMeetingEnded).toHaveBeenCalled();
  });

  it('every post-commit step is best-effort: failures warn and never fail the end', async () => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('unanswered'));
    mocks.enqueueRebuild.mockRejectedValue(new Error('redis down'));
    mocks.deleteRoom.mockRejectedValue(new Error('daily down'));
    mocks.emitMeetingEnded.mockRejectedValue(new Error('posthog down'));
    mocks.publish.mockRejectedValue(new Error('queue down'));
    mocks.trackServer.mockImplementation(() => {
      throw new Error('track down');
    });

    const outcome = await endRing({
      ringId: RING_ID,
      to: 'unanswered',
      actorUserId: null,
      now: NOW,
    });

    expect(outcome).toMatchObject({ ended: true, status: 'unanswered' });
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(5));
  });
});

describe('endRing — in_place', () => {
  /** The booking the ring sat on: later today, so its own join window is still shut at `NOW`. */
  const BOOKED_START = new Date(NOW.getTime() + 5 * 60 * 60_000);
  const inPlace = (status: string): Record<string, unknown> => ({
    ring: ring({ status, placement: 'in_place' }),
    endedMeeting: null,
    expertProfileId: null,
  });

  it('makes no meeting, room or availability call', async () => {
    mocks.repoEndRing.mockResolvedValue(inPlace('unanswered'));

    await endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW });

    expect(mocks.enqueueRebuild).not.toHaveBeenCalled();
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
    expect(mocks.emitMeetingEnded).not.toHaveBeenCalled();
  });

  it.each(['unanswered', 'declined', 'stopped'] as const)(
    '%s: ejects the caller and callee from the booked room WITHOUT a ban, and never reconciles the booking',
    async (to) => {
      mocks.repoEndRing.mockResolvedValue(inPlace(to));
      mocks.meetingFindById.mockResolvedValue({
        id: MEETING_ID,
        status: 'scheduled',
        dailyRoomName: ROOM,
        scheduledStart: BOOKED_START,
      });

      await endRing({ ringId: RING_ID, to, actorUserId: null, now: NOW });

      expect(mocks.eject).toHaveBeenCalledWith(
        ROOM,
        [dailyParticipantIdFor('user', CALLER), dailyParticipantIdFor('user', CALLEE)],
        { ban: false }
      );
      expect(mocks.reconcile).not.toHaveBeenCalled();
    }
  );

  it('ejects nobody when the meeting has no room, or its stamped room is not its own', async () => {
    mocks.repoEndRing.mockResolvedValue(inPlace('unanswered'));
    mocks.meetingFindById.mockResolvedValue({ id: MEETING_ID, dailyRoomName: null });
    await endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW });
    expect(mocks.eject).not.toHaveBeenCalled();

    mocks.meetingFindById.mockResolvedValue({
      id: MEETING_ID,
      dailyRoomName: 'balo-someone-else',
      scheduledStart: BOOKED_START,
    });
    await endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW });
    expect(mocks.eject).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('a failing eject warns and never fails the end', async () => {
    mocks.repoEndRing.mockResolvedValue(inPlace('unanswered'));
    mocks.meetingFindById.mockResolvedValue({
      id: MEETING_ID,
      dailyRoomName: ROOM,
      scheduledStart: BOOKED_START,
    });
    mocks.eject.mockRejectedValue(new Error('daily 500'));

    await expect(
      endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW })
    ).resolves.toMatchObject({ ended: true });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID, error: 'daily 500' }),
      expect.stringContaining('eject failed')
    );
  });

  describe('⚠ never ejects inside the booking’s own join window', () => {
    const WINDOW_MS = CASE_JOIN_WINDOW_MINUTES * 60_000;

    it.each([
      ['one millisecond before the window opens', true, WINDOW_MS + 1],
      ['exactly as the window opens', false, WINDOW_MS],
      ['inside the window', false, WINDOW_MS - 60_000],
      ['after the scheduled start', false, -60_000],
    ])('%s → eject: %s', async (_label, ejects, startsInMs) => {
      mocks.repoEndRing.mockResolvedValue(inPlace('unanswered'));
      mocks.meetingFindById.mockResolvedValue({
        id: MEETING_ID,
        status: 'scheduled',
        dailyRoomName: ROOM,
        scheduledStart: new Date(NOW.getTime() + startsInMs),
      });

      await endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW });

      if (ejects) {
        expect(mocks.eject).toHaveBeenCalledTimes(1);
      } else {
        expect(mocks.eject).not.toHaveBeenCalled();
        expect(mocks.info).toHaveBeenCalledWith(
          { ringId: RING_ID, meetingId: MEETING_ID },
          expect.stringContaining('eject skipped')
        );
      }
    });
  });

  it('a new-meeting ring never ejects — its room is torn down instead', async () => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('declined'));

    await endRing({ ringId: RING_ID, to: 'declined', actorUserId: CALLEE, now: NOW });

    expect(mocks.eject).not.toHaveBeenCalled();
  });
});

describe('endRing — events and analytics', () => {
  it.each([
    ['unanswered', 'call.no_answer'],
    ['declined', 'call.declined'],
    ['stopped', 'call.stopped'],
  ] as const)('%s publishes %s with the ring payload', async (to, event) => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting(to));

    await endRing({ ringId: RING_ID, to, actorUserId: null, now: NOW });

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        correlationId: RING_ID,
        ringId: RING_ID,
        meetingId: MEETING_ID,
        engagementId: ENGAGEMENT_ID,
        callerUserId: CALLER,
        calleeUserId: CALLEE,
        placement: 'new_meeting',
        reachedBy: 'app',
        expiresAt: NOW.toISOString(),
      })
    );
  });

  it('⚠ `announce: false` (a ring the callee was never shown) publishes no event and tracks no ring end, but still ends the meeting', async () => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('stopped'));

    await endRing({ ringId: RING_ID, to: 'stopped', actorUserId: null, now: NOW, announce: false });

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.trackServer).not.toHaveBeenCalledWith('call_now_ring_ended', expect.anything());
    expect(mocks.deleteRoom).toHaveBeenCalledWith('balo-room');
  });

  it.each([
    ['unanswered', 'no_answer'],
    ['declined', 'declined'],
    ['stopped', 'stopped'],
  ] as const)('maps status %s to analytics outcome %s', async (to, outcome) => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting(to));

    await endRing({ ringId: RING_ID, to, actorUserId: null, now: NOW });

    await vi.waitFor(() => expect(mocks.trackServer).toHaveBeenCalled());
    expect(mocks.trackServer).toHaveBeenCalledWith('call_now_ring_ended', {
      outcome,
      ring_seconds: 45,
      caller_lens: 'client',
      reached_by: 'app',
      placement: 'new_meeting',
      meeting_id: MEETING_ID,
      attempt_id: ATTEMPT_ID,
      callee_presence_at_start: 'offline',
      in_place_of_booking: false,
      attempt_number_today: 1,
      distinct_id: CALLER,
    });
  });
});

describe('endRing — analytics never delays the end', () => {
  it('⚠ a tracking call that never settles does not hold the end back', async () => {
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('stopped'));
    mocks.countCallerRingsToCallee.mockReturnValue(new Promise<number>(() => undefined));

    const outcome = await endRing({ ringId: RING_ID, to: 'stopped', actorUserId: null, now: NOW });

    expect(outcome).toMatchObject({ ended: true, status: 'stopped' });
    expect(mocks.countCallerRingsToCallee).toHaveBeenCalled();
    expect(mocks.trackServer).not.toHaveBeenCalled();
  });
});

describe('endRing — a lost compare-and-set', () => {
  it('answers the ring’s current status and fires nothing', async () => {
    mocks.repoEndRing.mockResolvedValue(undefined);
    mocks.findById.mockResolvedValue(ring({ status: 'connected' }));

    const outcome = await endRing({
      ringId: RING_ID,
      to: 'declined',
      actorUserId: CALLEE,
      now: NOW,
    });

    expect(outcome).toEqual({ ended: false, status: 'connected' });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.trackServer).not.toHaveBeenCalled();
    expect(mocks.enqueueRebuild).not.toHaveBeenCalled();
  });

  it('answers `status: null` for an unknown ring', async () => {
    mocks.repoEndRing.mockResolvedValue(undefined);
    mocks.findById.mockResolvedValue(undefined);

    await expect(
      endRing({ ringId: RING_ID, to: 'unanswered', actorUserId: null, now: NOW })
    ).resolves.toEqual({ ended: false, status: null });
  });
});

describe('terminateNoAnswerMeeting', () => {
  it('ends a still-ringing meeting THROUGH its ring', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(ring({ status: 'ringing' }));
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('unanswered'));

    await expect(terminateNoAnswerMeeting({ meetingId: MEETING_ID, now: NOW })).resolves.toBe(true);

    expect(mocks.repoEndRing).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID, to: 'unanswered', actorUserId: null })
    );
    expect(mocks.endNoAnswerMeeting).not.toHaveBeenCalled();
  });

  it('is false when the ring has not expired yet (the CAS misses)', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(ring({ status: 'ringing' }));
    mocks.repoEndRing.mockResolvedValue(undefined);
    mocks.findById.mockResolvedValue(ring({ status: 'ringing' }));

    await expect(terminateNoAnswerMeeting({ meetingId: MEETING_ID, now: NOW })).resolves.toBe(
      false
    );
  });

  it('is false for an in-place ring, which ends no meeting', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(
      ring({ status: 'ringing', placement: 'in_place' })
    );
    mocks.repoEndRing.mockResolvedValue({
      ring: ring({ placement: 'in_place' }),
      endedMeeting: null,
      expertProfileId: null,
    });

    await expect(terminateNoAnswerMeeting({ meetingId: MEETING_ID, now: NOW })).resolves.toBe(
      false
    );
  });

  it('ends a never-started meeting whose ring already ended, with the post-commit tail', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(undefined);
    mocks.endNoAnswerMeeting.mockResolvedValue({
      meeting: ENDED_MEETING,
      expertProfileId: EXPERT_PROFILE_ID,
    });

    await expect(terminateNoAnswerMeeting({ meetingId: MEETING_ID, now: NOW })).resolves.toBe(true);

    expect(mocks.endNoAnswerMeeting).toHaveBeenCalledWith({ meetingId: MEETING_ID, endedAt: NOW });
    expect(mocks.enqueueRebuild).toHaveBeenCalledWith(EXPERT_PROFILE_ID, expect.anything());
    expect(mocks.deleteRoom).toHaveBeenCalledWith('balo-room');
    expect(mocks.emitMeetingEnded).toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it('is false when the repository refuses (not a Call now meeting, or already terminal)', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(undefined);
    mocks.endNoAnswerMeeting.mockResolvedValue(undefined);

    await expect(terminateNoAnswerMeeting({ meetingId: MEETING_ID, now: NOW })).resolves.toBe(
      false
    );
    expect(mocks.deleteRoom).not.toHaveBeenCalled();
  });
});

describe('endRingForHumanEnd', () => {
  const OTHER = '77777777-7777-4777-8777-777777777777';

  it('no ringing ring: nothing is written', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(undefined);

    await expect(
      endRingForHumanEnd({ meetingId: MEETING_ID, actorUserId: CALLER, now: NOW })
    ).resolves.toEqual({ kind: 'no_ring' });
    expect(mocks.repoEndRing).not.toHaveBeenCalled();
  });

  it.each([
    { who: 'the caller', actor: CALLER, to: 'stopped' },
    { who: 'the callee', actor: CALLEE, to: 'declined' },
    { who: 'another end-authority holder', actor: OTHER, to: 'stopped' },
  ] as const)('$who ending it records $to, with the actor', async ({ actor, to }) => {
    mocks.findRingingForMeeting.mockResolvedValue(ring({ status: 'ringing' }));
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting(to));

    await endRingForHumanEnd({ meetingId: MEETING_ID, actorUserId: actor, now: NOW });

    expect(mocks.repoEndRing).toHaveBeenCalledWith({
      ringId: RING_ID,
      to,
      now: NOW,
      actorUserId: actor,
    });
  });

  it('a new_meeting ring: answers the meeting its end closed as no_answer', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(ring({ status: 'ringing' }));
    mocks.repoEndRing.mockResolvedValue(endedNewMeeting('stopped'));

    await expect(
      endRingForHumanEnd({ meetingId: MEETING_ID, actorUserId: CALLER, now: NOW })
    ).resolves.toEqual({ kind: 'meeting_ended', meeting: ENDED_MEETING });
  });

  it('an in_place ring: the ring ends and the booking is left to the ordinary End', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(
      ring({ status: 'ringing', placement: 'in_place' })
    );
    mocks.repoEndRing.mockResolvedValue({
      ring: ring({ status: 'stopped', placement: 'in_place' }),
      endedMeeting: null,
      expertProfileId: null,
    });
    mocks.meetingFindById.mockResolvedValue(undefined);

    await expect(
      endRingForHumanEnd({ meetingId: MEETING_ID, actorUserId: CALLER, now: NOW })
    ).resolves.toEqual({ kind: 'ring_ended' });
  });

  it('a ring that connected or ended first: the End continues as usual', async () => {
    mocks.findRingingForMeeting.mockResolvedValue(ring({ status: 'ringing' }));
    mocks.repoEndRing.mockResolvedValue(undefined);
    mocks.findById.mockResolvedValue(ring({ status: 'connected' }));

    await expect(
      endRingForHumanEnd({ meetingId: MEETING_ID, actorUserId: CALLER, now: NOW })
    ).resolves.toEqual({ kind: 'ring_ended' });
  });
});
