import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  consultations,
  engagements,
  meetingContexts,
  meetingGuests,
  meetings,
  type AuditEvent,
} from '../schema';
import {
  caseEngagementFactory,
  engagementFactory,
  expertDraftFactory,
  meetingFactory,
  meetingGuestFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
  userFactory,
} from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { findProjectionForMeeting } from './_shared/consultation-projection';
import { InvalidPresenceTimestampError, meetingPresenceRepository } from './meeting-presence';
import {
  meetingsRepository,
  MeetingContextRequiredError,
  MeetingNotReschedulableError,
  CalendarRangeTooWideError,
  MAX_CALENDAR_RANGE_DAYS,
} from './meetings';

/**
 * BAL-410 — `meetingsRepository.cancel` now takes an AUDIT TUPLE, because every cancel writes
 * a `meeting.cancelled` row. A test harness has no acting human, so it passes the sanctioned
 * ADR-1030 SYSTEM-ACTOR EXEMPTION: an unattributed row, never a fabricated actor.
 */
const SYSTEM_CANCEL_AUDIT = { actorUserId: null, actorRole: 'system' } as const;

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

    // BAL-428: returns `RescheduleMutationResult`, not a bare `Meeting` — the caller needs the
    // `expertProfileId` to rebuild that expert's availability cache post-commit.
    const { meeting: updated } = await meetingsRepository.updateSchedule(meeting.id, next, {
      actorUserId: null,
    });

    expect(updated.scheduledStart.getTime()).toBe(next.scheduledStart.getTime());
    expect(updated.scheduledEnd.getTime()).toBe(next.scheduledEnd.getTime());
  });

  it('reports NO expert for a raw meeting that carries no projection row', async () => {
    // `meetingFactory` inserts directly, so there is no `consultations` row to read the
    // expert from. `null` is the honest answer — and it is how the caller learns there is
    // nothing to rebuild, rather than being handed an id it would rebuild for no reason.
    const { meeting } = await meetingFactory();

    const { expertProfileId } = await meetingsRepository.updateSchedule(meeting.id, schedule(48), {
      actorUserId: null,
    });

    expect(expertProfileId).toBeNull();
  });

  it('rejects start >= end in-process, before the CHECK sees it', async () => {
    const { meeting } = await meetingFactory();
    const start = new Date(Date.now() + HOUR_MS);

    await expect(
      meetingsRepository.updateSchedule(
        meeting.id,
        { scheduledStart: start, scheduledEnd: start },
        { actorUserId: null }
      )
    ).rejects.toThrow(/scheduled_start must be before scheduled_end/);
  });

  it('throws MeetingNotReschedulableError on a missing meeting', async () => {
    // BAL-409 NARROWED THIS GUARD to `status = 'scheduled' AND deleted_at IS NULL` (was
    // `IN ('scheduled','waiting_for_participants')`), so a missing row and a
    // cancelled/ended/waiting_for_participants/deleted one are ALL indistinguishable to the
    // UPDATE and share ONE named error. The status half of that guard — and the
    // cancel-then-reschedule double-booking it closes — is asserted in
    // `_shared/consultation-projection.integration.test.ts`, which owns the projection.
    await expect(
      meetingsRepository.updateSchedule(randomUUID(), schedule(), { actorUserId: null })
    ).rejects.toBeInstanceOf(MeetingNotReschedulableError);
  });

  it('writes the meeting.rescheduled audit row on the SAME tx, with the from/to window as ISO strings', async () => {
    const actor = await userFactory();
    const { meeting } = await meetingFactory();
    const next = schedule(48);

    const result = await meetingsRepository.updateSchedule(meeting.id, next, {
      actorUserId: actor.id,
    });

    expect(result.previous.scheduledStart.getTime()).toBe(meeting.scheduledStart.getTime());
    expect(result.previous.scheduledEnd.getTime()).toBe(meeting.scheduledEnd.getTime());

    const audits = await auditEventsForEntity(meeting.id);
    const rescheduled = audits.filter((row) => row.action === 'meeting.rescheduled');
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0]?.actorUserId).toBe(actor.id);
    const metadata = rescheduled[0]?.metadata as Record<string, unknown> | null;
    expect(metadata?.previousScheduledStart).toBe(meeting.scheduledStart.toISOString());
    expect(metadata?.scheduledStart).toBe(next.scheduledStart.toISOString());
  });

  it('a NULL actorUserId is the ADR-1030 system-actor exemption, not a miss', async () => {
    const { meeting } = await meetingFactory();

    await meetingsRepository.updateSchedule(meeting.id, schedule(48), { actorUserId: null });

    const audits = await auditEventsForEntity(meeting.id);
    expect(audits.find((row) => row.action === 'meeting.rescheduled')?.actorUserId).toBeNull();
  });

  it('extends every LIVE guest link on the SAME tx, returning the moved count', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + HOUR_MS);
    const guest = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon },
    });

    const far = schedule(24 * 30);
    const result = await meetingsRepository.updateSchedule(meeting.id, far, {
      actorUserId: null,
    });

    expect(result.guestLinksExtended).toBe(1);
    const [row] = await db.select().from(meetingGuests).where(eq(meetingGuests.id, guest.guest.id));
    expect(row?.expiresAt.getTime()).toBeGreaterThan(soon.getTime());
  });

  it('a ROLLED-BACK move (guard miss) leaves NO audit row and NO guest-expiry change', async () => {
    const { meeting } = await meetingFactory();
    const soon = new Date(Date.now() + HOUR_MS);
    const guest = await meetingGuestFactory({
      meetingId: meeting.id,
      values: { expiresAt: soon },
    });
    await db.update(meetings).set({ status: 'cancelled' }).where(eq(meetings.id, meeting.id));

    await expect(
      meetingsRepository.updateSchedule(meeting.id, schedule(48), { actorUserId: null })
    ).rejects.toBeInstanceOf(MeetingNotReschedulableError);

    const audits = await auditEventsForEntity(meeting.id);
    expect(audits.filter((row) => row.action === 'meeting.rescheduled')).toHaveLength(0);
    const [row] = await db.select().from(meetingGuests).where(eq(meetingGuests.id, guest.guest.id));
    expect(row?.expiresAt.getTime()).toBe(soon.getTime());
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

// ── BAL-134 / ADR-1049 — THE LIFECYCLE TRANSITIONS (§4.3) ──────────────────────────────────

/** A meeting scheduled `offsetMinutes` from now, in whatever status the test needs. */
async function lifecycleMeeting(
  status: 'scheduled' | 'waiting_for_participants' | 'in_progress',
  offsetMinutes = -30
): Promise<string> {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  const { meeting } = await meetingFactory({
    values: { status, scheduledStart: start, scheduledEnd: new Date(start.getTime() + HOUR_MS) },
  });
  return meeting.id;
}

describe('meetingsRepository.listLifecycleCandidates', () => {
  it('returns live, in-status meetings at or after the lookback floor, OLDEST FIRST', async () => {
    const older = await lifecycleMeeting('waiting_for_participants', -50);
    const newer = await lifecycleMeeting('scheduled', -10);
    const inProgress = await lifecycleMeeting('in_progress', -30);

    const rows = await meetingsRepository.listLifecycleCandidates({
      statuses: ['scheduled', 'waiting_for_participants', 'in_progress'],
      scheduledStartAfter: new Date(Date.now() - 24 * HOUR_MS),
      limit: 50,
    });

    const ids = rows.map((row) => row.id);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    expect(ids).toContain(inProgress);
    // Ascending, so a caller that fills its batch can name the OLDEST scheduled_start it
    // reached in the no-silent-caps warning.
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(inProgress));
    expect(ids.indexOf(inProgress)).toBeLessThan(ids.indexOf(newer));
  });

  it('EXCLUDES terminal statuses, soft-deleted meetings, and anything before the floor', async () => {
    const ended = await lifecycleMeeting('scheduled', -20);
    await meetingsRepository.endMeeting({
      id: ended,
      outcome: 'missed_call',
      endedBy: 'system_idle',
      endedAt: new Date(),
      actorUserId: null,
    });
    const cancelledSeed = await meetingFactory({
      values: { scheduledStart: new Date(Date.now() - 20 * 60_000) },
    });
    await meetingsRepository.cancel(cancelledSeed.meeting.id, SYSTEM_CANCEL_AUDIT);
    const deleted = await lifecycleMeeting('waiting_for_participants', -20);
    await meetingsRepository.softDelete(deleted);
    // ⚠ THE LOOKBACK FLOOR IS THE ONLY THING BOUNDING THE SCAN. A meeting three days stale is
    // a data-repair problem, not a live meeting — and without the floor the sweep's cost grows
    // without limit forever.
    const ancient = await lifecycleMeeting('waiting_for_participants', -3 * 24 * 60);
    const live = await lifecycleMeeting('in_progress', -5);

    const ids = (
      await meetingsRepository.listLifecycleCandidates({
        statuses: ['scheduled', 'waiting_for_participants', 'in_progress'],
        scheduledStartAfter: new Date(Date.now() - 24 * HOUR_MS),
        limit: 50,
      })
    ).map((row) => row.id);

    expect(ids).toContain(live);
    expect(ids).not.toContain(ended);
    expect(ids).not.toContain(cancelledSeed.meeting.id);
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(ancient);
  });

  it('honours the batch limit — the bound the caller must warn about when it fills', async () => {
    await lifecycleMeeting('scheduled', -30);
    await lifecycleMeeting('scheduled', -29);
    await lifecycleMeeting('scheduled', -28);

    const rows = await meetingsRepository.listLifecycleCandidates({
      statuses: ['scheduled'],
      scheduledStartAfter: new Date(Date.now() - 24 * HOUR_MS),
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it('short-circuits an empty status list and a non-positive limit without querying', async () => {
    await lifecycleMeeting('scheduled', -30);

    await expect(
      meetingsRepository.listLifecycleCandidates({
        statuses: [],
        scheduledStartAfter: new Date(Date.now() - 24 * HOUR_MS),
        limit: 50,
      })
    ).resolves.toEqual([]);
    await expect(
      meetingsRepository.listLifecycleCandidates({
        statuses: ['scheduled'],
        scheduledStartAfter: new Date(Date.now() - 24 * HOUR_MS),
        limit: 0,
      })
    ).resolves.toEqual([]);
  });
});

describe('meetingsRepository.markWaitingForParticipants / markInProgress', () => {
  it('moves scheduled → waiting_for_participants, stamping NOTHING else', async () => {
    const id = await lifecycleMeeting('scheduled');

    const moved = await meetingsRepository.markWaitingForParticipants(id);

    expect(moved?.status).toBe('waiting_for_participants');
    // `started_at` belongs to `in_progress` — it means "the consultation began", not
    // "somebody opened the door".
    expect(moved?.startedAt).toBeNull();
    expect(moved?.endedAt).toBeNull();
    expect(moved?.endedBy).toBeNull();
  });

  it('a SECOND call returns undefined — the common case, not an error', async () => {
    const id = await lifecycleMeeting('scheduled');
    expect(await meetingsRepository.markWaitingForParticipants(id)).toBeDefined();

    // The second, third and fourth participants to join all reach this with the meeting
    // already moved, and two webhooks racing the first join both call it.
    expect(await meetingsRepository.markWaitingForParticipants(id)).toBeUndefined();
    expect((await meetingsRepository.findById(id))?.status).toBe('waiting_for_participants');
  });

  it('markInProgress stamps started_at from waiting_for_participants', async () => {
    const id = await lifecycleMeeting('waiting_for_participants');
    const startedAt = new Date(Date.now() - 3 * 60_000);

    const moved = await meetingsRepository.markInProgress(id, startedAt);

    expect(moved?.status).toBe('in_progress');
    expect(moved?.startedAt?.getTime()).toBe(startedAt.getTime());
  });

  it('markInProgress also accepts scheduled — the SAME-INSTANT DOUBLE JOIN', async () => {
    const id = await lifecycleMeeting('scheduled');

    // §4.1 declares `scheduled → in_progress` legal. Requiring the intermediate state would
    // leave such a meeting stuck at `scheduled` and therefore matched by the MISSED-CALL rule
    // — ending a call that is actually running.
    const moved = await meetingsRepository.markInProgress(id, new Date());
    expect(moved?.status).toBe('in_progress');
  });

  it('⚠ started_at CANNOT be overwritten by a later markInProgress (the rejoin guard)', async () => {
    const id = await lifecycleMeeting('waiting_for_participants');
    const first = new Date(Date.now() - 10 * 60_000);
    await meetingsRepository.markInProgress(id, first);

    // `in_progress` is not in the FROM set, so the second caller matches zero rows. Every
    // clock anchored on `started_at` is therefore stable across a drop+rejoin.
    expect(await meetingsRepository.markInProgress(id, new Date())).toBeUndefined();
    expect((await meetingsRepository.findById(id))?.startedAt?.getTime()).toBe(first.getTime());
  });

  it('neither mutator touches a terminal, soft-deleted or unknown meeting', async () => {
    const cancelled = await meetingFactory();
    await meetingsRepository.cancel(cancelled.meeting.id, SYSTEM_CANCEL_AUDIT);
    const deleted = await lifecycleMeeting('scheduled');
    await meetingsRepository.softDelete(deleted);
    const unknown = randomUUID();

    expect(
      await meetingsRepository.markWaitingForParticipants(cancelled.meeting.id)
    ).toBeUndefined();
    expect(
      await meetingsRepository.markInProgress(cancelled.meeting.id, new Date())
    ).toBeUndefined();
    expect(await meetingsRepository.markWaitingForParticipants(deleted)).toBeUndefined();
    expect(await meetingsRepository.markInProgress(deleted, new Date())).toBeUndefined();
    expect(await meetingsRepository.markWaitingForParticipants(unknown)).toBeUndefined();
    expect(await meetingsRepository.markInProgress(unknown, new Date())).toBeUndefined();

    expect((await meetingsRepository.findById(cancelled.meeting.id))?.status).toBe('cancelled');
  });
});

describe('meetingsRepository.endMeeting', () => {
  /** Open an expert interval on a meeting, `minutesAgo` in the past. */
  async function openExpertInterval(meetingId: string, minutesAgo: number): Promise<string> {
    const expert = await userFactory();
    const opened = await meetingPresenceRepository.open({
      meetingId,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    return opened.id;
  }

  it('⚠⚠ ONE STATEMENT: status, ended_at, ended_by and outcome are stamped TOGETHER', async () => {
    const id = await lifecycleMeeting('in_progress');
    const endedAt = new Date(Date.now() - 60_000);

    const result = await meetingsRepository.endMeeting({
      id,
      outcome: 'completed',
      endedBy: 'system_idle',
      endedAt,
      actorUserId: null,
    });

    // `resolveClockCeiling` prefers `meetings.ended_at` over the wall clock ONLY for a meeting
    // that is BOTH `ended` AND has a non-null `ended_at`. Split across two statements, a reader
    // landing between them sees `ended` with a NULL `ended_at`, falls back to the wall clock,
    // and measures every still-open interval to *now* — the 16-hour over-bill pinned in
    // `meeting-presence.integration.test.ts`. This assertion is that requirement, executed.
    const persisted = await meetingsRepository.findById(id);
    expect(persisted?.status).toBe('ended');
    expect(persisted?.endedAt?.getTime()).toBe(endedAt.getTime());
    expect(persisted?.endedBy).toBe('system_idle');
    expect(persisted?.outcome).toBe('completed');
    expect(result?.meeting.endedAt?.getTime()).toBe(endedAt.getTime());
  });

  it('closes EVERY open presence interval in the same transaction, clamped to ended_at', async () => {
    const id = await lifecycleMeeting('in_progress');
    await openExpertInterval(id, 30);
    const client = await userFactory();
    await meetingPresenceRepository.open({
      meetingId: id,
      userId: client.id,
      meetingGuestId: null,
      party: 'client',
      joinedAt: new Date(Date.now() - 25 * 60_000),
    });
    const endedAt = new Date(Date.now() - 5 * 60_000);

    const result = await meetingsRepository.endMeeting({
      id,
      outcome: 'completed',
      endedBy: 'expert_host',
      endedAt,
      actorUserId: null,
    });

    expect(result?.closedIntervals).toBe(2);
    // After this there is NO open interval left to mis-measure — the two guards (`ended_at`
    // as ceiling, and no open interval) are independent on purpose.
    expect(await meetingPresenceRepository.listOpen(id)).toHaveLength(0);
    for (const row of await meetingPresenceRepository.listByMeeting(id)) {
      expect(row.leftAt?.getTime()).toBe(endedAt.getTime());
    }
  });

  it('writes EXACTLY ONE meeting.ended audit row, carrying endedBy / outcome / closedIntervals', async () => {
    const id = await lifecycleMeeting('in_progress');
    await openExpertInterval(id, 20);
    const actor = await userFactory();
    const endedAt = new Date(Date.now() - 60_000);

    await meetingsRepository.endMeeting({
      id,
      outcome: null,
      endedBy: 'client_principal',
      endedAt,
      actorUserId: actor.id,
    });

    const rows = (await auditEventsForEntity(id)).filter((row) => row.action === 'meeting.ended');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorUserId).toBe(actor.id);
    expect(row?.entityType).toBe('meeting');
    expect(row?.metadata).toMatchObject({
      endedBy: 'client_principal',
      outcome: null,
      closedIntervals: 1,
      // ⚠ ISO STRING, NOT a Date — `metadata` is jsonb, so a Date round-trips as a string and
      // typing it otherwise would be a lie on the way back out.
      endedAt: endedAt.toISOString(),
    });
  });

  it('D5 — a HUMAN end leaves outcome NULL, which the one-directional CHECK permits', async () => {
    const id = await lifecycleMeeting('in_progress');
    const actor = await userFactory();

    const result = await meetingsRepository.endMeeting({
      id,
      outcome: null,
      endedBy: 'expert_host',
      endedAt: new Date(),
      actorUserId: actor.id,
    });

    // "The ender never sets the outcome" (ADR-1049) — BAL-412 resolves it from
    // `meeting_presence`. `meeting_outcome_requires_ended` is `outcome ⇒ ended`, never
    // biconditional, so `ended` + NULL outcome is legal and is exactly what this writes.
    expect(result?.meeting.outcome).toBeNull();
    expect(result?.meeting.endedBy).toBe('expert_host');
    expect(result?.meeting.status).toBe('ended');
  });

  it.each([
    ['scheduled' as const, 'missed_call' as const],
    ['waiting_for_participants' as const, 'no_show_client' as const],
    ['in_progress' as const, 'completed' as const],
  ])(
    'ends a %s meeting (the CAS is an EXCLUSION, so every non-terminal state is endable)',
    async (status, outcome) => {
      const id = await lifecycleMeeting(status);

      const result = await meetingsRepository.endMeeting({
        id,
        outcome,
        endedBy: 'system_idle',
        endedAt: new Date(),
        actorUserId: null,
      });

      // `scheduled` is included on purpose: that IS the missed-call path — nobody ever joined.
      expect(result?.meeting.status).toBe('ended');
      expect(result?.meeting.outcome).toBe(outcome);
    }
  );

  it('D10 — A SECOND END IS AN IDEMPOTENT NO-OP: undefined, and NOTHING changed', async () => {
    const id = await lifecycleMeeting('in_progress');
    const firstActor = await userFactory();
    const secondActor = await userFactory();
    const firstEndedAt = new Date(Date.now() - 10 * 60_000);

    const first = await meetingsRepository.endMeeting({
      id,
      outcome: 'completed',
      endedBy: 'expert_host',
      endedAt: firstEndedAt,
      actorUserId: firstActor.id,
    });
    expect(first).toBeDefined();

    // Two `canEndMeeting` holders press End at the same instant. The loser must get an
    // idempotent success, never a 409 surfaced as an error on the one control that must
    // always work.
    const second = await meetingsRepository.endMeeting({
      id,
      outcome: 'no_show_client',
      endedBy: 'client_principal',
      endedAt: new Date(),
      actorUserId: secondActor.id,
    });
    expect(second).toBeUndefined();

    const persisted = await meetingsRepository.findById(id);
    expect(persisted?.endedAt?.getTime()).toBe(firstEndedAt.getTime());
    expect(persisted?.endedBy).toBe('expert_host');
    expect(persisted?.outcome).toBe('completed');
    // No SECOND audit row — the losing end must leave no trace at all.
    expect(
      (await auditEventsForEntity(id)).filter((row) => row.action === 'meeting.ended')
    ).toHaveLength(1);
  });

  it('⚠ THE LOSING END ROLLS BACK ITS PRESENCE CLOSURES TOO — "undefined" means "changed nothing"', async () => {
    const id = await lifecycleMeeting('in_progress');
    await meetingsRepository.endMeeting({
      id,
      outcome: 'completed',
      endedBy: 'expert_host',
      endedAt: new Date(Date.now() - 10 * 60_000),
      actorUserId: null,
    });

    // A stray `participant.joined` lands AFTER the meeting was ended (the D2 replay shape).
    const straggler = await openExpertInterval(id, 5);

    // The presence close runs BEFORE the status CAS (the R5 ordering), so this second end
    // closes that interval and only THEN discovers it lost. Returning at that point would
    // COMMIT the closure on a call that is supposed to be a pure no-op; the transaction rolls
    // back instead.
    expect(
      await meetingsRepository.endMeeting({
        id,
        outcome: null,
        endedBy: 'client_principal',
        endedAt: new Date(),
        actorUserId: null,
      })
    ).toBeUndefined();

    const open = await meetingPresenceRepository.listOpen(id);
    expect(open.map((row) => row.id)).toEqual([straggler]);
  });

  it('refuses a CANCELLED, a SOFT-DELETED and an unknown meeting, all as undefined', async () => {
    const cancelled = await meetingFactory();
    await meetingsRepository.cancel(cancelled.meeting.id, SYSTEM_CANCEL_AUDIT);
    const deleted = await lifecycleMeeting('in_progress');
    await meetingsRepository.softDelete(deleted);

    for (const id of [cancelled.meeting.id, deleted, randomUUID()]) {
      expect(
        await meetingsRepository.endMeeting({
          id,
          outcome: 'completed',
          endedBy: 'system_idle',
          endedAt: new Date(),
          actorUserId: null,
        })
      ).toBeUndefined();
    }

    // A cancelled meeting stays cancelled — `ended` must never overwrite it.
    expect((await meetingsRepository.findById(cancelled.meeting.id))?.status).toBe('cancelled');
  });

  it('THE RESIDUAL CLOSED: after endMeeting, clocks() measures to ended_at, never the wall clock', async () => {
    const id = await lifecycleMeeting('in_progress');
    const expert = await userFactory();
    const client = await userFactory();
    const joinedAt = new Date(Date.now() - 40 * 60_000);
    await meetingPresenceRepository.open({
      meetingId: id,
      userId: expert.id,
      meetingGuestId: null,
      party: 'expert',
      joinedAt,
    });
    await meetingPresenceRepository.open({
      meetingId: id,
      userId: client.id,
      meetingGuestId: null,
      party: 'client',
      joinedAt,
    });

    const endedAt = new Date(joinedAt.getTime() + 30 * 60_000);
    await meetingsRepository.endMeeting({
      id,
      outcome: 'completed',
      endedBy: 'expert_host',
      endedAt,
      actorUserId: null,
    });

    // No explicit `now` — exactly how a settlement job (BAL-412) would call it. Both intervals
    // were open when the meeting ended; both are now closed AT `ended_at`, and `ended_at` is
    // additionally the resolved ceiling. 30 minutes, not "however long ago that was".
    const clocks = await meetingPresenceRepository.clocks(id);
    expect(clocks.billableMs).toBe(30 * 60_000);
    expect(clocks.expertPresentMs).toBe(30 * 60_000);
  });

  it('writes NO consultation projection change — an ended meeting still occupies the slot', async () => {
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const before = await findProjectionForMeeting(created.meeting.id);
    expect(before?.status).toBe('confirmed');

    await meetingsRepository.endMeeting({
      id: created.meeting.id,
      outcome: 'completed',
      endedBy: 'expert_host',
      endedAt: new Date(),
      actorUserId: null,
    });

    // ⚠ CORRECT AND DELIBERATE, not a miss. `consultationStatusForMeeting` maps every
    // non-`cancelled` label to `confirmed`, so an ENDED meeting KEEPS occupying the expert's
    // calendar slot — the booked window was consumed. Re-advertising it as free would be the
    // bug, which is also why these transitions trigger no availability rebuild.
    const after = await findProjectionForMeeting(created.meeting.id);
    expect(after?.status).toBe('confirmed');
    expect(after?.startAt.getTime()).toBe(before?.startAt.getTime());
  });

  it('rejects a NON-FINITE endedAt before writing anything', async () => {
    const id = await lifecycleMeeting('in_progress');

    await expect(
      meetingsRepository.endMeeting({
        id,
        outcome: 'completed',
        endedBy: 'system_idle',
        endedAt: new Date('nonsense'),
        actorUserId: null,
      })
    ).rejects.toThrow(InvalidPresenceTimestampError);

    expect((await meetingsRepository.findById(id))?.status).toBe('in_progress');
  });
});

// ── BAL-412 — resolving the outcome BAL-134 deliberately left NULL ────────────────────────

describe('meetingsRepository.setOutcomeIfUnset (BAL-412)', () => {
  /** An `ended` meeting with NO outcome — exactly what a HUMAN End writes (ADR-1049 D5). */
  async function endedWithoutOutcome(): Promise<string> {
    const { meeting } = await meetingFactory({
      values: { status: 'ended', endedBy: 'expert_host', endedAt: new Date() },
    });
    expect(meeting.outcome).toBeNull();
    return meeting.id;
  }

  /** The `meeting.outcome_resolved` rows for one meeting. */
  async function outcomeAudits(meetingId: string): Promise<AuditEvent[]> {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, meetingId), eq(auditEvents.action, 'meeting.outcome_resolved'))
      );
  }

  it('writes the outcome on an ended meeting whose outcome is NULL, and audits it', async () => {
    const id = await endedWithoutOutcome();
    const actor = await userFactory();

    const written = await meetingsRepository.setOutcomeIfUnset(db, {
      meetingId: id,
      outcome: 'no_show_client',
      actorUserId: actor.id,
    });

    expect(written).toBe(true);
    expect((await meetingsRepository.findById(id))?.outcome).toBe('no_show_client');

    const audits = await outcomeAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(actor.id);
    expect(audits[0]?.entityType).toBe('meeting');
    expect(audits[0]?.metadata).toMatchObject({ outcome: 'no_show_client' });
  });

  it('accepts a NULL actor — the ADR-1030 system-actor exemption on the sweep path', async () => {
    const id = await endedWithoutOutcome();

    expect(
      await meetingsRepository.setOutcomeIfUnset(db, {
        meetingId: id,
        outcome: 'completed',
        actorUserId: null,
      })
    ).toBe(true);

    const audits = await outcomeAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBeNull();
  });

  it('⚠ NEVER OVERWRITES: the sweep’s missed_call survives a settlement that re-derives it', async () => {
    // BAL-134's lifecycle sweep already wrote `missed_call` on the never-joined path.
    // Settlement re-derives the SAME label — and must still not write, because a re-write
    // would also append a second audit row attesting to a resolution that did not happen.
    const { meeting } = await meetingFactory({
      values: {
        status: 'ended',
        endedBy: 'system_idle',
        endedAt: new Date(),
        outcome: 'missed_call',
      },
    });

    const written = await meetingsRepository.setOutcomeIfUnset(db, {
      meetingId: meeting.id,
      outcome: 'missed_call',
      actorUserId: null,
    });

    expect(written).toBe(false);
    expect((await meetingsRepository.findById(meeting.id))?.outcome).toBe('missed_call');
    expect(await outcomeAudits(meeting.id)).toHaveLength(0);
  });

  it('⚠ NEVER DOWNGRADES a completed meeting to a different label either', async () => {
    const { meeting } = await meetingFactory({
      values: { status: 'ended', endedAt: new Date(), outcome: 'completed' },
    });

    expect(
      await meetingsRepository.setOutcomeIfUnset(db, {
        meetingId: meeting.id,
        outcome: 'no_show_client',
        actorUserId: null,
      })
    ).toBe(false);
    expect((await meetingsRepository.findById(meeting.id))?.outcome).toBe('completed');
  });

  it('⚠ REFUSES a NON-ended meeting rather than tripping meeting_outcome_requires_ended', async () => {
    // The CHECK is one-directional (`outcome ⇒ ended`). Writing here would raise a bare 23514
    // and roll back the caller's WHOLE settlement transaction — the money and the ledger ticks
    // with it. `status = 'ended'` is in the predicate so the write simply matches no row.
    const id = await lifecycleMeeting('in_progress');

    const written = await meetingsRepository.setOutcomeIfUnset(db, {
      meetingId: id,
      outcome: 'completed',
      actorUserId: null,
    });

    expect(written).toBe(false);
    const persisted = await meetingsRepository.findById(id);
    expect(persisted?.status).toBe('in_progress');
    expect(persisted?.outcome).toBeNull();
    expect(await outcomeAudits(id)).toHaveLength(0);
  });

  it('refuses a SOFT-DELETED meeting, and an unknown id', async () => {
    const { meeting } = await meetingFactory({
      values: { status: 'ended', endedAt: new Date(), deletedAt: new Date() },
    });

    expect(
      await meetingsRepository.setOutcomeIfUnset(db, {
        meetingId: meeting.id,
        outcome: 'completed',
        actorUserId: null,
      })
    ).toBe(false);
    expect(
      await meetingsRepository.setOutcomeIfUnset(db, {
        meetingId: randomUUID(),
        outcome: 'completed',
        actorUserId: null,
      })
    ).toBe(false);
  });

  it('⚠ ADR-1030: a ROLLED-BACK caller transaction leaves NEITHER the outcome NOR the audit row', async () => {
    const id = await endedWithoutOutcome();

    await expect(
      db.transaction(async (tx) => {
        expect(
          await meetingsRepository.setOutcomeIfUnset(tx, {
            meetingId: id,
            outcome: 'no_show_client',
            actorUserId: null,
          })
        ).toBe(true);
        // The settlement blowing up AFTER the outcome write — the exact reason the outcome
        // must ride the caller's executor rather than the base client.
        throw new Error('settlement failed');
      })
    ).rejects.toThrow('settlement failed');

    expect((await meetingsRepository.findById(id))?.outcome).toBeNull();
    expect(await outcomeAudits(id)).toHaveLength(0);
  });

  it('is IDEMPOTENT across two calls — the second is a no-op, not a second audit row', async () => {
    const id = await endedWithoutOutcome();

    expect(
      await meetingsRepository.setOutcomeIfUnset(db, {
        meetingId: id,
        outcome: 'completed',
        actorUserId: null,
      })
    ).toBe(true);
    expect(
      await meetingsRepository.setOutcomeIfUnset(db, {
        meetingId: id,
        outcome: 'completed',
        actorUserId: null,
      })
    ).toBe(false);

    expect(await outcomeAudits(id)).toHaveLength(1);
  });
});

describe('meetings — the ended_by CHECK', () => {
  it('meeting_ended_by_requires_ended rejects an ender on a NON-ended meeting (23514)', async () => {
    const { meeting } = await meetingFactory();

    await expectConstraintViolation('23514', (tx) =>
      tx.update(meetings).set({ endedBy: 'expert_host' }).where(eq(meetings.id, meeting.id))
    );
  });

  it('an ended meeting may carry an ender — and may also carry NONE (one-directional)', async () => {
    // The nullable column is not a gap: rows that were already `ended` before migration 0066
    // must remain representable, and inventing an ender for them would be worse than a NULL.
    const { meeting } = await meetingFactory({
      values: { status: 'ended', endedAt: new Date(), endedBy: 'system_idle' },
    });
    expect(meeting.endedBy).toBe('system_idle');

    const { meeting: unattributed } = await meetingFactory({
      values: { status: 'ended', endedAt: new Date() },
    });
    expect(unattributed.endedBy).toBeNull();
  });
});

// ── BAL-400 — the booking idempotency key ─────────────────────────────────────────────
//
// ⚠ THE OTHER HALF OF BAL-129 D12 IS ALREADY COVERED ABOVE, NOT DUPLICATED HERE.
// "the D12 CEILING" — `create({ actorUserId })` writes exactly one `meeting.booked` audit
// row naming that user, and an omitted actor records NULL rather than a fabricated actor —
// is asserted by `meetingsRepository.create — the meeting.booked audit row`. The FLOOR
// (`meetings.booked_by_user_id`) was deliberately NOT built (architect Decision 8, owner
// D5); its absence is enforced by `invariants/meetings-no-context-column.test.ts`, which
// must stay green and untouched.

let meetingKeySeq = 0;

/** A DISTINCT, VALID booking key: 64 lowercase hex chars, per the format CHECK. */
function meetingBookingKey(): string {
  meetingKeySeq += 1;
  // Offset so these never collide with the case-grain suite's keys if both ever share a DB.
  return (meetingKeySeq + 0x1000).toString(16).padStart(64, '0');
}

describe('meetingsRepository.create — bookingIdempotencyKey (BAL-400)', () => {
  it('persists the key, and defaults it to NULL when the caller passes none', async () => {
    const key = meetingBookingKey();
    const { engagement } = await caseEngagementFactory();
    const other = await caseEngagementFactory();

    const keyed = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      bookingIdempotencyKey: key,
    });
    const unkeyed = await meetingsRepository.create({
      ...schedule(2),
      contexts: [{ contextType: 'case', contextId: other.engagement.id }],
    });

    expect(keyed.meeting.bookingIdempotencyKey).toBe(key);
    // The three non-`case` booking paths and the dev seeder pass none, and must keep working.
    expect(unkeyed.meeting.bookingIdempotencyKey).toBeNull();
  });

  it('REFUSES a second live meeting under the SAME key — 23505 on the partial unique', async () => {
    const key = meetingBookingKey();
    const a = await caseEngagementFactory();
    const b = await caseEngagementFactory();

    await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: a.engagement.id }],
      bookingIdempotencyKey: key,
    });

    // THE WHOLE POINT: a lost 201 followed by a re-POST cannot create a second meeting, a
    // second Daily room, a second calendar event and a second notification fan-out. `create`
    // uses no `ON CONFLICT` (the arbiter is a PARTIAL index — 42P10), so the service sees the
    // raw 23505 and re-reads by key.
    await expect(
      meetingsRepository.create({
        ...schedule(2),
        contexts: [{ contextType: 'case', contextId: b.engagement.id }],
        bookingIdempotencyKey: key,
      })
    ).rejects.toMatchObject({ code: '23505' });

    const rows = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(eq(meetings.bookingIdempotencyKey, key));
    expect(rows).toHaveLength(1);
  });

  it('lets a SOFT-DELETED meeting FREE its key (the unique is partial on deleted_at)', async () => {
    const key = meetingBookingKey();
    const a = await caseEngagementFactory();
    const b = await caseEngagementFactory();

    const first = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: a.engagement.id }],
      bookingIdempotencyKey: key,
    });
    await meetingsRepository.softDelete(first.meeting.id);

    // Without the `deleted_at IS NULL` half of the predicate this is 23505 forever — the
    // `reference_softdelete_nonpartial_unique_recreate` failure mode.
    const second = await meetingsRepository.create({
      ...schedule(2),
      contexts: [{ contextType: 'case', contextId: b.engagement.id }],
      bookingIdempotencyKey: key,
    });
    expect(second.meeting.id).not.toBe(first.meeting.id);
    expect(second.meeting.bookingIdempotencyKey).toBe(key);
  });

  it('REJECTS a malformed key with 23514 — a raw client nonce never reaches the column', async () => {
    const { engagement } = await caseEngagementFactory();
    await expect(
      meetingsRepository.create({
        ...schedule(),
        contexts: [{ contextType: 'case', contextId: engagement.id }],
        // A client-minted UUID: the exact IDOR shape the CHECK exists to refuse.
        bookingIdempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REJECTS an UPPERCASE hex key — the digest is lowercase by contract', async () => {
    const { engagement } = await caseEngagementFactory();
    await expect(
      meetingsRepository.create({
        ...schedule(),
        contexts: [{ contextType: 'case', contextId: engagement.id }],
        bookingIdempotencyKey: 'F'.repeat(64),
      })
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('meetingsRepository.findByBookingIdempotencyKey (BAL-400)', () => {
  it('returns the live meeting booked under the key', async () => {
    const key = meetingBookingKey();
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      bookingIdempotencyKey: key,
    });

    const found = await meetingsRepository.findByBookingIdempotencyKey(key);
    expect(found?.id).toBe(created.meeting.id);
    expect(found?.bookingIdempotencyKey).toBe(key);
  });

  it('returns undefined for an unknown key', async () => {
    await expect(
      meetingsRepository.findByBookingIdempotencyKey(meetingBookingKey())
    ).resolves.toBeUndefined();
  });

  it('IGNORES a soft-deleted meeting, so a replay never resurrects a dead booking', async () => {
    const key = meetingBookingKey();
    const { engagement } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
      bookingIdempotencyKey: key,
    });
    await meetingsRepository.softDelete(created.meeting.id);

    await expect(meetingsRepository.findByBookingIdempotencyKey(key)).resolves.toBeUndefined();
  });
});

describe('meetingsRepository.listActiveMeetingsForContexts (BAL-283)', () => {
  it('groups live meetings by context id and returns an entry for EVERY requested id', async () => {
    const first = await requestExpertRelationshipFactory();
    const second = await requestExpertRelationshipFactory();
    const neverBooked = await requestExpertRelationshipFactory();
    const window = schedule();

    const created = await meetingsRepository.create({
      ...window,
      contexts: [{ contextType: 'request_interaction', contextId: first.relationship.id }],
    });
    await meetingsRepository.create({
      ...schedule(5),
      contexts: [{ contextType: 'request_interaction', contextId: second.relationship.id }],
    });

    const byContext = await meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'request_interaction',
      contextIds: [first.relationship.id, second.relationship.id, neverBooked.relationship.id],
    });

    // An entry for every requested id — the caller never distinguishes "absent" from "none".
    expect([...byContext.keys()]).toHaveLength(3);
    expect(byContext.get(neverBooked.relationship.id)).toEqual([]);

    const [booked] = byContext.get(first.relationship.id) ?? [];
    expect(booked?.meetingId).toBe(created.meeting.id);
    expect(booked?.scheduledStart.getTime()).toBe(window.scheduledStart.getTime());
    expect(booked?.scheduledEnd.getTime()).toBe(window.scheduledEnd.getTime());
    expect(booked?.status).toBe('scheduled');
    // ⚠ NO JOIN CREDENTIALS IN THE SUMMARY — `join_url` / `daily_room_name` are call-JOIN
    // credentials, and this read is fed a LIST of ids from a page loader.
    expect(booked).not.toHaveProperty('joinUrl');
    expect(booked).not.toHaveProperty('dailyRoomName');

    // ONE query for the whole page's worth of ids: the second thread's meeting comes back in
    // the same result, never in a second round trip.
    expect(byContext.get(second.relationship.id)).toHaveLength(1);
  });

  it('returns several calls per thread, ordered by scheduled_start (the pick is the caller’s)', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const later = await meetingsRepository.create({
      ...schedule(72),
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
    });
    const sooner = await meetingsRepository.create({
      ...schedule(2),
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
    });

    const byContext = await meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'request_interaction',
      contextIds: [relationship.id],
    });

    expect((byContext.get(relationship.id) ?? []).map((row) => row.meetingId)).toEqual([
      sooner.meeting.id,
      later.meeting.id,
    ]);
  });

  it('EXCLUDES cancelled meetings — a released slot must not hide the CTA', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
    });

    await meetingsRepository.cancel(created.meeting.id, SYSTEM_CANCEL_AUDIT);

    const byContext = await meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'request_interaction',
      contextIds: [relationship.id],
    });
    expect(byContext.get(relationship.id)).toEqual([]);
  });

  it('EXCLUDES a soft-deleted meeting and a soft-deleted context row, independently', async () => {
    const removedMeeting = await requestExpertRelationshipFactory();
    const detached = await requestExpertRelationshipFactory();

    const removed = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'request_interaction', contextId: removedMeeting.relationship.id }],
    });
    await meetingsRepository.softDelete(removed.meeting.id);

    const live = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'request_interaction', contextId: detached.relationship.id }],
    });
    // Detach the context WITHOUT touching the meeting — the two filters are independent, and
    // a test that soft-deleted both would prove only one of them.
    await db
      .update(meetingContexts)
      .set({ deletedAt: new Date() })
      .where(eq(meetingContexts.meetingId, live.meeting.id));

    const byContext = await meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'request_interaction',
      contextIds: [removedMeeting.relationship.id, detached.relationship.id],
    });
    expect(byContext.get(removedMeeting.relationship.id)).toEqual([]);
    expect(byContext.get(detached.relationship.id)).toEqual([]);
  });

  it('is SCOPED BY LABEL — the same uuid read as a `case` context answers nothing', async () => {
    // `context_id` is polymorphic and has NO FK, so the label is the only thing separating
    // one table's ids from another's. Pinned so a caller cannot widen it by accident.
    const { relationship } = await requestExpertRelationshipFactory();
    await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
    });

    const asCases = await meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'case',
      contextIds: [relationship.id],
    });
    expect(asCases.get(relationship.id)).toEqual([]);
  });

  it('an EMPTY id list returns an empty map without touching the DB', async () => {
    const byContext = await meetingsRepository.listActiveMeetingsForContexts({
      contextType: 'request_interaction',
      contextIds: [],
    });
    expect(byContext.size).toBe(0);
  });
});

/**
 * BAL-410 — `meetingsRepository.cancel`, THE ONE THING THAT FREES A BOOKED SLOT.
 *
 * These are claims a mocked test cannot make: that the meeting flip, the `consultations`
 * projection flip and the `meeting.cancelled` audit row genuinely land in ONE transaction; that
 * the status allow-list genuinely refuses every non-`scheduled` state; and that a rolled-back
 * cancel genuinely leaves NO audit row behind.
 */
describe('meetingsRepository.cancel (BAL-410)', () => {
  async function bookedCase(): Promise<{
    meetingId: string;
    expertProfileId: string;
    engagementId: string;
    window: { scheduledStart: Date; scheduledEnd: Date };
  }> {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const window = schedule();
    const created = await meetingsRepository.create({
      ...window,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    return {
      meetingId: created.meeting.id,
      expertProfileId,
      engagementId: engagement.id,
      window,
    };
  }

  it('flips the meeting AND its consultations projection to cancelled in ONE commit', async () => {
    const actor = await userFactory();
    const { meetingId, expertProfileId } = await bookedCase();

    const result = await meetingsRepository.cancel(meetingId, {
      actorUserId: actor.id,
      actorRole: 'client',
    });

    expect(result.meeting.status).toBe('cancelled');
    // The id comes from the LIVE PROJECTION ROW — it is what tells the caller whose
    // availability cache to rebuild.
    expect(result.expertProfileId).toBe(expertProfileId);

    const [row] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    expect(row?.status).toBe('cancelled');
    const projection = await findProjectionForMeeting(meetingId);
    expect(projection?.status).toBe('cancelled');
  });

  it('writes EXACTLY ONE meeting.cancelled audit row, naming the actor AND the arm', async () => {
    const actor = await userFactory();
    const { meetingId, expertProfileId, window } = await bookedCase();

    const result = await meetingsRepository.cancel(meetingId, {
      actorUserId: actor.id,
      actorRole: 'expert',
    });

    const cancelled = (await auditEventsForEntity(meetingId)).filter(
      // ⚠ `meeting.cancelled`, never `meeting.canceled`. A near-miss spelling is a row no
      // "history of one meeting" read would ever find.
      (row) => row.action === 'meeting.cancelled'
    );
    expect(cancelled).toHaveLength(1);

    const [event] = cancelled;
    expect(event?.entityType).toBe('meeting');
    expect(event?.entityId).toBe(meetingId);
    expect(event?.actorUserId).toBe(actor.id);
    expect(event?.metadata).toEqual({
      // WHICH AUTHORIZATION ARM matched — server-derived, never wire input.
      actorRole: 'expert',
      // ⚠ ISO STRINGS, NOT Dates — `metadata` is jsonb, so a Date round-trips as a string and
      // typing the stored shape as Date would be a lie on the way out.
      scheduledStart: window.scheduledStart.toISOString(),
      scheduledEnd: window.scheduledEnd.toISOString(),
      // Whose calendar this cancellation FREED.
      expertProfileId,
    });
    // ⚠ THE RETURNED ID IS THAT ROW'S ID — the post-commit fan-out's per-WRITE dedup key.
    expect(result.cancelAuditId).toBe(event?.id);
  });

  it('writes an UNATTRIBUTED row for the seeder path (null actor, actorRole "system")', async () => {
    // ADR-1030 SYSTEM-ACTOR ATTRIBUTION EXEMPTION: an unattributed row, never a fabricated
    // actor. `actorRole: 'system'` is what makes a null `actor_user_id` a COMPLETE record here.
    const { meetingId } = await bookedCase();

    await meetingsRepository.cancel(meetingId, SYSTEM_CANCEL_AUDIT);

    const cancelled = (await auditEventsForEntity(meetingId)).filter(
      (row) => row.action === 'meeting.cancelled'
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.actorUserId).toBeNull();
    expect(cancelled[0]?.metadata).toMatchObject({ actorRole: 'system' });
  });

  /**
   * ⚠⚠ THE AC: "cancellation is unavailable once the meeting has started." It is delivered by
   * STATE, with no clock anywhere — the first presence interval flips a meeting out of
   * `scheduled`, and that flip is monotone (the back-edge is declared legal but deliberately
   * unimplemented). This table is what pins the allow-list.
   */
  it.each(['waiting_for_participants', 'in_progress', 'ended', 'cancelled'] as const)(
    'REFUSES a %s meeting and writes nothing',
    async (status) => {
      const { meeting } = await meetingFactory({ values: { status } });

      await expect(meetingsRepository.cancel(meeting.id, SYSTEM_CANCEL_AUDIT)).rejects.toThrow(
        /not cancellable/
      );

      const cancelled = (await auditEventsForEntity(meeting.id)).filter(
        (row) => row.action === 'meeting.cancelled'
      );
      expect(cancelled).toHaveLength(0);
    }
  );

  it('REFUSES a soft-deleted meeting, and a meeting that does not exist', async () => {
    const { meeting } = await meetingFactory();
    await meetingsRepository.softDelete(meeting.id);

    await expect(meetingsRepository.cancel(meeting.id, SYSTEM_CANCEL_AUDIT)).rejects.toThrow(
      /not cancellable/
    );
    await expect(meetingsRepository.cancel(randomUUID(), SYSTEM_CANCEL_AUDIT)).rejects.toThrow(
      /not cancellable/
    );
  });

  /**
   * ⚠ IDEMPOTENCY, THE WAY IT ACTUALLY WORKS. The CAS matches `status='scheduled'`, so a second
   * cancel matches ZERO rows and throws — which is precisely what stops the caller's
   * post-commit unwind (an availability rebuild, a hold release, a notification) re-firing for
   * a slot that was already freed. And because the audit row rides the same transaction, there
   * is never a second one.
   */
  it('is idempotent by REFUSAL: a second cancel throws and adds NO second audit row', async () => {
    const actor = await userFactory();
    const { meetingId } = await bookedCase();

    const first = await meetingsRepository.cancel(meetingId, {
      actorUserId: actor.id,
      actorRole: 'client',
    });
    await expect(
      meetingsRepository.cancel(meetingId, { actorUserId: actor.id, actorRole: 'client' })
    ).rejects.toThrow(/not cancellable/);

    const cancelled = (await auditEventsForEntity(meetingId)).filter(
      (row) => row.action === 'meeting.cancelled'
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.id).toBe(first.cancelAuditId);
  });

  /**
   * ⚠⚠ THE "AUDIT ROW LAST" RULE, PROVEN RATHER THAN ASSERTED. An audit row left behind by a
   * rolled-back cancel would attest to a cancellation that never happened. Forced by passing an
   * actor id that is NOT a live `users` row: the audit insert's `actor_user_id` FK rejects it,
   * AFTER the meeting flip and the projection flip have already run on the same `tx`.
   */
  it('a FAILED audit insert rolls the WHOLE cancel back — no flip, no projection, no row', async () => {
    const { meetingId } = await bookedCase();

    await expect(
      meetingsRepository.cancel(meetingId, { actorUserId: randomUUID(), actorRole: 'client' })
    ).rejects.toThrow();

    const [row] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    expect(row?.status).toBe('scheduled');
    const projection = await findProjectionForMeeting(meetingId);
    expect(projection?.status).toBe('confirmed');
    // ⚠ FILTER TO THE CANCEL ACTION. `bookedCase()` goes through `meetingsRepository.create`,
    // which ALWAYS writes a `meeting.booked` row on this same entity — so an unfiltered
    // `toHaveLength(0)` can never hold, and would be red for a reason that has nothing to do
    // with the rollback. The property under test is that NO `meeting.cancelled` row survives.
    const cancelled = (await auditEventsForEntity(meetingId)).filter(
      (row) => row.action === 'meeting.cancelled'
    );
    expect(cancelled).toHaveLength(0);
  });

  it('returns a NULL expertProfileId for an admin meeting — it frees nobody’s calendar', async () => {
    const created = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'admin', contextId: null }],
    });

    const result = await meetingsRepository.cancel(created.meeting.id, SYSTEM_CANCEL_AUDIT);

    expect(result.expertProfileId).toBeNull();
    const cancelled = (await auditEventsForEntity(created.meeting.id)).filter(
      (row) => row.action === 'meeting.cancelled'
    );
    expect(cancelled[0]?.metadata).toMatchObject({ expertProfileId: null });
  });
});

/**
 * BAL-498 — `listCalendarForExpert`. Cases 2 and 3 (tenant isolation, forged polymorphic
 * context) are the SECURITY-CRITICAL ones — see plan-bal-498.md § 12.3/§ 20.
 */
describe('meetingsRepository.listCalendarForExpert', () => {
  const RANGE = {
    rangeStart: new Date(Date.now() - HOUR_MS),
    rangeEnd: new Date(Date.now() + 30 * 24 * HOUR_MS),
  };

  it('returns meetings from two engagement types for one expert, ordered by scheduledStart, with engagementType and company name', async () => {
    const {
      engagement: caseEngagement,
      expertProfileId,
      companyId,
    } = await caseEngagementFactory();
    const { engagement: projectEngagement } = await engagementFactory({
      expertProfileId,
      companyId,
    });

    const caseMeeting = await meetingsRepository.create({
      ...schedule(2),
      contexts: [{ contextType: 'case', contextId: caseEngagement.id }],
    });
    const projectMeeting = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'project_kickoff', contextId: projectEngagement.id }],
    });

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result.map((row) => row.meetingId)).toEqual([
      projectMeeting.meeting.id,
      caseMeeting.meeting.id,
    ]);
    const [projectRow, caseRow] = result;
    expect(projectRow?.contextType).toBe('project_kickoff');
    expect(projectRow?.engagementType).toBe('project');
    expect(projectRow?.counterpartyCompanyName).toBe('Acme Co');
    expect(caseRow?.contextType).toBe('case');
    expect(caseRow?.engagementType).toBe('case');
    expect(caseRow?.counterpartyCompanyName).toBe('Acme Co');
  });

  it('tenant isolation — expert A never sees expert B’s meetings', async () => {
    const { engagement: engagementA, expertProfileId: expertA } = await caseEngagementFactory();
    const { engagement: engagementB, expertProfileId: expertB } = await caseEngagementFactory();

    const meetingA = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagementA.id }],
    });
    const meetingB = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagementB.id }],
    });

    const resultA = await meetingsRepository.listCalendarForExpert({
      expertProfileId: expertA,
      ...RANGE,
    });

    expect(resultA.map((row) => row.meetingId)).toEqual([meetingA.meeting.id]);
    expect(resultA.map((row) => row.meetingId)).not.toContain(meetingB.meeting.id);
  });

  it('a context row pointing at ANOTHER expert’s engagement never leaks that tenant’s company name', async () => {
    const { engagement: ownEngagement, expertProfileId } = await caseEngagementFactory();
    const { engagement: otherEngagement } = await caseEngagementFactory();

    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: ownEngagement.id }],
    });

    // Simulate a drifted/forged polymorphic context: the winning context row now points at
    // another tenant's engagement, while `consultations.expertProfileId` (written correctly
    // at booking time) still names the real owner. This is exactly the hazard
    // `schema/meeting-contexts.ts` documents — no FK, no RLS on `context_id`.
    await db
      .update(meetingContexts)
      .set({ contextId: otherEngagement.id })
      .where(eq(meetingContexts.meetingId, created.meeting.id));

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result).toHaveLength(1);
    // The winning context resolved to no LIVE OWNING row for this expert — fail-closed, no
    // other tenant's company name, engagement type or project request id is ever returned, and
    // `owningRowFound` is surfaced as `false` so the WEB LOADER can also refuse to render a link
    // (BAL-498 fix round 1, B7 / security-bal-498.md MEDIUM finding).
    expect(result[0]?.counterpartyCompanyName).toBeNull();
    expect(result[0]?.engagementType).toBeNull();
    expect(result[0]?.projectRequestId).toBeNull();
    expect(result[0]?.owningRowFound).toBe(false);
    // ⚠ AND THE RAW POLYMORPHIC ID ITSELF (BAL-498 fix round 3, R8). This assertion is the point
    // of the whole test: `contextId` used to be emitted unconditionally, so on exactly this
    // drifted/forged row it was the OTHER TENANT'S `engagements.id`, sitting beside three
    // deliberately-nulled identity fields. `ExpertCalendarMeeting` is exported from the barrel,
    // so the next consumer would have inherited it with only a docblock in the way.
    expect(result[0]?.contextId).toBeNull();
    expect(result[0]?.contextId).not.toBe(otherEngagement.id);
  });

  it('a soft-deleted OWNING engagement still returns the meeting (it still occupies the calendar), with counterpartyCompanyName null and owningRowFound false', async () => {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    // The MEETING is still live; only the owning engagement row is soft-deleted underneath it —
    // a data-repair/soft-delete class hazard, not an attacker-reachable write (plan-bal-498.md
    // § 1.6). The calendar's job is "what occupies my time", so the meeting must still render —
    // just without a counterparty name or a link into the now-gone engagement.
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result).toHaveLength(1);
    expect(result[0]?.meetingId).toBe(created.meeting.id);
    expect(result[0]?.contextType).toBe('case');
    expect(result[0]?.counterpartyCompanyName).toBeNull();
    expect(result[0]?.engagementType).toBeNull();
    expect(result[0]?.owningRowFound).toBe(false);
  });

  it('excludes cancelled meetings', async () => {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    await meetingsRepository.cancel(created.meeting.id, SYSTEM_CANCEL_AUDIT);

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result).toEqual([]);
  });

  it('excludes soft-deleted meetings', async () => {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    await meetingsRepository.softDelete(created.meeting.id);

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result).toEqual([]);
  });

  /**
   * BAL-498 fix round 3, S2. `?week=1000-01-01` passed the page's shape AND real-calendar-date
   * checks and handed this method a ~1000-year window with no `LIMIT`: every meeting the expert
   * has ever had, an unbounded `inArray` bind list, and the whole lot serialised into the RSC
   * payload. The page now clamps the param; THIS assertion is the durable half, so a future
   * caller that forgets cannot reintroduce it silently.
   */
  it('REFUSES a range wider than the maximum span rather than serving an unbounded scan (S2)', async () => {
    const { expertProfileId } = await caseEngagementFactory();

    await expect(
      meetingsRepository.listCalendarForExpert({
        expertProfileId,
        rangeStart: new Date('1000-01-01T00:00:00.000Z'),
        rangeEnd: new Date(Date.now() + 30 * 24 * HOUR_MS),
      })
    ).rejects.toThrow(CalendarRangeTooWideError);
  });

  it('a range at the maximum span is still served (the guard is a ceiling, not a narrowing)', async () => {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const rangeStart = new Date(Date.now() - HOUR_MS);
    const result = await meetingsRepository.listCalendarForExpert({
      expertProfileId,
      rangeStart,
      rangeEnd: new Date(rangeStart.getTime() + MAX_CALENDAR_RANGE_DAYS * 24 * HOUR_MS),
    });

    expect(result.map((row) => row.meetingId)).toContain(created.meeting.id);
  });

  it('caps the returned rows, and drops the trailing meeting whose context set the LIMIT may have sliced (S2)', async () => {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    await meetingsRepository.create({
      ...schedule(2),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    // `limit: 1` means the ONE row fetched is the earlier meeting's only context row — and,
    // because the limit was reached, that meeting's context set might have been truncated, so it
    // is dropped rather than folded from a partial set (half a context set folds to the WRONG
    // precedence winner).
    const result = await meetingsRepository.listCalendarForExpert({
      expertProfileId,
      ...RANGE,
      limit: 1,
    });

    expect(result).toEqual([]);
  });

  it('an admin-only meeting is structurally absent — it projects no consultations row', async () => {
    const { expertProfileId } = await caseEngagementFactory();
    await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'admin', contextId: null }],
    });

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result).toEqual([]);
  });

  it('a request_interaction meeting resolves its counterparty through relationship -> request -> company', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory();
    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'request_interaction', contextId: relationship.id }],
    });

    const result = await meetingsRepository.listCalendarForExpert({ expertProfileId, ...RANGE });

    expect(result).toHaveLength(1);
    expect(result[0]?.meetingId).toBe(created.meeting.id);
    expect(result[0]?.contextType).toBe('request_interaction');
    expect(result[0]?.projectRequestId).toBe(projectRequestId);
    expect(result[0]?.counterpartyCompanyName).toBe('Acme Co');
  });

  it('a project_discovery meeting (send_to=direct) appears and resolves its company', async () => {
    const request = await projectRequestFactory();
    if (request.expertProfileId === null) {
      throw new Error('projectRequestFactory: expected a direct request with a non-null expert');
    }
    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [{ contextType: 'project_discovery', contextId: request.id }],
    });

    const result = await meetingsRepository.listCalendarForExpert({
      expertProfileId: request.expertProfileId,
      ...RANGE,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.meetingId).toBe(created.meeting.id);
    expect(result[0]?.contextType).toBe('project_discovery');
    expect(result[0]?.counterpartyCompanyName).toBe('Acme Co');
  });

  it('precedence: a meeting carrying BOTH project_discovery and project_kickoff returns ONCE, as project_kickoff', async () => {
    const relationship = await requestExpertRelationshipFactory();
    const { engagement } = await engagementFactory({
      expertProfileId: relationship.expertProfileId,
    });

    const created = await meetingsRepository.create({
      ...schedule(1),
      contexts: [
        { contextType: 'project_discovery', contextId: relationship.projectRequestId },
        { contextType: 'project_kickoff', contextId: engagement.id },
      ],
    });

    const result = await meetingsRepository.listCalendarForExpert({
      expertProfileId: relationship.expertProfileId,
      ...RANGE,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.meetingId).toBe(created.meeting.id);
    expect(result[0]?.contextType).toBe('project_kickoff');
  });

  it('range boundaries: excludes a meeting ending exactly at rangeStart or starting exactly at rangeEnd; includes one straddling rangeStart', async () => {
    const { engagement, expertProfileId } = await caseEngagementFactory();
    const rangeStart = new Date(Date.now() + 10 * HOUR_MS);
    const rangeEnd = new Date(rangeStart.getTime() + 7 * 24 * HOUR_MS);

    const endsAtStart = await meetingsRepository.create({
      scheduledStart: new Date(rangeStart.getTime() - HOUR_MS),
      scheduledEnd: rangeStart,
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const startsAtEnd = await meetingsRepository.create({
      scheduledStart: rangeEnd,
      scheduledEnd: new Date(rangeEnd.getTime() + HOUR_MS),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });
    const straddling = await meetingsRepository.create({
      scheduledStart: new Date(rangeStart.getTime() - 30 * 60_000),
      scheduledEnd: new Date(rangeStart.getTime() + 30 * 60_000),
      contexts: [{ contextType: 'case', contextId: engagement.id }],
    });

    const result = await meetingsRepository.listCalendarForExpert({
      expertProfileId,
      rangeStart,
      rangeEnd,
    });
    const ids = result.map((row) => row.meetingId);

    expect(ids).not.toContain(endsAtStart.meeting.id);
    expect(ids).not.toContain(startsAtEnd.meeting.id);
    expect(ids).toContain(straddling.meeting.id);
  });
});
