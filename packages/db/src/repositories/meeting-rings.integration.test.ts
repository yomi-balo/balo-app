import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { GUEST_TOKEN_TTL_AFTER_END_MS } from '@balo/shared/meetings';
import { db } from '../client';
import {
  auditEvents,
  meetingContexts,
  meetingGuests,
  meetingRings,
  meetings,
  type AuditEvent,
  type Meeting,
} from '../schema';
import {
  caseEngagementFactory,
  expertFactory,
  meetingFactory,
  meetingGuestFactory,
  userFactory,
} from '../test/factories';
import { findProjectionForMeeting } from './_shared/consultation-projection';
import { auditEventsRepository } from './audit-events';
import { consultationsRepository } from './consultations';
import { meetingCalendarEventsRepository } from './meeting-calendar-events';
import { meetingPresenceRepository } from './meeting-presence';
import { meetingsRepository } from './meetings';
import {
  meetingRingsRepository,
  MeetingRingAlreadyLiveError,
  type StartRingInput,
} from './meeting-rings';

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const RING_MS = 45 * SECOND_MS;
const CALL_NOW_MINUTES = 15;

interface RingCase {
  engagementId: string;
  expertProfileId: string;
  callerUserId: string;
  calleeUserId: string;
}

/** A case between a fresh client member (the caller) and a fresh approved expert (the callee). */
async function ringCase(): Promise<RingCase> {
  const expert = await expertFactory();
  const caller = await userFactory();
  const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });
  return {
    engagementId: engagement.id,
    expertProfileId: expert.id,
    callerUserId: caller.id,
    calleeUserId: expert.userId,
  };
}

function startInput(c: RingCase, overrides: Partial<StartRingInput> = {}): StartRingInput {
  return {
    engagementId: c.engagementId,
    callerUserId: c.callerUserId,
    calleeUserId: c.calleeUserId,
    callerSide: 'client',
    reachedBy: 'app',
    expiresAt: new Date(Date.now() + RING_MS),
    attemptId: null,
    calleeOnlineAtStart: false,
    ...overrides,
  };
}

/** Ring on a NEW meeting `[now, now + 15 min)`, the shape Call now creates. */
async function ringNewMeeting(c: RingCase, overrides: Partial<StartRingInput> = {}) {
  const now = Date.now();
  return meetingRingsRepository.startWithNewMeeting({
    ...startInput(c, overrides),
    scheduledStart: new Date(now),
    scheduledEnd: new Date(now + CALL_NOW_MINUTES * MINUTE_MS),
  });
}

/** A booked, provisioned `case` meeting later today: `[now + 3h, now + 3h30)`. */
async function bookLaterToday(c: RingCase): Promise<Meeting> {
  const start = new Date(Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS + 3 * HOUR_MS);
  const roomName = `balo-test-${randomUUID()}`;
  const { meeting } = await meetingsRepository.create({
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 30 * MINUTE_MS),
    contexts: [{ contextType: 'case', contextId: c.engagementId }],
    dailyRoomName: roomName,
    joinUrl: `https://balo.daily.co/${roomName}`,
    actorUserId: c.callerUserId,
  });
  return meeting;
}

/** A guest invited to a booked meeting, expiring where the booking path sets it: end + TTL. */
async function bookedGuest(booked: Meeting) {
  return meetingGuestFactory({
    meetingId: booked.id,
    values: {
      expiresAt: new Date(booked.scheduledEnd.getTime() + GUEST_TOKEN_TTL_AFTER_END_MS),
    },
  });
}

async function auditRows(meetingId: string, action: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'meeting'),
        eq(auditEvents.entityId, meetingId),
        eq(auditEvents.action, action)
      )
    );
}

async function readMeeting(meetingId: string): Promise<Meeting> {
  const [row] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
  if (row === undefined) throw new Error(`no meeting ${meetingId}`);
  return row;
}

async function readRingStatus(ringId: string): Promise<string | undefined> {
  return (await meetingRingsRepository.findById(ringId))?.status;
}

/** Make the audit write for ONE action throw, leaving every other audit write real. */
function failAuditFor(action: string): { restore: () => void } {
  const real = auditEventsRepository.record;
  const spy = vi.spyOn(auditEventsRepository, 'record').mockImplementation(async (input, exec) => {
    if (input.action === action) throw new Error(`forced ${action} failure`);
    return real(input, exec);
  });
  return { restore: () => spy.mockRestore() };
}

describe('meetingRingsRepository.startWithNewMeeting', () => {
  it('creates the meeting, its case context, a confirmed projection, `meeting.booked` and the ringing ring with `meeting.ring_started`', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);

    expect(started.expertProfileId).toBe(c.expertProfileId);
    expect(started.meeting.status).toBe('scheduled');
    expect(started.ring).toMatchObject({
      meetingId: started.meeting.id,
      engagementId: c.engagementId,
      callerUserId: c.callerUserId,
      calleeUserId: c.calleeUserId,
      callerSide: 'client',
      placement: 'new_meeting',
      status: 'ringing',
      reachedBy: 'app',
      endedAt: null,
    });

    const contexts = await db
      .select()
      .from(meetingContexts)
      .where(eq(meetingContexts.meetingId, started.meeting.id));
    expect(contexts).toEqual([
      expect.objectContaining({ contextType: 'case', contextId: c.engagementId }),
    ]);

    const projection = await findProjectionForMeeting(started.meeting.id);
    expect(projection).toMatchObject({ status: 'confirmed', expertProfileId: c.expertProfileId });

    const [booked] = await auditRows(started.meeting.id, 'meeting.booked');
    expect(booked?.actorUserId).toBe(c.callerUserId);

    const ringStarted = await auditRows(started.meeting.id, 'meeting.ring_started');
    expect(ringStarted).toHaveLength(1);
    expect(ringStarted[0]).toMatchObject({
      actorUserId: c.callerUserId,
      metadata: {
        ringId: started.ring.id,
        placement: 'new_meeting',
        callerSide: 'client',
        reachedBy: 'app',
        calleeUserId: c.calleeUserId,
        expiresAt: started.ring.expiresAt.toISOString(),
      },
    });
  });

  it('a second start on the same case throws MeetingRingAlreadyLiveError and leaves exactly one meeting', async () => {
    const c = await ringCase();
    const first = await ringNewMeeting(c);

    await expect(ringNewMeeting(c, { callerSide: 'expert' })).rejects.toBeInstanceOf(
      MeetingRingAlreadyLiveError
    );

    const caseMeetings = await db
      .select({ meetingId: meetingContexts.meetingId })
      .from(meetingContexts)
      .where(and(eq(meetingContexts.contextId, c.engagementId), isNull(meetingContexts.deletedAt)));
    expect(caseMeetings).toEqual([{ meetingId: first.meeting.id }]);
    const rings = await db
      .select()
      .from(meetingRings)
      .where(eq(meetingRings.engagementId, c.engagementId));
    expect(rings).toHaveLength(1);
  });

  it('the one-ringing index is partial: once the ring ends, the case can ring again', async () => {
    const c = await ringCase();
    const first = await ringNewMeeting(c);
    await meetingRingsRepository.endRing({
      ringId: first.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: c.callerUserId,
    });

    const second = await ringNewMeeting(c);
    expect(second.ring.status).toBe('ringing');
    expect(second.meeting.id).not.toBe(first.meeting.id);
  });

  it('writes the attempt id and the callee’s presence at the start (BAL-651)', async () => {
    const c = await ringCase();
    const attemptId = randomUUID();

    const started = await ringNewMeeting(c, { attemptId, calleeOnlineAtStart: true });

    expect(started.ring).toMatchObject({ attemptId, calleeOnlineAtStart: true });
    expect(await meetingRingsRepository.findById(started.ring.id)).toMatchObject({
      attemptId,
      calleeOnlineAtStart: true,
    });
  });

  it('stores a missing attempt id as NULL and an offline callee as false', async () => {
    const c = await ringCase();

    const started = await ringNewMeeting(c, { attemptId: null, calleeOnlineAtStart: false });

    expect(await meetingRingsRepository.findById(started.ring.id)).toMatchObject({
      attemptId: null,
      calleeOnlineAtStart: false,
    });
  });

  it('a ring written by a build that predates the columns reads both as NULL (expand-only)', async () => {
    const c = await ringCase();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: c.engagementId }],
    });

    // Raw SQL on purpose: the previous build's INSERT names only the columns it declares, and a
    // Drizzle insert from THIS schema would name the new ones too.
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO meeting_rings
        (meeting_id, engagement_id, caller_user_id, callee_user_id, caller_side, placement, expires_at)
      VALUES
        (${meeting.id}, ${c.engagementId}, ${c.callerUserId}, ${c.calleeUserId}, 'client',
         'in_place', ${new Date(Date.now() + RING_MS).toISOString()})
      RETURNING id
    `);
    const [row] = inserted;
    if (row === undefined) throw new Error('ring was not inserted');

    expect(await meetingRingsRepository.findById(row.id)).toMatchObject({
      attemptId: null,
      calleeOnlineAtStart: null,
    });
  });

  it('rethrows every other failure untouched — the caller-not-callee and expiry CHECKs', async () => {
    const c = await ringCase();
    await expect(ringNewMeeting(c, { calleeUserId: c.callerUserId })).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'meeting_ring_caller_not_callee',
    });
    await expect(
      ringNewMeeting(c, { expiresAt: new Date(Date.now() - HOUR_MS) })
    ).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'meeting_ring_expires_after_created',
    });

    const rings = await db
      .select()
      .from(meetingRings)
      .where(eq(meetingRings.engagementId, c.engagementId));
    expect(rings).toEqual([]);
  });
});

describe('meetingRingsRepository.startOnMeeting', () => {
  it('rings in place on a booked meeting of the case without writing the meeting', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);

    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });

    expect(started).toBeDefined();
    expect(started?.expertProfileId).toBeNull();
    expect(started?.meeting).toEqual(booked);
    expect(started?.ring).toMatchObject({
      meetingId: booked.id,
      placement: 'in_place',
      status: 'ringing',
    });
    expect(await readMeeting(booked.id)).toEqual(booked);
    expect(await auditRows(booked.id, 'meeting.ring_started')).toHaveLength(1);
  });

  it.each([
    ['waiting_for_participants', { status: 'waiting_for_participants' }],
    ['in_progress', { status: 'in_progress', startedAt: new Date() }],
    ['ended', { status: 'ended', endedBy: 'expert_host', endedAt: new Date() }],
    ['soft-deleted', { status: 'scheduled', deletedAt: new Date() }],
  ] as const)('refuses a %s meeting and writes nothing', async (_label, values) => {
    const c = await ringCase();
    const { meeting } = await meetingFactory({
      contexts: [{ contextType: 'case', contextId: c.engagementId }],
      values,
    });

    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: meeting.id,
    });

    expect(started).toBeUndefined();
    expect(await readMeeting(meeting.id)).toEqual(meeting);
    expect(await meetingRingsRepository.findRingingForEngagement(c.engagementId)).toBeUndefined();
  });

  it('refuses a meeting that belongs to another case', async () => {
    const c = await ringCase();
    const other = await ringCase();
    const elsewhere = await bookLaterToday(other);

    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: elsewhere.id,
    });

    expect(started).toBeUndefined();
    expect(await readMeeting(elsewhere.id)).toEqual(elsewhere);
    expect(await auditRows(elsewhere.id, 'meeting.ring_started')).toEqual([]);
  });

  it('throws MeetingRingAlreadyLiveError while the case already rings', async () => {
    const c = await ringCase();
    await ringNewMeeting(c);
    const booked = await bookLaterToday(c);

    await expect(
      meetingRingsRepository.startOnMeeting({ ...startInput(c), meetingId: booked.id })
    ).rejects.toBeInstanceOf(MeetingRingAlreadyLiveError);
    expect(await auditRows(booked.id, 'meeting.ring_started')).toEqual([]);
  });
});

describe('meetingRingsRepository.connect', () => {
  it('in place: keeps the meeting, room and guests, moves the start to the connect instant, and records one reschedule', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const { guest } = await bookedGuest(booked);
    const calendarRow = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: booked.id,
      party: 'client',
    });
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');

    const startedAt = new Date(Date.now() + 10 * SECOND_MS);
    const connected = await meetingRingsRepository.connect({ ringId: started.ring.id, startedAt });

    expect(connected).toBeDefined();
    if (connected === undefined) return;
    expect(connected.meeting).toMatchObject({
      id: booked.id,
      dailyRoomName: booked.dailyRoomName,
      joinUrl: booked.joinUrl,
      status: 'in_progress',
      startedAt,
      scheduledStart: startedAt,
      scheduledEnd: new Date(startedAt.getTime() + 30 * MINUTE_MS),
    });
    expect(connected.previous).toEqual({
      scheduledStart: booked.scheduledStart,
      scheduledEnd: booked.scheduledEnd,
    });
    expect(connected.expertProfileId).toBe(c.expertProfileId);
    expect(connected.ring).toMatchObject({ status: 'connected', endedAt: startedAt });

    const projection = await findProjectionForMeeting(booked.id);
    expect(projection).toMatchObject({
      status: 'confirmed',
      startAt: startedAt,
      endAt: new Date(startedAt.getTime() + 30 * MINUTE_MS),
    });

    // A move EARLIER extends nothing: the guest link keeps its expiry.
    const [guestAfter] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, guest.id));
    expect(guestAfter?.expiresAt).toEqual(guest.expiresAt);

    expect(connected.calendarEvents).toEqual([
      expect.objectContaining({ id: calendarRow.id, sequence: calendarRow.sequence + 1 }),
    ]);

    const rescheduled = await auditRows(booked.id, 'meeting.rescheduled');
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0]).toMatchObject({
      id: connected.rescheduleAuditId,
      actorUserId: null,
      metadata: {
        reason: 'call_now_connected',
        previousScheduledStart: booked.scheduledStart.toISOString(),
        scheduledStart: startedAt.toISOString(),
        guestLinksExtended: 0,
      },
    });

    const ended = await auditRows(booked.id, 'meeting.ring_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actorUserId: null,
      metadata: { ringId: started.ring.id, status: 'connected', placement: 'in_place' },
    });
  });

  it('on a new meeting: starts it at the connect instant and keeps the 15-minute window', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    const startedAt = new Date(started.meeting.scheduledStart.getTime() + 30 * SECOND_MS);

    const connected = await meetingRingsRepository.connect({ ringId: started.ring.id, startedAt });

    expect(connected?.meeting).toMatchObject({
      id: started.meeting.id,
      status: 'in_progress',
      startedAt,
      scheduledStart: startedAt,
      scheduledEnd: new Date(startedAt.getTime() + CALL_NOW_MINUTES * MINUTE_MS),
    });
  });

  it('a second connect, and a connect after the ring ended, both answer undefined and change nothing', async () => {
    const c = await ringCase();
    const once = await ringNewMeeting(c);
    const startedAt = new Date();
    expect(await meetingRingsRepository.connect({ ringId: once.ring.id, startedAt })).toBeDefined();
    const afterFirst = await readMeeting(once.meeting.id);
    expect(
      await meetingRingsRepository.connect({ ringId: once.ring.id, startedAt: new Date() })
    ).toBeUndefined();
    expect(await readMeeting(once.meeting.id)).toEqual(afterFirst);

    const other = await ringCase();
    const booked = await bookLaterToday(other);
    const declined = await meetingRingsRepository.startOnMeeting({
      ...startInput(other),
      meetingId: booked.id,
    });
    if (declined === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.endRing({
      ringId: declined.ring.id,
      to: 'declined',
      now: new Date(),
      actorUserId: other.calleeUserId,
    });
    expect(
      await meetingRingsRepository.connect({ ringId: declined.ring.id, startedAt: new Date() })
    ).toBeUndefined();
    expect(await readMeeting(booked.id)).toEqual(booked);
  });

  it('when the meeting can no longer start, the ring CAS rolls back with it', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');
    const running = await meetingsRepository.markInProgress(booked.id, new Date());
    expect(running?.status).toBe('in_progress');

    expect(
      await meetingRingsRepository.connect({ ringId: started.ring.id, startedAt: new Date() })
    ).toBeUndefined();
    expect(await readRingStatus(started.ring.id)).toBe('ringing');
    expect(await auditRows(booked.id, 'meeting.ring_ended')).toEqual([]);
    expect(await auditRows(booked.id, 'meeting.rescheduled')).toEqual([]);
  });
});

describe('meetingRingsRepository.endRing — on a new meeting (the meeting ends as no_answer)', () => {
  it('declined: ends the meeting no_answer, closes open presence, cancels the projection and releases the slot', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    await meetingPresenceRepository.open({
      meetingId: started.meeting.id,
      userId: c.callerUserId,
      meetingGuestId: null,
      party: 'client',
      joinedAt: started.meeting.scheduledStart,
    });
    const now = new Date(started.meeting.scheduledStart.getTime() + 20 * SECOND_MS);

    const ended = await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'declined',
      now,
      actorUserId: c.calleeUserId,
    });

    expect(ended?.ring).toMatchObject({ status: 'declined', endedAt: now });
    expect(ended?.expertProfileId).toBe(c.expertProfileId);
    expect(ended?.endedMeeting).toMatchObject({
      id: started.meeting.id,
      status: 'ended',
      outcome: 'no_answer',
      endedBy: 'system_idle',
      endedAt: now,
    });
    expect(await meetingPresenceRepository.listOpen(started.meeting.id)).toEqual([]);
    const [interval] = await meetingPresenceRepository.listByMeeting(started.meeting.id);
    expect(interval?.leftAt).toEqual(now);

    expect(await findProjectionForMeeting(started.meeting.id)).toMatchObject({
      status: 'cancelled',
    });
    const blocking = await consultationsRepository.listConfirmedInRange(
      c.expertProfileId,
      new Date(started.meeting.scheduledStart.getTime() - HOUR_MS),
      new Date(started.meeting.scheduledEnd.getTime() + HOUR_MS)
    );
    expect(blocking.map((row) => row.meetingId)).not.toContain(started.meeting.id);

    const [meetingEnded] = await auditRows(started.meeting.id, 'meeting.ended');
    expect(meetingEnded).toMatchObject({
      actorUserId: c.calleeUserId,
      metadata: { outcome: 'no_answer', endedBy: 'system_idle', terminalRule: 'no_answer' },
    });
    const [ringEnded] = await auditRows(started.meeting.id, 'meeting.ring_ended');
    expect(ringEnded).toMatchObject({
      actorUserId: c.calleeUserId,
      metadata: {
        ringId: started.ring.id,
        status: 'declined',
        placement: 'new_meeting',
        ringMs: now.getTime() - started.ring.createdAt.getTime(),
      },
    });
  });

  it('unanswered is a no-op before `expires_at`, and ends the ring (NULL actor) from `expires_at` on', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    const expiresAt = started.ring.expiresAt;

    expect(
      await meetingRingsRepository.endRing({
        ringId: started.ring.id,
        to: 'unanswered',
        now: new Date(expiresAt.getTime() - 1),
        actorUserId: null,
      })
    ).toBeUndefined();
    expect(await readRingStatus(started.ring.id)).toBe('ringing');
    expect((await readMeeting(started.meeting.id)).status).toBe('scheduled');

    const ended = await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'unanswered',
      now: expiresAt,
      actorUserId: null,
    });
    expect(ended?.ring.status).toBe('unanswered');
    expect(ended?.endedMeeting?.outcome).toBe('no_answer');
    const [ringEnded] = await auditRows(started.meeting.id, 'meeting.ring_ended');
    expect(ringEnded?.actorUserId).toBeNull();
  });

  it('stopped by the caller; a second end answers undefined and writes nothing more', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    const stopped = await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: c.callerUserId,
    });
    expect(stopped?.ring.status).toBe('stopped');

    expect(
      await meetingRingsRepository.endRing({
        ringId: started.ring.id,
        to: 'declined',
        now: new Date(),
        actorUserId: c.calleeUserId,
      })
    ).toBeUndefined();
    expect(await readRingStatus(started.ring.id)).toBe('stopped');
    expect(await auditRows(started.meeting.id, 'meeting.ring_ended')).toHaveLength(1);
    expect(await auditRows(started.meeting.id, 'meeting.ended')).toHaveLength(1);
  });

  it('a meeting already terminal is left alone: the ring still ends, with no ended meeting', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    await meetingsRepository.endMeeting({
      id: started.meeting.id,
      outcome: null,
      endedBy: 'expert_host',
      endedAt: new Date(),
      actorUserId: c.calleeUserId,
    });
    const before = await readMeeting(started.meeting.id);

    const ended = await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: c.callerUserId,
    });

    expect(ended).toMatchObject({ endedMeeting: null, expertProfileId: null });
    expect(ended?.ring.status).toBe('stopped');
    expect(await readMeeting(started.meeting.id)).toEqual(before);
    expect(await findProjectionForMeeting(started.meeting.id)).toMatchObject({
      status: 'confirmed',
    });
  });
});

describe('meetingRingsRepository.endRing — in place (the booked meeting is untouched)', () => {
  it('leaves the meeting row, guest link, calendar SEQUENCE and projection exactly as they were', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const { guest } = await bookedGuest(booked);
    const calendarRow = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: booked.id,
      party: 'client',
    });
    const projectionBefore = await findProjectionForMeeting(booked.id);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');

    const ended = await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: c.callerUserId,
    });
    expect(ended).toMatchObject({ endedMeeting: null, expertProfileId: null });
    expect(ended?.ring.status).toBe('stopped');

    expect(await readMeeting(booked.id)).toEqual(booked);
    const [guestAfter] = await db
      .select()
      .from(meetingGuests)
      .where(eq(meetingGuests.id, guest.id));
    expect(guestAfter).toEqual(guest);
    expect(await meetingCalendarEventsRepository.listLiveByMeeting(booked.id)).toEqual([
      calendarRow,
    ]);
    expect(await findProjectionForMeeting(booked.id)).toEqual(projectionBefore);
    expect(await auditRows(booked.id, 'meeting.ended')).toEqual([]);
    expect(await auditRows(booked.id, 'meeting.rescheduled')).toEqual([]);
    expect(await auditRows(booked.id, 'meeting.ring_ended')).toHaveLength(1);
  });

  it('the booked meeting stays reservable for its company after an unanswered ring', async () => {
    const expert = await expertFactory();
    const caller = await userFactory();
    const { engagement, companyId } = await caseEngagementFactory({ expertProfileId: expert.id });
    const c: RingCase = {
      engagementId: engagement.id,
      expertProfileId: expert.id,
      callerUserId: caller.id,
      calleeUserId: expert.userId,
    };
    const booked = await bookLaterToday(c);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');

    await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'unanswered',
      now: started.ring.expiresAt,
      actorUserId: null,
    });

    const reservable = await meetingsRepository.listReservableCaseBookings({
      companyId,
      now: new Date(),
    });
    expect(reservable.map((row) => row.meetingId)).toContain(booked.id);
  });
});

describe('meetingRingsRepository.endNoAnswerMeeting', () => {
  it('ends a Call now meeting whose ring no longer rings as no_answer, with a NULL actor, releasing the slot', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    // The ring left `ringing` without ending its meeting — the state the sweep's backstop repairs.
    await db
      .update(meetingRings)
      .set({ status: 'unanswered', endedAt: started.ring.expiresAt })
      .where(eq(meetingRings.id, started.ring.id));
    const endedAt = new Date(started.ring.expiresAt.getTime() + MINUTE_MS);

    const ended = await meetingRingsRepository.endNoAnswerMeeting({
      meetingId: started.meeting.id,
      endedAt,
    });

    expect(ended?.expertProfileId).toBe(c.expertProfileId);
    expect(ended?.meeting).toMatchObject({
      status: 'ended',
      outcome: 'no_answer',
      endedBy: 'system_idle',
      endedAt,
    });
    expect(await findProjectionForMeeting(started.meeting.id)).toMatchObject({
      status: 'cancelled',
    });
    const [meetingEnded] = await auditRows(started.meeting.id, 'meeting.ended');
    expect(meetingEnded).toMatchObject({
      actorUserId: null,
      metadata: { terminalRule: 'no_answer' },
    });

    expect(
      await meetingRingsRepository.endNoAnswerMeeting({ meetingId: started.meeting.id, endedAt })
    ).toBeUndefined();
  });

  it('refuses while the ring still rings, and refuses a booked meeting that only carried an in-place ring', async () => {
    const c = await ringCase();
    const ringing = await ringNewMeeting(c);
    expect(
      await meetingRingsRepository.endNoAnswerMeeting({
        meetingId: ringing.meeting.id,
        endedAt: new Date(),
      })
    ).toBeUndefined();
    expect((await readMeeting(ringing.meeting.id)).status).toBe('scheduled');

    const other = await ringCase();
    const booked = await bookLaterToday(other);
    const inPlace = await meetingRingsRepository.startOnMeeting({
      ...startInput(other),
      meetingId: booked.id,
    });
    if (inPlace === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.endRing({
      ringId: inPlace.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: other.callerUserId,
    });
    expect(
      await meetingRingsRepository.endNoAnswerMeeting({ meetingId: booked.id, endedAt: new Date() })
    ).toBeUndefined();
    expect(await readMeeting(booked.id)).toEqual(booked);
    expect(await findProjectionForMeeting(booked.id)).toMatchObject({ status: 'confirmed' });
  });
});

describe('meetingRingsRepository.endNoAnswerMeeting — never ends a connected call (connect, then a stale sweep)', () => {
  it('the sweep read a stale ringing ring, connect committed first: the in-progress call is left alone', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    // Connect commits before the sweep's `no_answer` decision is acted on (sequential here: the
    // harness has one connection; the ring-row lock is what serialises the real race).
    const connected = await meetingRingsRepository.connect({
      ringId: started.ring.id,
      startedAt: new Date(),
    });
    if (connected === undefined) throw new Error('ring did not connect');

    expect(
      await meetingRingsRepository.endNoAnswerMeeting({
        meetingId: started.meeting.id,
        endedAt: new Date(),
      })
    ).toBeUndefined();
    expect(await readMeeting(started.meeting.id)).toEqual(connected.meeting);
    expect(await auditRows(started.meeting.id, 'meeting.ended')).toEqual([]);
  });

  it('refuses a Call now meeting that has started, even when its only ring did not connect', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    await db
      .update(meetingRings)
      .set({ status: 'unanswered', endedAt: started.ring.expiresAt })
      .where(eq(meetingRings.id, started.ring.id));
    await db
      .update(meetings)
      .set({ status: 'in_progress', startedAt: new Date() })
      .where(eq(meetings.id, started.meeting.id));

    expect(
      await meetingRingsRepository.endNoAnswerMeeting({
        meetingId: started.meeting.id,
        endedAt: new Date(),
      })
    ).toBeUndefined();
    expect((await readMeeting(started.meeting.id)).status).toBe('in_progress');
  });

  it('still ends a `waiting_for_participants` Call now meeting whose ring went unanswered', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    await db
      .update(meetingRings)
      .set({ status: 'unanswered', endedAt: started.ring.expiresAt })
      .where(eq(meetingRings.id, started.ring.id));
    await db
      .update(meetings)
      .set({ status: 'waiting_for_participants' })
      .where(eq(meetings.id, started.meeting.id));

    const ended = await meetingRingsRepository.endNoAnswerMeeting({
      meetingId: started.meeting.id,
      endedAt: new Date(),
    });
    expect(ended?.meeting).toMatchObject({ status: 'ended', outcome: 'no_answer' });
  });
});

describe('meetingRingsRepository — every mutator is atomic with its audit row (AC9)', () => {
  it('startWithNewMeeting: a failing `meeting.ring_started` leaves no meeting, ring or audit row', async () => {
    const c = await ringCase();
    const forced = failAuditFor('meeting.ring_started');
    try {
      await expect(ringNewMeeting(c)).rejects.toThrow('forced meeting.ring_started failure');
    } finally {
      forced.restore();
    }

    expect(await meetingRingsRepository.findRingingForEngagement(c.engagementId)).toBeUndefined();
    const caseMeetings = await db
      .select()
      .from(meetingContexts)
      .where(eq(meetingContexts.contextId, c.engagementId));
    expect(caseMeetings).toEqual([]);
    const booked = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, c.callerUserId));
    expect(booked).toEqual([]);
  });

  it('endRing: a failing `meeting.ring_ended` rolls back the ring CAS, the meeting end and the projection', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    const forced = failAuditFor('meeting.ring_ended');
    try {
      await expect(
        meetingRingsRepository.endRing({
          ringId: started.ring.id,
          to: 'declined',
          now: new Date(),
          actorUserId: c.calleeUserId,
        })
      ).rejects.toThrow('forced meeting.ring_ended failure');
    } finally {
      forced.restore();
    }

    expect(await readRingStatus(started.ring.id)).toBe('ringing');
    expect(await readMeeting(started.meeting.id)).toEqual(started.meeting);
    expect(await findProjectionForMeeting(started.meeting.id)).toMatchObject({
      status: 'confirmed',
    });
    expect(await auditRows(started.meeting.id, 'meeting.ended')).toEqual([]);
    expect(await auditRows(started.meeting.id, 'meeting.ring_ended')).toEqual([]);
  });

  it('connect: a failing `meeting.ring_ended` rolls back the ring CAS, the move and the reschedule row', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');
    const forced = failAuditFor('meeting.ring_ended');
    try {
      await expect(
        meetingRingsRepository.connect({ ringId: started.ring.id, startedAt: new Date() })
      ).rejects.toThrow('forced meeting.ring_ended failure');
    } finally {
      forced.restore();
    }

    expect(await readRingStatus(started.ring.id)).toBe('ringing');
    expect(await readMeeting(booked.id)).toEqual(booked);
    expect(await auditRows(booked.id, 'meeting.rescheduled')).toEqual([]);
  });
});

describe('meetingRingsRepository — reads', () => {
  it('findById returns a live ring and nothing for an unknown or soft-deleted one', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    expect(await meetingRingsRepository.findById(started.ring.id)).toEqual(started.ring);
    expect(await meetingRingsRepository.findById(randomUUID())).toBeUndefined();

    await db
      .update(meetingRings)
      .set({ deletedAt: new Date() })
      .where(eq(meetingRings.id, started.ring.id));
    expect(await meetingRingsRepository.findById(started.ring.id)).toBeUndefined();
  });

  it('findRingingForMeeting / findRingingForEngagement return the ringing ring, expired or not, and ignore ended ones', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    expect(await meetingRingsRepository.findRingingForMeeting(started.meeting.id)).toEqual(
      started.ring
    );
    expect(await meetingRingsRepository.findRingingForEngagement(c.engagementId)).toEqual(
      started.ring
    );

    await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: c.callerUserId,
    });
    expect(await meetingRingsRepository.findRingingForMeeting(started.meeting.id)).toBeUndefined();
    expect(await meetingRingsRepository.findRingingForEngagement(c.engagementId)).toBeUndefined();
  });

  it('findByIdForParty returns the ring to its caller and callee only', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    const stranger = await userFactory();

    expect(await meetingRingsRepository.findByIdForParty(started.ring.id, c.callerUserId)).toEqual(
      started.ring
    );
    expect(await meetingRingsRepository.findByIdForParty(started.ring.id, c.calleeUserId)).toEqual(
      started.ring
    );
    expect(
      await meetingRingsRepository.findByIdForParty(started.ring.id, stranger.id)
    ).toBeUndefined();
    expect(
      await meetingRingsRepository.findByIdForParty(randomUUID(), c.callerUserId)
    ).toBeUndefined();
  });

  it('hasDeclinedSince sees a decline by this callee of this caller at or after `since` only', async () => {
    const c = await ringCase();
    const started = await ringNewMeeting(c);
    const declinedAt = new Date();
    await meetingRingsRepository.endRing({
      ringId: started.ring.id,
      to: 'declined',
      now: declinedAt,
      actorUserId: c.calleeUserId,
    });
    const pair = { callerUserId: c.callerUserId, calleeUserId: c.calleeUserId };

    expect(await meetingRingsRepository.hasDeclinedSince({ ...pair, since: declinedAt })).toBe(
      true
    );
    expect(
      await meetingRingsRepository.hasDeclinedSince({
        ...pair,
        since: new Date(declinedAt.getTime() + 1),
      })
    ).toBe(false);
    // Reversed roles, and a stop rather than a decline, do not count.
    expect(
      await meetingRingsRepository.hasDeclinedSince({
        callerUserId: c.calleeUserId,
        calleeUserId: c.callerUserId,
        since: new Date(0),
      })
    ).toBe(false);
    const other = await ringCase();
    const stopped = await ringNewMeeting(other);
    await meetingRingsRepository.endRing({
      ringId: stopped.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: other.callerUserId,
    });
    expect(
      await meetingRingsRepository.hasDeclinedSince({
        callerUserId: other.callerUserId,
        calleeUserId: other.calleeUserId,
        since: new Date(0),
      })
    ).toBe(false);
  });

  describe('countCallerRingsToCallee (BAL-651)', () => {
    const ringAt = new Date('2026-06-01T15:00:00.000Z');
    const windowStart = new Date(ringAt.getTime() - 24 * 60 * 60 * 1000);

    /** A fresh case for the same pair, so each seeded ring has its own one-ringing slot. */
    async function samePair(c: RingCase): Promise<RingCase> {
      const { engagement } = await caseEngagementFactory({ expertProfileId: c.expertProfileId });
      return { ...c, engagementId: engagement.id };
    }

    /** Ring on `c`, then force its `created_at` (and optionally status / soft delete). */
    async function seedAt(
      c: RingCase,
      createdAt: Date,
      overrides: { status?: 'connected' | 'unanswered'; deletedAt?: Date } = {}
    ): Promise<void> {
      const started = await ringNewMeeting(c);
      await db
        .update(meetingRings)
        .set({
          createdAt,
          ...(overrides.status === undefined
            ? {}
            : { status: overrides.status, endedAt: createdAt }),
          ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
        })
        .where(eq(meetingRings.id, started.ring.id));
    }

    const pairWindow = (c: RingCase) => ({
      callerUserId: c.callerUserId,
      calleeUserId: c.calleeUserId,
      endingAt: ringAt,
    });

    it('counts the pair’s rings of any status and case, both window ends included (exactly 24 h before counts)', async () => {
      const c = await ringCase();
      await seedAt(c, windowStart, { status: 'unanswered' });
      await seedAt(await samePair(c), new Date('2026-06-01T10:00:00.000Z'), {
        status: 'connected',
      });
      await seedAt(await samePair(c), ringAt);

      expect(await meetingRingsRepository.countCallerRingsToCallee(pairWindow(c))).toBe(3);
    });

    it('excludes the day before, after the ring, soft-deleted rings, another callee and the reverse direction', async () => {
      const c = await ringCase();
      await seedAt(c, ringAt);
      await seedAt(await samePair(c), new Date(windowStart.getTime() - 1), {
        status: 'unanswered',
      });
      await seedAt(await samePair(c), new Date(ringAt.getTime() + 1), { status: 'unanswered' });
      await seedAt(await samePair(c), new Date('2026-06-01T12:00:00.000Z'), {
        status: 'unanswered',
        deletedAt: new Date('2026-06-01T12:30:00.000Z'),
      });
      const otherCallee = await ringCase();
      await seedAt(
        { ...otherCallee, callerUserId: c.callerUserId },
        new Date('2026-06-01T11:00:00.000Z'),
        {
          status: 'unanswered',
        }
      );
      const reverse = await samePair(c);
      await seedAt(
        { ...reverse, callerUserId: c.calleeUserId, calleeUserId: c.callerUserId },
        new Date('2026-06-01T11:00:00.000Z'),
        { status: 'unanswered' }
      );

      expect(await meetingRingsRepository.countCallerRingsToCallee(pairWindow(c))).toBe(1);
    });

    it('answers 0 for a pair with no rings', async () => {
      const c = await ringCase();

      expect(await meetingRingsRepository.countCallerRingsToCallee(pairWindow(c))).toBe(0);
    });
  });

  describe('summarizeMissedCallWindow', () => {
    const since = new Date('2026-01-01T00:00:00.000Z');

    /** A second case between the SAME caller and callee, so the pair has more than one ring. */
    async function sameParties(c: RingCase): Promise<RingCase> {
      const { engagement } = await caseEngagementFactory({ expertProfileId: c.expertProfileId });
      return { ...c, engagementId: engagement.id };
    }

    /** Ring on `c` and force its status and `created_at`; the repository writes `ringing` at now. */
    async function seedRing(
      c: RingCase,
      status: 'unanswered' | 'connected' | 'declined' | 'stopped',
      createdAt: Date,
      overrides: { deletedAt?: Date; callerSide?: 'client' | 'expert' } = {}
    ): Promise<string> {
      const started = await ringNewMeeting(c);
      await db
        .update(meetingRings)
        .set({
          status,
          createdAt,
          endedAt: createdAt,
          deletedAt: overrides.deletedAt ?? null,
          ...(overrides.callerSide === undefined ? {} : { callerSide: overrides.callerSide }),
        })
        .where(eq(meetingRings.id, started.ring.id));
      return started.ring.id;
    }

    const pair = (c: RingCase) => ({
      callerUserId: c.callerUserId,
      calleeUserId: c.calleeUserId,
      since,
      now: new Date(),
    });

    it('counts unanswered rings and returns the latest one, with no connect or decline', async () => {
      const first = await ringCase();
      const second = await sameParties(first);
      await seedRing(first, 'unanswered', new Date('2026-06-01T10:00:00.000Z'));
      await seedRing(second, 'unanswered', new Date('2026-06-01T10:05:00.000Z'));

      expect(await meetingRingsRepository.summarizeMissedCallWindow(pair(first))).toEqual({
        unansweredCount: 2,
        latestUnanswered: {
          engagementId: second.engagementId,
          callerSide: 'client',
          createdAt: new Date('2026-06-01T10:05:00.000Z'),
        },
        connectedSince: false,
        calleeDeclinedSince: false,
        liveRingBetween: false,
      });
    });

    it('returns the latest unanswered ring’s own caller side, not the first ring’s', async () => {
      const first = await ringCase();
      const second = await sameParties(first);
      await seedRing(first, 'unanswered', new Date('2026-06-01T10:00:00.000Z'));
      await seedRing(second, 'unanswered', new Date('2026-06-01T10:05:00.000Z'), {
        callerSide: 'expert',
      });

      const summary = await meetingRingsRepository.summarizeMissedCallWindow(pair(first));

      expect(summary.latestUnanswered).toEqual({
        engagementId: second.engagementId,
        callerSide: 'expert',
        createdAt: new Date('2026-06-01T10:05:00.000Z'),
      });
    });

    it('reports an empty window as zero, null and false', async () => {
      const c = await ringCase();

      expect(await meetingRingsRepository.summarizeMissedCallWindow(pair(c))).toEqual({
        unansweredCount: 0,
        latestUnanswered: null,
        connectedSince: false,
        calleeDeclinedSince: false,
        liveRingBetween: false,
      });
    });

    it('sets connectedSince for a connect in EITHER direction, and a decline only caller → callee', async () => {
      const forward = await ringCase();
      await seedRing(forward, 'connected', new Date('2026-06-01T10:00:00.000Z'));
      expect(
        (await meetingRingsRepository.summarizeMissedCallWindow(pair(forward))).connectedSince
      ).toBe(true);

      const reverse = await ringCase();
      const callBack: RingCase = {
        ...reverse,
        callerUserId: reverse.calleeUserId,
        calleeUserId: reverse.callerUserId,
      };
      await seedRing(callBack, 'connected', new Date('2026-06-01T10:00:00.000Z'));
      const reverseSummary = await meetingRingsRepository.summarizeMissedCallWindow(pair(reverse));
      expect(reverseSummary.connectedSince).toBe(true);
      expect(reverseSummary.unansweredCount).toBe(0);

      const declined = await ringCase();
      await seedRing(declined, 'declined', new Date('2026-06-01T10:00:00.000Z'));
      expect(await meetingRingsRepository.summarizeMissedCallWindow(pair(declined))).toMatchObject({
        calleeDeclinedSince: true,
        connectedSince: false,
      });

      const declinedByCaller = await ringCase();
      await seedRing(
        {
          ...declinedByCaller,
          callerUserId: declinedByCaller.calleeUserId,
          calleeUserId: declinedByCaller.callerUserId,
        },
        'declined',
        new Date('2026-06-01T10:00:00.000Z')
      );
      expect(
        (await meetingRingsRepository.summarizeMissedCallWindow(pair(declinedByCaller)))
          .calleeDeclinedSince
      ).toBe(false);
    });

    it('does not count a reverse-direction unanswered ring, a stopped ring, or a ring of another pair', async () => {
      const c = await ringCase();
      await seedRing(
        { ...c, callerUserId: c.calleeUserId, calleeUserId: c.callerUserId },
        'unanswered',
        new Date('2026-06-01T10:00:00.000Z')
      );
      const stopped = await sameParties(c);
      await seedRing(stopped, 'stopped', new Date('2026-06-01T10:01:00.000Z'));
      const other = await ringCase();
      await seedRing(other, 'unanswered', new Date('2026-06-01T10:02:00.000Z'));

      expect(await meetingRingsRepository.summarizeMissedCallWindow(pair(c))).toEqual({
        unansweredCount: 0,
        latestUnanswered: null,
        connectedSince: false,
        calleeDeclinedSince: false,
        liveRingBetween: false,
      });
    });

    it('ignores soft-deleted rings and rings before `since`, and includes one exactly at `since`', async () => {
      const c = await ringCase();
      const deleted = await sameParties(c);
      const before = await sameParties(c);
      const atSince = await sameParties(c);
      await seedRing(deleted, 'unanswered', new Date('2026-06-01T10:00:00.000Z'), {
        deletedAt: new Date('2026-06-01T11:00:00.000Z'),
      });
      await seedRing(before, 'unanswered', new Date(since.getTime() - 1));
      await seedRing(atSince, 'unanswered', since);

      expect(await meetingRingsRepository.summarizeMissedCallWindow(pair(c))).toEqual({
        unansweredCount: 1,
        latestUnanswered: {
          engagementId: atSince.engagementId,
          callerSide: 'client',
          createdAt: since,
        },
        connectedSince: false,
        calleeDeclinedSince: false,
        liveRingBetween: false,
      });
    });
    describe('liveRingBetween', () => {
      /** A ring left `ringing`, with `expires_at` set explicitly. */
      async function seedLiveRing(c: RingCase, expiresAt: Date, deletedAt?: Date): Promise<void> {
        const started = await ringNewMeeting(c, { expiresAt });
        if (deletedAt !== undefined) {
          await db
            .update(meetingRings)
            .set({ deletedAt })
            .where(eq(meetingRings.id, started.ring.id));
        }
      }

      it('is true for an unexpired ringing ring in the caller → callee direction', async () => {
        const first = await ringCase();
        const live = await sameParties(first);
        await seedRing(first, 'unanswered', new Date('2026-06-01T10:00:00.000Z'));
        await seedLiveRing(live, new Date(Date.now() + HOUR_MS));

        const summary = await meetingRingsRepository.summarizeMissedCallWindow(pair(first));

        expect(summary.liveRingBetween).toBe(true);
        expect(summary.unansweredCount).toBe(1);
      });

      it('is true for a live ring in the REVERSE direction', async () => {
        const c = await ringCase();
        await seedLiveRing(
          { ...c, callerUserId: c.calleeUserId, calleeUserId: c.callerUserId },
          new Date(Date.now() + HOUR_MS)
        );

        expect(
          (await meetingRingsRepository.summarizeMissedCallWindow(pair(c))).liveRingBetween
        ).toBe(true);
      });

      it('is false once the ring has expired, even if its status is still ringing', async () => {
        const c = await ringCase();
        const started = await ringNewMeeting(c);
        await db
          .update(meetingRings)
          .set({
            createdAt: new Date(Date.now() - 2 * HOUR_MS),
            expiresAt: new Date(Date.now() - HOUR_MS),
          })
          .where(eq(meetingRings.id, started.ring.id));

        expect(
          (await meetingRingsRepository.summarizeMissedCallWindow(pair(c))).liveRingBetween
        ).toBe(false);
      });

      it('uses the supplied clock: a ring is live before its expiry and not at it', async () => {
        const c = await ringCase();
        const expiresAt = new Date(Date.now() + HOUR_MS);
        await seedLiveRing(c, expiresAt);

        expect(
          (
            await meetingRingsRepository.summarizeMissedCallWindow({
              ...pair(c),
              now: new Date(expiresAt.getTime() - 1),
            })
          ).liveRingBetween
        ).toBe(true);
        expect(
          (
            await meetingRingsRepository.summarizeMissedCallWindow({
              ...pair(c),
              now: expiresAt,
            })
          ).liveRingBetween
        ).toBe(false);
      });

      it('ignores a soft-deleted live ring and a live ring of another pair', async () => {
        const c = await ringCase();
        const deleted = await sameParties(c);
        await seedLiveRing(deleted, new Date(Date.now() + HOUR_MS), new Date());
        const other = await ringCase();
        await seedLiveRing(other, new Date(Date.now() + HOUR_MS));

        expect(
          (await meetingRingsRepository.summarizeMissedCallWindow(pair(c))).liveRingBetween
        ).toBe(false);
      });
    });
  });

  it('hasRingingOnOtherCompanyCase sees a ringing ring on another case of the company, not this one', async () => {
    const companyId = (await caseEngagementFactory()).engagement.companyId;
    const expert = await expertFactory();
    const otherExpert = await expertFactory();
    const caller = await userFactory();
    const { engagement: thisCase } = await caseEngagementFactory({
      companyId,
      expertProfileId: expert.id,
    });
    const { engagement: otherCase } = await caseEngagementFactory({
      companyId,
      expertProfileId: otherExpert.id,
    });
    const onOther = await ringNewMeeting({
      engagementId: otherCase.id,
      expertProfileId: otherExpert.id,
      callerUserId: caller.id,
      calleeUserId: otherExpert.userId,
    });

    expect(
      await meetingRingsRepository.hasRingingOnOtherCompanyCase({
        companyId,
        excludeEngagementId: thisCase.id,
      })
    ).toBe(true);
    expect(
      await meetingRingsRepository.hasRingingOnOtherCompanyCase({
        companyId,
        excludeEngagementId: otherCase.id,
      })
    ).toBe(false);

    await meetingRingsRepository.endRing({
      ringId: onOther.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: caller.id,
    });
    expect(
      await meetingRingsRepository.hasRingingOnOtherCompanyCase({
        companyId,
        excludeEngagementId: thisCase.id,
      })
    ).toBe(false);
  });

  it('listForMeeting lists every live ring on the meeting by `created_at`, ended ones included', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const first = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (first === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.endRing({
      ringId: first.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: c.callerUserId,
    });
    const second = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (second === undefined) throw new Error('ring did not start');
    // Both rows were written in this test's one transaction, so they share `created_at`. Move the
    // SECOND one earlier: the read must follow `created_at`, not insertion order.
    await db
      .update(meetingRings)
      .set({ createdAt: new Date(first.ring.createdAt.getTime() - MINUTE_MS) })
      .where(eq(meetingRings.id, second.ring.id));

    const rings = await meetingRingsRepository.listForMeeting(booked.id);
    expect(rings.map((ring) => ring.id)).toEqual([second.ring.id, first.ring.id]);
    expect(rings.map((ring) => ring.status)).toEqual(['ringing', 'stopped']);
    expect(await meetingRingsRepository.listForMeeting(randomUUID())).toEqual([]);
  });

  it('listFactsForMeetings batches every live ring across meetings, tagged with its meeting, and skips soft-deleted rings', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const inPlace = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (inPlace === undefined) throw new Error('ring did not start');
    const other = await ringCase();
    const fresh = await ringNewMeeting(other);
    const deletedCase = await ringCase();
    const deleted = await ringNewMeeting(deletedCase);
    await db
      .update(meetingRings)
      .set({ deletedAt: new Date() })
      .where(eq(meetingRings.id, deleted.ring.id));

    const facts = await meetingRingsRepository.listFactsForMeetings([
      booked.id,
      fresh.meeting.id,
      deleted.meeting.id,
    ]);

    expect(facts).toHaveLength(2);
    expect(facts).toEqual(
      expect.arrayContaining([
        {
          meetingId: booked.id,
          placement: 'in_place',
          status: 'ringing',
          createdAt: inPlace.ring.createdAt,
          expiresAt: inPlace.ring.expiresAt,
          endedAt: null,
        },
        expect.objectContaining({ meetingId: fresh.meeting.id, placement: 'new_meeting' }),
      ])
    );
  });

  it('listFactsForMeetings answers [] for an empty input and for meetings with no ring', async () => {
    expect(await meetingRingsRepository.listFactsForMeetings([])).toEqual([]);
    expect(await meetingRingsRepository.listFactsForMeetings([randomUUID()])).toEqual([]);
  });

  it('listInPlaceBookedStarts returns the booked start of an in-place ring that connected', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.connect({
      ringId: started.ring.id,
      startedAt: new Date(Date.now() + 10 * SECOND_MS),
    });

    const result = await meetingRingsRepository.listInPlaceBookedStarts([booked.id, randomUUID()]);

    expect(result).toEqual([{ meetingId: booked.id, bookedStart: booked.scheduledStart }]);
  });

  it('listInPlaceBookedStarts omits a ring that is still ringing, ended unconnected, or on a new meeting', async () => {
    const ringingCase = await ringCase();
    const ringingBooked = await bookLaterToday(ringingCase);
    await meetingRingsRepository.startOnMeeting({
      ...startInput(ringingCase),
      meetingId: ringingBooked.id,
    });

    const stoppedCase = await ringCase();
    const stoppedBooked = await bookLaterToday(stoppedCase);
    const stopped = await meetingRingsRepository.startOnMeeting({
      ...startInput(stoppedCase),
      meetingId: stoppedBooked.id,
    });
    if (stopped === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.endRing({
      ringId: stopped.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: stoppedCase.callerUserId,
    });

    const newCase = await ringCase();
    const fresh = await ringNewMeeting(newCase);
    await meetingRingsRepository.connect({
      ringId: fresh.ring.id,
      startedAt: new Date(fresh.meeting.scheduledStart.getTime() + 5 * SECOND_MS),
    });

    const result = await meetingRingsRepository.listInPlaceBookedStarts([
      ringingBooked.id,
      stoppedBooked.id,
      fresh.meeting.id,
    ]);

    expect(result).toEqual([]);
    expect(await meetingRingsRepository.listInPlaceBookedStarts([])).toEqual([]);
  });

  it('listInPlaceBookedStarts skips an audit row whose previous start does not parse', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.connect({
      ringId: started.ring.id,
      startedAt: new Date(Date.now() + 10 * SECOND_MS),
    });
    await db
      .update(auditEvents)
      .set({
        metadata: sql`jsonb_set(${auditEvents.metadata}, '{previousScheduledStart}', '"not-a-date"')`,
      })
      .where(
        and(eq(auditEvents.entityId, booked.id), eq(auditEvents.action, 'meeting.rescheduled'))
      );

    expect(await meetingRingsRepository.listInPlaceBookedStarts([booked.id])).toEqual([]);
  });

  it('listInPlaceBookedStarts takes the newest call_now_connected row for the meeting, and ignores other reschedule reasons', async () => {
    const c = await ringCase();
    const booked = await bookLaterToday(c);
    const started = await meetingRingsRepository.startOnMeeting({
      ...startInput(c),
      meetingId: booked.id,
    });
    if (started === undefined) throw new Error('ring did not start');
    await meetingRingsRepository.connect({
      ringId: started.ring.id,
      startedAt: new Date(Date.now() + 10 * SECOND_MS),
    });
    const newer = new Date(booked.scheduledStart.getTime() + 2 * HOUR_MS);
    await db.insert(auditEvents).values([
      {
        action: 'meeting.rescheduled',
        entityType: 'meeting',
        entityId: booked.id,
        metadata: { reason: 'call_now_connected', previousScheduledStart: newer.toISOString() },
      },
      {
        action: 'meeting.rescheduled',
        entityType: 'meeting',
        entityId: booked.id,
        metadata: {
          reason: 'party_reschedule',
          previousScheduledStart: new Date(0).toISOString(),
        },
      },
    ]);

    expect(await meetingRingsRepository.listInPlaceBookedStarts([booked.id])).toEqual([
      { meetingId: booked.id, bookedStart: newer },
    ]);
  });

  it('listOverdueRinging returns ringing rings past `expires_at`, soonest-expired first, within `limit`', async () => {
    const base = Date.now();
    const soonest = await ringNewMeeting(await ringCase(), {
      expiresAt: new Date(base + 10 * SECOND_MS),
    });
    const later = await ringNewMeeting(await ringCase(), {
      expiresAt: new Date(base + 20 * SECOND_MS),
    });
    const notYet = await ringNewMeeting(await ringCase(), {
      expiresAt: new Date(base + 40 * SECOND_MS),
    });
    const endedCase = await ringCase();
    const ended = await ringNewMeeting(endedCase, { expiresAt: new Date(base + 5 * SECOND_MS) });
    await meetingRingsRepository.endRing({
      ringId: ended.ring.id,
      to: 'stopped',
      now: new Date(),
      actorUserId: endedCase.callerUserId,
    });
    const now = new Date(base + 30 * SECOND_MS);

    const overdue = await meetingRingsRepository.listOverdueRinging({ now, limit: 10 });
    expect(overdue.map((ring) => ring.id)).toEqual([soonest.ring.id, later.ring.id]);
    expect(overdue.map((ring) => ring.id)).not.toContain(notYet.ring.id);

    const capped = await meetingRingsRepository.listOverdueRinging({ now, limit: 1 });
    expect(capped.map((ring) => ring.id)).toEqual([soonest.ring.id]);
    expect(await meetingRingsRepository.listOverdueRinging({ now, limit: 0 })).toEqual([]);
  });
});
