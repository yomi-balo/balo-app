import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, consultations, meetingContexts, meetings, type AuditEvent } from '../schema';
import {
  caseEngagementFactory,
  expertDraftFactory,
  meetingFactory,
  projectRequestFactory,
  userFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  meetingsRepository,
  MeetingContextRequiredError,
  MeetingNotReschedulableError,
} from './meetings';

const HOUR_MS = 3_600_000;

function schedule(offsetHours = 1): { scheduledStart: Date; scheduledEnd: Date } {
  const start = Date.now() + offsetHours * HOUR_MS;
  return { scheduledStart: new Date(start), scheduledEnd: new Date(start + HOUR_MS) };
}

/** Audit rows for one entity (BAL-344 generic table, ordered createdAt asc). */
async function auditEventsForEntity(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
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

  it('AC round-trip 3 — an ADMIN meeting has a context row with context_id = NULL, and books NOBODY', async () => {
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

    // BAL-428 AC #5: an `admin` context resolves to no expert, so the meeting projects NO
    // `consultations` row and occupies nobody's calendar. `expertProfileId` is null, which
    // is also how the caller learns there is no availability cache to rebuild.
    expect(created.expertProfileId).toBeNull();
    const projections = await db
      .select({ id: consultations.id })
      .from(consultations)
      .where(eq(consultations.meetingId, created.meeting.id));
    expect(projections).toEqual([]);
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
    // ⚠ FIXTURE CORRECTED BY BAL-428. This test used to pass a `project_requests.id` as a
    // `project_kickoff` context. Per `meetingContextTypeEnum`'s map, `project_kickoff`
    // resolves to `engagements.id` — and it only "worked" because `context_id` has no FK,
    // so the wrong-table id succeeded silently. The projection resolver now reads that
    // column for real and rejects it (`MeetingContextUnresolvableError`), which surfaced a
    // latent modelling error in the fixture. The FIXTURE is what was wrong; the resolver is
    // right. Do not relax the resolver to make this pass.
    const { engagement } = await caseEngagementFactory();

    const { meeting } = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_kickoff', contextId: engagement.id }],
    });

    expect(await meetingsRepository.findById(meeting.id)).toBeDefined();
  });

  it('attaches MULTIPLE contexts in one create (D3 multi-context)', async () => {
    // ⚠ FIXTURE CORRECTED BY BAL-428. Two independent factories mean two DIFFERENT experts,
    // so this booking named two calendars and now raises `MeetingExpertAmbiguousError`.
    // A real multi-context meeting — a discovery call that gains an engagement row at
    // kickoff — is ONE expert throughout, which is what this fixture now seeds.
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ expertProfileId: expert.id });
    const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });

    const { contexts, expertProfileId } = await meetingsRepository.create({
      ...schedule(),
      contexts: [
        { contextType: 'project_discovery', contextId: request.id },
        { contextType: 'project_kickoff', contextId: engagement.id },
      ],
    });

    expect(contexts).toHaveLength(2);
    expect(expertProfileId).toBe(expert.id);
  });
});

/**
 * BAL-129 — THE ADR-1030 AUDIT ROW, against a real database (ADR-1044 §5: "state change and
 * audit event in the same transaction").
 *
 * These are the claims a mocked test CANNOT make: that a row genuinely lands in
 * `audit_events`, that its `actor_user_id` FK is genuinely enforced, and that a failure of the
 * audit insert genuinely takes the whole booking down with it. The complementary claim — that
 * the row is written on the booking's `tx` and not the base `db` — is indistinguishable here
 * (both spellings look the same on the happy path) and lives in `meetings.test.ts`.
 */
describe('meetingsRepository.create — the meeting.booked audit row', () => {
  it('writes EXACTLY ONE meeting.booked row naming the booking user', async () => {
    const actor = await userFactory();
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const window = schedule();

    const created = await meetingsRepository.create({
      ...window,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      actorUserId: actor.id,
    });

    const rows = await auditEventsForEntity(created.meeting.id);
    const booked = rows.filter((row) => row.action === 'meeting.booked');
    expect(booked).toHaveLength(1);

    const [event] = booked;
    expect(event?.entityType).toBe('meeting');
    expect(event?.entityId).toBe(created.meeting.id);
    // THE WHOLE POINT OF THE TICKET: the individual, not merely the party. The company was
    // always recoverable through `meeting_contexts` → engagement → `company_id`.
    expect(event?.actorUserId).toBe(actor.id);
    expect(event?.metadata).toEqual({
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      scheduledStart: window.scheduledStart.toISOString(),
      scheduledEnd: window.scheduledEnd.toISOString(),
      // Whose calendar this booking blocked, resolved at write time.
      expertProfileId,
    });
  });

  it('writes the row with a NULL actor when none is passed — the dev seeder’s path', async () => {
    // ADR-1030 SYSTEM-ACTOR ATTRIBUTION EXEMPTION. `services/seed/seed-service.ts` passes no
    // actor because a seed run has no human behind it; `actor_user_id` is a nullable FK, so
    // the row is UNATTRIBUTED rather than carrying a fabricated user.
    const { engagement } = await caseEngagementFactory();

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const booked = (await auditEventsForEntity(created.meeting.id)).filter(
      (row) => row.action === 'meeting.booked'
    );
    expect(booked).toHaveLength(1);
    expect(booked[0]?.actorUserId).toBeNull();
  });

  it('audits an ADMIN meeting too, with a null expert — it blocks nobody but somebody booked it', async () => {
    const actor = await userFactory();

    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'admin', contextId: null }],
      actorUserId: actor.id,
    });

    const [event] = (await auditEventsForEntity(created.meeting.id)).filter(
      (row) => row.action === 'meeting.booked'
    );
    expect(event?.actorUserId).toBe(actor.id);
    expect(event?.metadata).toMatchObject({
      contexts: [{ contextType: 'admin', contextId: null }],
      expertProfileId: null,
    });
  });

  it('ROLLS BACK THE WHOLE BOOKING when the audit insert fails — zero audit rows, zero meetings', async () => {
    // ⚠ THE ATOMICITY CLAIM, PROVED IN THE ONLY DIRECTION A REAL DATABASE CAN PROVE IT.
    // `audit_events.actor_user_id` is an FK to `users` (ON DELETE restrict), so an actor id
    // that names no user makes the AUDIT INSERT — the last statement in `create`'s
    // transaction — fail 23503. Everything before it (the meeting, its context row, the
    // `consultations` projection) is already written at that point, so if the audit row were
    // NOT part of this transaction the booking would survive and only the audit would be lost.
    // Asserting the meeting is gone is therefore what proves the two share a transaction.
    //
    // `create` opens its own `db.transaction`, which is a SAVEPOINT inside the harness's
    // per-test transaction — so this rollback is contained and the reads below still run.
    const { engagement } = await caseEngagementFactory();
    const orphanActorId = randomUUID();
    const window = schedule();

    const before = await db.select({ id: meetings.id }).from(meetings);

    await expect(
      meetingsRepository.create({
        ...window,
        contexts: [{ contextType: 'case', contextId: engagement.id }],
        actorUserId: orphanActorId,
      })
    ).rejects.toMatchObject({ code: '23503' });

    // No audit row survived the rollback…
    const orphanAudit = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, orphanActorId));
    expect(orphanAudit).toEqual([]);

    // …and neither did the booking it would have attested to.
    const after = await db.select({ id: meetings.id }).from(meetings);
    expect(after).toHaveLength(before.length);

    // Nor the projection — the slot was never blocked.
    const projections = await db
      .select({ id: consultations.id })
      .from(consultations)
      .where(eq(consultations.startAt, window.scheduledStart));
    expect(projections).toEqual([]);
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

    // BAL-428: returns `MeetingMutationResult`, not a bare `Meeting` — the caller needs the
    // `expertProfileId` to rebuild that expert's availability cache post-commit.
    const { meeting: updated } = await meetingsRepository.updateSchedule(meeting.id, next);

    expect(updated.scheduledStart.getTime()).toBe(next.scheduledStart.getTime());
    expect(updated.scheduledEnd.getTime()).toBe(next.scheduledEnd.getTime());
  });

  it('reports NO expert for a raw meeting that carries no projection row', async () => {
    // `meetingFactory` inserts directly, so there is no `consultations` row to read the
    // expert from. `null` is the honest answer — and it is how the caller learns there is
    // nothing to rebuild, rather than being handed an id it would rebuild for no reason.
    const { meeting } = await meetingFactory();

    const { expertProfileId } = await meetingsRepository.updateSchedule(meeting.id, schedule(48));

    expect(expertProfileId).toBeNull();
  });

  it('rejects start >= end in-process, before the CHECK sees it', async () => {
    const { meeting } = await meetingFactory();
    const start = new Date(Date.now() + HOUR_MS);

    await expect(
      meetingsRepository.updateSchedule(meeting.id, { scheduledStart: start, scheduledEnd: start })
    ).rejects.toThrow(/scheduled_start must be before scheduled_end/);
  });

  it('throws MeetingNotReschedulableError on a missing meeting', async () => {
    // BAL-428 CHANGED THIS ERROR. `updateSchedule` is now guarded on
    // `status IN ('scheduled','waiting_for_participants') AND deleted_at IS NULL`, so a
    // missing row and a cancelled/ended/deleted one are indistinguishable to the UPDATE and
    // share ONE named error. The status half of that guard — and the cancel-then-reschedule
    // double-booking it closes — is asserted in
    // `_shared/consultation-projection.integration.test.ts`, which owns the projection.
    await expect(
      meetingsRepository.updateSchedule(randomUUID(), schedule())
    ).rejects.toBeInstanceOf(MeetingNotReschedulableError);
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
