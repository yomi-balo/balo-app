import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { meetingContexts, meetings } from '../schema';
import { caseEngagementFactory, meetingFactory, projectRequestFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { meetingsRepository, MeetingContextRequiredError } from './meetings';

const HOUR_MS = 3_600_000;

function schedule(offsetHours = 1): { scheduledStart: Date; scheduledEnd: Date } {
  const start = Date.now() + offsetHours * HOUR_MS;
  return { scheduledStart: new Date(start), scheduledEnd: new Date(start + HOUR_MS) };
}

describe('meetingsRepository.create', () => {
  it('inserts the meeting AND its context row atomically, defaulting to status=scheduled', async () => {
    const { engagement } = await caseEngagementFactory();

    const { meeting, contexts } = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    expect(meeting.id).toBeDefined();
    expect(meeting.status).toBe('scheduled');
    expect(meeting.outcome).toBeNull();
    expect(meeting.startedAt).toBeNull();
    expect(meeting.endedAt).toBeNull();
    expect(meeting.dailyRoomName).toBeNull();
    expect(meeting.joinUrl).toBeNull();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.contextType).toBe('case');
    expect(contexts[0]?.contextId).toBe(engagement.id);
  });

  // ── THE THREE AC ROUND-TRIPS ─────────────────────────────────────────────
  it('AC round-trip 1 — attaches to an engagements.id (case)', async () => {
    const { engagement } = await caseEngagementFactory();

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const reloaded = await meetingsRepository.findWithContexts(created.meeting.id);

    expect(reloaded?.contexts).toHaveLength(1);
    expect(reloaded?.contexts[0]?.contextType).toBe('case');
    expect(reloaded?.contexts[0]?.contextId).toBe(engagement.id);
  });

  it('AC round-trip 2 — attaches to a project_requests.id (discovery, BEFORE any engagement exists)', async () => {
    const request = await projectRequestFactory();

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });
    const reloaded = await meetingsRepository.findWithContexts(created.meeting.id);

    expect(reloaded?.contexts[0]?.contextType).toBe('project_discovery');
    expect(reloaded?.contexts[0]?.contextId).toBe(request.id);
  });

  it('AC round-trip 3 — an ADMIN meeting has a context row with context_id = NULL', async () => {
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'admin', contextId: null }],
    });
    const reloaded = await meetingsRepository.findWithContexts(created.meeting.id);

    // Decision B: admin is a ROW with a NULL subject, never "zero rows" — so every reader
    // answers "what is this meeting for?" with ONE query against ONE table.
    expect(reloaded?.contexts).toHaveLength(1);
    expect(reloaded?.contexts[0]?.contextType).toBe('admin');
    expect(reloaded?.contexts[0]?.contextId).toBeNull();
  });

  it('an empty contexts array throws MeetingContextRequiredError and writes NOTHING', async () => {
    const before = await db.select({ id: meetings.id }).from(meetings);

    await expect(meetingsRepository.create({ ...schedule(), contexts: [] })).rejects.toBeInstanceOf(
      MeetingContextRequiredError
    );

    const after = await db.select({ id: meetings.id }).from(meetings);
    expect(after).toHaveLength(before.length);
  });

  it('rejects start >= end in-process with the SAME error updateSchedule raises (mirrored guard)', async () => {
    const { engagement } = await caseEngagementFactory();
    const start = new Date(Date.now() + HOUR_MS);
    const contexts = [{ contextType: 'case' as const, contextId: engagement.id }];

    // Both entry points must surface the SAME typed error — not a named error from one and
    // a raw 23514 from the other.
    await expect(
      meetingsRepository.create({ scheduledStart: start, scheduledEnd: start, contexts })
    ).rejects.toThrow(/scheduled_start must be before scheduled_end/);
    await expect(
      meetingsRepository.create({
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() - 1),
        contexts,
      })
    ).rejects.toThrow(/scheduled_start must be before scheduled_end/);
  });

  it('a Project meeting is creatable with NO credit_sessions row (nothing couples them)', async () => {
    const request = await projectRequestFactory();

    const { meeting } = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_kickoff', contextId: request.id }],
    });

    expect(await meetingsRepository.findById(meeting.id)).toBeDefined();
  });

  it('attaches MULTIPLE contexts in one create (D3 multi-context)', async () => {
    const request = await projectRequestFactory();
    const { engagement } = await caseEngagementFactory();

    const { contexts } = await meetingsRepository.create({
      ...schedule(),
      contexts: [
        { contextType: 'project_discovery', contextId: request.id },
        { contextType: 'project_kickoff', contextId: engagement.id },
      ],
    });

    expect(contexts).toHaveLength(2);
  });
});

describe('meetings — DB constraints', () => {
  it('scheduled_start >= scheduled_end is rejected (23514)', async () => {
    const start = new Date(Date.now() + HOUR_MS);

    // start == end
    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetings).values({ scheduledStart: start, scheduledEnd: start })
    );
    // start > end
    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetings)
        .values({ scheduledStart: start, scheduledEnd: new Date(start.getTime() - 1) })
    );
  });

  it('an outcome on a NON-ended meeting is rejected (23514)', async () => {
    const { scheduledStart, scheduledEnd } = schedule();

    await expectConstraintViolation('23514', (tx) =>
      tx
        .insert(meetings)
        .values({ scheduledStart, scheduledEnd, status: 'in_progress', outcome: 'completed' })
    );
  });

  it('an ended meeting may carry an outcome — and may also carry NONE (one-directional CHECK)', async () => {
    const { meeting: withOutcome } = await meetingFactory({
      values: { status: 'ended', outcome: 'no_show_client' },
    });
    const { meeting: withoutOutcome } = await meetingFactory({ values: { status: 'ended' } });

    expect(withOutcome.outcome).toBe('no_show_client');
    // NOT biconditional: BAL-134's `end` transition may stamp `ended` before the outcome
    // is decided, and that must not be a constraint violation.
    expect(withoutOutcome.outcome).toBeNull();
  });
});

describe('meetingsRepository.findByDailyRoomName / setVenue', () => {
  it('resolves a live meeting by its Daily room name', async () => {
    const roomName = `room-${randomUUID()}`;
    const { meeting } = await meetingFactory({ values: { dailyRoomName: roomName } });

    const found = await meetingsRepository.findByDailyRoomName(roomName);
    expect(found?.id).toBe(meeting.id);
  });

  it('setVenue stamps the room + join url (the BAL-129 provisioning seam)', async () => {
    const { meeting } = await meetingFactory();
    const roomName = `room-${randomUUID()}`;

    const updated = await meetingsRepository.setVenue(meeting.id, {
      dailyRoomName: roomName,
      joinUrl: `https://balo.daily.co/${roomName}`,
    });

    expect(updated.dailyRoomName).toBe(roomName);
    expect(updated.joinUrl).toBe(`https://balo.daily.co/${roomName}`);
    expect((await meetingsRepository.findByDailyRoomName(roomName))?.id).toBe(meeting.id);
  });

  it('TWO live meetings cannot share a daily_room_name (23505)', async () => {
    const roomName = `room-${randomUUID()}`;
    await meetingFactory({ values: { dailyRoomName: roomName } });

    await expectConstraintViolation('23505', (tx) =>
      tx.insert(meetings).values({ ...schedule(), dailyRoomName: roomName })
    );
  });

  it('MANY meetings may have a NULL daily_room_name (the unique is partial on IS NOT NULL)', async () => {
    // This must assert on `daily_room_name` ITSELF. An earlier version counted
    // `status='scheduled'` rows and never looked at the column — so it passed unchanged
    // even with the `daily_room_name IS NOT NULL` half of the index predicate deleted,
    // which is precisely the regression it exists to catch.
    const first = await meetingFactory();
    const second = await meetingFactory();

    expect(first.meeting.dailyRoomName).toBeNull();
    expect(second.meeting.dailyRoomName).toBeNull();

    // Both NULLs coexist under the UNIQUE index — reload from the DB so the assertion is
    // about persisted state, not the values the factory happened to return.
    const reloaded = await db
      .select({ id: meetings.id, dailyRoomName: meetings.dailyRoomName })
      .from(meetings)
      .where(inArray(meetings.id, [first.meeting.id, second.meeting.id]));
    expect(reloaded).toHaveLength(2);
    for (const row of reloaded) {
      expect(row.dailyRoomName).toBeNull();
    }
  });

  it('a SOFT-DELETED meeting frees its room name (partial unique on deleted_at)', async () => {
    const roomName = `room-${randomUUID()}`;
    const { meeting } = await meetingFactory({ values: { dailyRoomName: roomName } });

    await meetingsRepository.softDelete(meeting.id);

    const { meeting: reused } = await meetingFactory({ values: { dailyRoomName: roomName } });
    expect(reused.id).not.toBe(meeting.id);
    expect(await meetingsRepository.findByDailyRoomName(roomName)).toMatchObject({ id: reused.id });
  });
});

describe('meetingsRepository.updateSchedule', () => {
  it('moves both timestamps (the BAL-409 reschedule seam)', async () => {
    const { meeting } = await meetingFactory();
    const next = schedule(48);

    const updated = await meetingsRepository.updateSchedule(meeting.id, next);

    expect(updated.scheduledStart.getTime()).toBe(next.scheduledStart.getTime());
    expect(updated.scheduledEnd.getTime()).toBe(next.scheduledEnd.getTime());
  });

  it('rejects start >= end in-process, before the CHECK sees it', async () => {
    const { meeting } = await meetingFactory();
    const start = new Date(Date.now() + HOUR_MS);

    await expect(
      meetingsRepository.updateSchedule(meeting.id, { scheduledStart: start, scheduledEnd: start })
    ).rejects.toThrow(/scheduled_start must be before scheduled_end/);
  });

  it('throws on a missing meeting', async () => {
    await expect(meetingsRepository.updateSchedule(randomUUID(), schedule())).rejects.toThrow(
      /Meeting not found/
    );
  });
});

describe('meetingsRepository.softDelete', () => {
  it('stamps the meeting AND its context rows, and permits RE-ATTACHING the same context', async () => {
    const { engagement } = await caseEngagementFactory();
    const first = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    await meetingsRepository.softDelete(first.meeting.id);

    // Parent gone from the live read…
    expect(await meetingsRepository.findById(first.meeting.id)).toBeUndefined();
    expect(await meetingsRepository.findWithContexts(first.meeting.id)).toBeUndefined();

    // …and so are the CHILD rows. Stamping the parent alone would leave them occupying
    // `meeting_context_unique_idx` (partial on deleted_at) — the softDeleteEngagementTx lesson.
    const liveChildren = await db
      .select({ id: meetingContexts.id })
      .from(meetingContexts)
      .where(
        and(
          eq(meetingContexts.meetingId, first.meeting.id),
          eq(meetingContexts.contextType, 'case')
        )
      );
    expect(liveChildren).toHaveLength(1); // the row still exists…
    const [child] = await db
      .select()
      .from(meetingContexts)
      .where(eq(meetingContexts.meetingId, first.meeting.id));
    expect(child?.deletedAt).not.toBeNull(); // …but it is stamped

    // The same context re-attaches to a NEW meeting without a 23505.
    const second = await meetingsRepository.create({
      ...schedule(2),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    expect(second.contexts).toHaveLength(1);
  });
});
