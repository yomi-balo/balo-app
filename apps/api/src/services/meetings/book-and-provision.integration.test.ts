import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * BAL-129 — THE PROVISIONING SEAM, END TO END AGAINST A REAL POSTGRES.
 *
 * The unit tests prove each layer in isolation with everything mocked. NONE of them proves
 * the claim the ticket is actually about: that one call writes one `meetings` row, one
 * `meeting_contexts` row, one live `consultations` projection row AND stamps a venue, in
 * agreement with each other. That claim spans `meetings` → `meeting_contexts` → the
 * projection → `meeting_daily_room_name_idx`, and only a real database can carry it.
 *
 * ⚠ THIS FILE LIVES IN `apps/api` BUT RUNS FROM `packages/db/vitest.config.integration.ts`.
 * That config's `root` is the repo root and its `globalSetup`/`setupFiles` are absolute, so
 * one testcontainer serves both packages. `@balo/db`'s `main` is `./src/index.ts`, so the
 * `db` binding an `apps/api` service imports IS the live binding `setup-integration.ts`
 * reassigns via `_setDb`; every write below therefore lands in the per-test transaction and
 * rolls back with it. `apps/api/vitest.config.ts` EXCLUDES `*.integration.test.ts` so the
 * unit job does not also pick this up with no database.
 *
 * ⚠ `pnpm test:integration` PASSES VACUOUSLY WITHOUT DOCKER (`passWithNoTests: true` prints
 * "No test files found" and exits 0). Check the reported test COUNT, never the exit code.
 *
 * ⚠ ZERO NETWORK. The Daily half is a hand-written `RoomProvisioner` — that port exists
 * precisely so the DB half is provable without a Daily account.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

/**
 * The queue, and ONLY the queue. `bookMeeting` discharges the post-commit
 * availability-rebuild obligation for real, but `getQueue` would otherwise open a live Redis
 * connection (`getRedis()` throws without `REDIS_URL`).
 */
const { mockQueueAdd, mockGetQueue } = vi.hoisted(() => {
  const add = vi.fn().mockResolvedValue({ id: 'seed-job' });
  return { mockQueueAdd: add, mockGetQueue: vi.fn(() => ({ add })) };
});
vi.mock('../../lib/queue.js', () => ({ getQueue: mockGetQueue }));

import {
  MatchModeDiscoveryNotBookableError,
  auditEvents,
  consultations,
  db,
  engagements,
  engagementsRepository,
  eq,
  findProjectionDrift,
  findProjectionForMeeting,
  meetingCalendarEvents,
  meetingCalendarEventsRepository,
  meetingContexts,
  meetings,
  meetingsRepository,
} from '@balo/db';
import { dailyRoomNameForMeeting } from '@balo/shared/meetings';
import type { ProvisionedRoom, RoomProvisioner } from '../daily/rooms.js';
import { seedBookingParties, type BookingParties } from '../../test/fixtures/booking-graph.js';
import { authorizeMeetingBooking } from './authorize-meeting-booking.js';
import { bookAndProvisionMeeting, provisionMeeting } from './provision-meeting.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const START = new Date('2026-09-07T09:00:00.000Z');
const END = new Date('2026-09-07T10:00:00.000Z');
const LATER_START = new Date('2026-09-07T11:00:00.000Z');
const LATER_END = new Date('2026-09-07T12:00:00.000Z');

const log = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as FastifyBaseLogger;

/** A provisioner that records every name it was asked for and always succeeds. */
function recordingProvisioner(): RoomProvisioner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async createRoom(name: string): Promise<ProvisionedRoom> {
      calls.push(name);
      return { dailyRoomName: name, joinUrl: `https://balo.daily.co/${name}` };
    },
  };
}

/** A provisioner that always fails — the vendor-outage case. */
const failingProvisioner: RoomProvisioner = {
  async createRoom(): Promise<ProvisionedRoom> {
    throw new Error('Daily is unreachable');
  },
};

/**
 * The actor for `provisionMeeting`'s ANALYTICS context ONLY — `MeetingProvisionContext.userId`
 * is PostHog's `distinct_id` and reaches no table, so an opaque marker is honest here.
 *
 * ⚠ EVERY `bookAndProvisionMeeting` CALL BELOW USES `parties.memberUserId` INSTEAD, and must
 * keep doing so. Since BAL-129 closed the ADR-1030 gap, the booking actor is written to
 * `audit_events.actor_user_id` — an FK to `users` — so a booking naming a non-existent user now
 * fails 23503 and takes the whole transaction with it. That is the behaviour under test in
 * `packages/db`'s `meetings.integration.test.ts`; here it would just be a broken fixture.
 */
const USER_ID = 'booking-actor';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── The cases ────────────────────────────────────────────────────────────────

describe('BAL-129 — book and provision, against a real database', () => {
  it('AC #1 — writes one meeting, one context, one live projection, and stamps the venue', async () => {
    const parties = await seedBookingParties();
    const provisioner = recordingProvisioner();

    const result = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: parties.caseEngagementId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: parties.memberUserId,
      },
      log,
      { provisioner }
    );

    expect(result.provisioned).toBe(true);

    // ONE meeting, with the venue actually PERSISTED — not merely returned.
    const stored = await meetingsRepository.findById(result.meeting.id);
    const expectedName = dailyRoomNameForMeeting(result.meeting.id);
    expect(stored?.dailyRoomName).toBe(expectedName);
    expect(stored?.joinUrl).toBe(`https://balo.daily.co/${expectedName}`);
    expect(result.dailyRoomName).toBe(expectedName);

    // ONE context row, naming the engagement that was booked.
    const contexts = await db
      .select()
      .from(meetingContexts)
      .where(eq(meetingContexts.meetingId, result.meeting.id));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      contextType: 'case',
      contextId: parties.caseEngagementId,
      deletedAt: null,
    });

    // ONE live projection row, blocking the RIGHT expert over the RIGHT window.
    const projection = await findProjectionForMeeting(result.meeting.id);
    expect(projection).toMatchObject({
      expertProfileId: parties.expertProfileId,
      status: 'confirmed',
      deletedAt: null,
    });
    expect(projection?.startAt.toISOString()).toBe(START.toISOString());
    expect(projection?.endAt.toISOString()).toBe(END.toISOString());

    // ONE `meeting.booked` audit row NAMING THE PERSON WHO BOOKED (BAL-129 / ADR-1044 §5).
    // ⚠ ASSERTED AT THIS LAYER, not only in `packages/db`, because the repository test can
    // only prove `create` writes whatever actor it is HANDED. This proves the actor the ROUTE
    // authenticated is the one that reaches the table — the seam where it was previously lost
    // to PostHog and the Pino log, both of which a deployment can silently disable.
    const auditRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, result.meeting.id));
    const booked = auditRows.filter((row) => row.action === 'meeting.booked');
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({
      entityType: 'meeting',
      actorUserId: parties.memberUserId,
    });

    // AC #8 — the two representations agree.
    expect(await findProjectionDrift({ meetingIds: [result.meeting.id] })).toEqual([]);
  });

  it('AC #2 — two bookings on the SAME engagement get two DISTINCT room names', async () => {
    // Mechanical, because the name is a pure injective function of `meetings.id`. The partial
    // unique `meeting_daily_room_name_idx` is a backstop that can never fire for two distinct
    // meetings — and this proves the database agrees.
    const parties = await seedBookingParties();
    const provisioner = recordingProvisioner();

    const book = async (start: Date, end: Date) =>
      bookAndProvisionMeeting(
        {
          contextType: 'case',
          contextId: parties.caseEngagementId,
          scheduledStart: start,
          scheduledEnd: end,
          engagementType: 'case',
          userId: parties.memberUserId,
        },
        log,
        { provisioner }
      );

    const first = await book(START, END);
    const second = await book(LATER_START, LATER_END);

    expect(first.meeting.id).not.toBe(second.meeting.id);
    expect(first.dailyRoomName).not.toBe(second.dailyRoomName);
    expect(provisioner.calls).toEqual([first.dailyRoomName, second.dailyRoomName]);

    // Both rows survive the partial unique index — two live meetings, two distinct names.
    const rows = await db
      .select({ id: meetings.id, dailyRoomName: meetings.dailyRoomName })
      .from(meetings)
      .where(eq(meetings.id, second.meeting.id));
    expect(rows).toHaveLength(1);
    expect(
      await findProjectionDrift({ meetingIds: [first.meeting.id, second.meeting.id] })
    ).toEqual([]);
  });

  it('AC #4 — a routed project_discovery resolves through project_requests, NOT an engagement', async () => {
    const parties = await seedBookingParties();
    const provisioner = recordingProvisioner();

    // ⚠ THE LINE THAT MAKES THIS TEST DISCRIMINATING. The fixture's expert is reachable BOTH
    // through a case engagement and through this project request, so asserting "the
    // projection blocks that expert" alone would pass even if the resolver had used the
    // wrong arm. This proves the context id is NOT an engagement id — so a resolver that
    // looked it up in `engagements` would have thrown `MeetingContextUnresolvableError`
    // rather than reaching a projection at all.
    expect(await engagementsRepository.findById(parties.directProjectRequestId)).toBeUndefined();

    const result = await bookAndProvisionMeeting(
      {
        contextType: 'project_discovery',
        contextId: parties.directProjectRequestId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: null,
        userId: parties.memberUserId,
      },
      log,
      { provisioner }
    );

    expect(result.provisioned).toBe(true);
    const projection = await findProjectionForMeeting(result.meeting.id);
    expect(projection?.expertProfileId).toBe(parties.expertProfileId);

    // The meeting is anchored on the REQUEST, with no engagement context row at all.
    const contexts = await db
      .select()
      .from(meetingContexts)
      .where(eq(meetingContexts.meetingId, result.meeting.id));
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      contextType: 'project_discovery',
      contextId: parties.directProjectRequestId,
    });

    expect(await findProjectionDrift({ meetingIds: [result.meeting.id] })).toEqual([]);
  });

  it('AC #6 (D2) — provisionMeeting twice makes exactly ONE createRoom call', async () => {
    const parties = await seedBookingParties();
    const provisioner = recordingProvisioner();
    const context = { contextType: 'case', engagementType: 'case', userId: USER_ID } as const;

    const booked = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: parties.caseEngagementId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: parties.memberUserId,
      },
      log,
      { provisioner }
    );
    expect(provisioner.calls).toHaveLength(1);

    const replay = await provisionMeeting(booked.meeting.id, context, log, { provisioner });

    // Zero further vendor calls, and the venue is BYTE-IDENTICAL to what was already stored.
    expect(provisioner.calls).toHaveLength(1);
    expect(replay).toMatchObject({
      provisioned: true,
      replayed: true,
      dailyRoomName: booked.dailyRoomName,
      joinUrl: booked.joinUrl,
    });

    const stored = await meetingsRepository.findById(booked.meeting.id);
    expect(stored?.dailyRoomName).toBe(booked.dailyRoomName);
    expect(stored?.joinUrl).toBe(booked.joinUrl);

    // AC #8 — a REPLAY must not disturb the two representations either. §12.2 case 8 asks for
    // this after every success; a replay writes nothing, and this is what says so.
    expect(await findProjectionDrift({ meetingIds: [booked.meeting.id] })).toEqual([]);
  });

  it('AC #5 — the venue lives ONLY on `meetings`; the projection carries no join credentials', async () => {
    // Asserted structurally: `join_url` / `daily_room_name` exist on neither `consultations`
    // nor the engagement/request tables, so a booking's join credentials have exactly one home.
    const parties = await seedBookingParties();
    const result = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: parties.caseEngagementId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: parties.memberUserId,
      },
      log,
      { provisioner: recordingProvisioner() }
    );

    const [projectionRow] = await db
      .select()
      .from(consultations)
      .where(eq(consultations.meetingId, result.meeting.id));
    expect(projectionRow).toBeDefined();
    expect(projectionRow).not.toHaveProperty('joinUrl');
    expect(projectionRow).not.toHaveProperty('dailyRoomName');

    // AC #8 — §12.2 case 8 asks for this after EVERY success, and this case was missing it:
    // "the venue lives only on `meetings`" is only reassuring if the projection also still
    // agrees with the meeting it projects.
    expect(await findProjectionDrift({ meetingIds: [result.meeting.id] })).toEqual([]);
  });

  it('match mode — throws, and leaves NO meeting row behind (the whole transaction rolls back)', async () => {
    const parties = await seedBookingParties();
    const provisioner = recordingProvisioner();

    const before = await db.select({ id: meetings.id }).from(meetings);

    await expect(
      bookAndProvisionMeeting(
        {
          contextType: 'project_discovery',
          contextId: parties.matchProjectRequestId,
          scheduledStart: START,
          scheduledEnd: END,
          engagementType: null,
          userId: parties.memberUserId,
        },
        log,
        { provisioner }
      )
    ).rejects.toBeInstanceOf(MatchModeDiscoveryNotBookableError);

    // A match-mode request has no expert, so there is no calendar to book — and the meeting
    // must not survive as a booking that blocks nobody.
    const after = await db.select({ id: meetings.id }).from(meetings);
    expect(after).toHaveLength(before.length);
    // The vendor is never reached: the typed error is thrown before provisioning.
    expect(provisioner.calls).toEqual([]);
  });

  it('vendor failure — the booking COMMITS unprovisioned, and a later call HEALS it', async () => {
    const parties = await seedBookingParties();

    const failed = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: parties.caseEngagementId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: parties.memberUserId,
      },
      log,
      { provisioner: failingProvisioner }
    );

    // The booking STANDS: the meeting and its projection exist, the venue does not.
    expect(failed.provisioned).toBe(false);
    const unstamped = await meetingsRepository.findById(failed.meeting.id);
    expect(unstamped?.dailyRoomName).toBeNull();
    expect(unstamped?.joinUrl).toBeNull();
    expect(await findProjectionForMeeting(failed.meeting.id)).toMatchObject({
      expertProfileId: parties.expertProfileId,
      status: 'confirmed',
    });
    // An unprovisioned booking is NOT drift — the projection and the meeting still agree.
    expect(await findProjectionDrift({ meetingIds: [failed.meeting.id] })).toEqual([]);

    // ── THE REPAIR PATH (BAL-400's, exercised here) ──
    const provisioner = recordingProvisioner();
    const healed = await provisionMeeting(
      failed.meeting.id,
      { contextType: 'case', engagementType: 'case', userId: USER_ID },
      log,
      { provisioner }
    );

    const expectedName = dailyRoomNameForMeeting(failed.meeting.id);
    expect(healed).toMatchObject({
      provisioned: true,
      replayed: false,
      dailyRoomName: expectedName,
    });
    expect(provisioner.calls).toEqual([expectedName]);

    const stamped = await meetingsRepository.findById(failed.meeting.id);
    expect(stamped?.dailyRoomName).toBe(expectedName);
    expect(stamped?.joinUrl).toBe(`https://balo.daily.co/${expectedName}`);
    expect(await findProjectionDrift({ meetingIds: [failed.meeting.id] })).toEqual([]);
  });

  it('provisionMeeting returns undefined for a meeting that does not exist', async () => {
    await expect(
      provisionMeeting(
        '00000000-0000-4000-8000-000000000000',
        { contextType: 'case', engagementType: 'case', userId: USER_ID },
        log,
        { provisioner: recordingProvisioner() }
      )
    ).resolves.toBeUndefined();
  });

  /**
   * BAL-129 (D7) — THE TENANCY GATE, AGAINST REAL ROWS.
   *
   * ⚠ WHY THIS BLOCK IS NOT REDUNDANT WITH `authorize-meeting-booking.test.ts`. That file mocks
   * `getMemberRole` AND both `findById`s, so this ticket's HEADLINE SECURITY CLAIM — that a
   * uuid belonging to another tenant is refused, and that the soft-delete filters those reads
   * rely on actually hold in SQL — is asserted by reading the code, never by executing it.
   * `meeting_contexts.context_id` has no FK and no RLS, so nothing but this gate stands between
   * a guessed uuid and a `confirmed` consultation on a stranger's calendar. Two
   * `seedBookingParties()` calls are two independent tenants, which is all it takes to run the
   * claim for real.
   */
  describe('the tenancy gate, with nothing mocked', () => {
    it('REFUSES a live member of company A booking company B’s engagement', async () => {
      const a = await seedBookingParties();
      const b = await seedBookingParties();

      await expect(
        authorizeMeetingBooking({
          contextType: 'case',
          contextId: b.caseEngagementId,
          userId: a.memberUserId,
        })
      ).resolves.toEqual({ ok: false, code: 'context_not_found' });

      // ⚠ THE CONTROL. Without it this test passes against a gate that refuses EVERYTHING —
      // the same actor, the same call shape, their OWN engagement, must succeed.
      await expect(
        authorizeMeetingBooking({
          contextType: 'case',
          contextId: a.caseEngagementId,
          userId: a.memberUserId,
        })
      ).resolves.toEqual({
        ok: true,
        companyId: a.companyId,
        engagementType: 'case',
        expertProfileId: a.expertProfileId,
      });
    });

    it('REFUSES a cross-tenant project_discovery too — the other arm, the same rule', async () => {
      // The discovery arm reads `project_requests`, not `engagements`, so it is a genuinely
      // separate code path and a separate soft-delete filter.
      const a = await seedBookingParties();
      const b = await seedBookingParties();

      await expect(
        authorizeMeetingBooking({
          contextType: 'project_discovery',
          contextId: b.directProjectRequestId,
          userId: a.memberUserId,
        })
      ).resolves.toEqual({ ok: false, code: 'context_not_found' });

      await expect(
        authorizeMeetingBooking({
          contextType: 'project_discovery',
          contextId: a.directProjectRequestId,
          userId: a.memberUserId,
        })
      ).resolves.toMatchObject({ ok: true, expertProfileId: a.expertProfileId });
    });

    it.each([
      {
        // `engagementsRepository.findById` filters `deleted_at IS NULL`. Proving that in SQL is
        // the point: mocking `findById` asserts the filter exists in a comment, not in a plan.
        label: 'SOFT-DELETED',
        patch: { deletedAt: new Date('2026-08-01T00:00:00.000Z') },
      },
      {
        // `engagement_status` is exactly `active | completed | cancelled`, so there is no
        // legitimate non-active bookable state. Without the status guard, a case closed months
        // ago stays a durable handle for blocking that expert's calendar.
        label: 'COMPLETED',
        patch: { status: 'completed' as const },
      },
      { label: 'CANCELLED', patch: { status: 'cancelled' as const } },
    ])('REFUSES a $label engagement, even to its own live member', async ({ patch }) => {
      const a = await seedBookingParties();
      await db.update(engagements).set(patch).where(eq(engagements.id, a.caseEngagementId));

      await expect(
        authorizeMeetingBooking({
          contextType: 'case',
          contextId: a.caseEngagementId,
          userId: a.memberUserId,
        })
      ).resolves.toEqual({ ok: false, code: 'context_not_found' });
    });
  });

  it('discharges the post-commit availability-rebuild obligation for the booked expert', async () => {
    // BAL-428's contract: whoever mutates a meeting must rebuild THAT expert's cache. A
    // booking that skipped it would leave every expert-facing surface advertising a taken slot.
    const parties = await seedBookingParties();

    await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: parties.caseEngagementId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: parties.memberUserId,
      },
      log,
      { provisioner: recordingProvisioner() }
    );

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'rebuild-availability-cache',
      { expertProfileId: parties.expertProfileId },
      expect.objectContaining({ jobId: `availability-${parties.expertProfileId}` })
    );
  });
});

/**
 * BAL-433 SLICE 1 — THE ACCEPTANCE TEST, AND THE ONLY PLACE THE THREE PRODUCER-LESS CONTEXTS
 * CAN BE EXERCISED END TO END.
 *
 * `case` and `request_interaction` have production booking producers in `apps/web`;
 * `project_discovery` has only a declared MOCK SEAM, and `project_kickoff` and
 * `package_session` have **none at all**. Building producers for those three is explicitly out
 * of this slice's scope — so a direct service call against a real database is the whole of
 * their reachability proof.
 *
 * WHAT THIS PROVES THAT NO MOCKED TEST CAN:
 *
 *   · the registry really does reach every bookable label (a gate left anywhere in the chain
 *     would leave a context with NO row, and the unit tests would still be green because they
 *     mock the projection);
 *   · the ICS-fallback condition is actually PERSISTED, through the real migration, past the
 *     real biconditional CHECK and the real partial unique on `(meeting_id, party)`;
 *   · no 42P10 on the widened arbiter, on a first write, against a real plan.
 *
 * ⚠ NO CALENDAR CONNECTION IS SEEDED, DELIBERATELY. `pickWriteTarget` therefore answers
 * `undefined` for every one of the five and ADR-1044 Ruling 1 fires — which also means NO
 * VENDOR CALL IS ATTEMPTED: nothing here mocks `@apiroc/…`, so a write would fail loudly
 * rather than silently pass.
 *
 * ⚠ `pnpm test:integration` PASSES VACUOUSLY WITHOUT DOCKER. Check the reported test COUNT.
 */
describe('BAL-433 — every bookable context projects, and the ICS fallback is persisted', () => {
  /** Every live calendar-entry row for one meeting. */
  async function calendarRowsFor(
    meetingId: string
  ): Promise<(typeof meetingCalendarEvents.$inferSelect)[]> {
    return db
      .select()
      .from(meetingCalendarEvents)
      .where(eq(meetingCalendarEvents.meetingId, meetingId));
  }

  /**
   * The context id each label anchors on. ⚠ `package_session` points at a PROJECT engagement:
   * there is no package factory and this slice does not need one, and both labels resolve
   * their company through the engagement SUPERTYPE while the registry supplies only the label
   * (see `seedBookingParties`' own note).
   */
  const CONTEXTS = [
    {
      contextType: 'case',
      engagementType: 'case',
      idOf: (p: BookingParties) => p.caseEngagementId,
    },
    {
      contextType: 'project_kickoff',
      engagementType: 'project',
      idOf: (p: BookingParties) => p.projectEngagementId,
    },
    {
      contextType: 'package_session',
      engagementType: 'package',
      idOf: (p: BookingParties) => p.projectEngagementId,
    },
    {
      contextType: 'project_discovery',
      engagementType: null,
      idOf: (p: BookingParties) => p.directProjectRequestId,
    },
    {
      contextType: 'request_interaction',
      engagementType: null,
      idOf: (p: BookingParties) => p.relationshipId,
    },
  ] as const;

  it.each(CONTEXTS)(
    'contextType "$contextType" → ONE live expert-party row, delivery_mode ics, no provider payload',
    async ({ contextType, engagementType, idOf }) => {
      const parties = await seedBookingParties();

      const result = await bookAndProvisionMeeting(
        {
          contextType,
          contextId: idOf(parties),
          scheduledStart: START,
          scheduledEnd: END,
          engagementType,
          userId: parties.memberUserId,
        },
        log,
        { provisioner: recordingProvisioner() }
      );

      const rows = await calendarRowsFor(result.meeting.id);
      expect(rows, `${contextType} produced no calendar row`).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        party: 'expert',
        deliveryMode: 'ics',
        // ⚠ ALL FOUR NULL, AND THE BICONDITIONAL CHECK ENFORCES IT. An `ics` row carrying a
        // stale vendor id would raise 23514 rather than reach this assertion.
        connectionId: null,
        calendarId: null,
        vendorEventId: null,
        baloBookingId: null,
        deletedAt: null,
      });
    }
  );

  it("the five bookings are five independent rows — no context shares another's entry", async () => {
    // A registry that resolved every label to the same row (or a writer keyed on something
    // other than the meeting) would pass each case above in isolation and fail here.
    const parties = await seedBookingParties();
    const meetingIds: string[] = [];

    for (const [index, spec] of CONTEXTS.entries()) {
      const start = new Date(START.getTime() + index * 3 * 60 * 60 * 1000);
      const result = await bookAndProvisionMeeting(
        {
          contextType: spec.contextType,
          contextId: spec.idOf(parties),
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
          engagementType: spec.engagementType,
          userId: parties.memberUserId,
        },
        log,
        { provisioner: recordingProvisioner() }
      );
      meetingIds.push(result.meeting.id);
    }

    expect(new Set(meetingIds).size).toBe(5);
    const rowIds: string[] = [];
    for (const meetingId of meetingIds) {
      const rows = await calendarRowsFor(meetingId);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      if (row === undefined) throw new Error('unreachable: length was asserted above');
      rowIds.push(row.id);
    }
    expect(new Set(rowIds).size).toBe(5);
  });

  it('a rebook after the entry is retired INSERTS beside it — one live row, two total', async () => {
    // The partial unique ignores a soft-deleted row, which is what makes a cancelled-then-
    // rebooked meeting able to record a SECOND entry. Proved here through the real index
    // rather than only in the repository test, because this is the path a booking takes.
    const parties = await seedBookingParties();
    const result = await bookAndProvisionMeeting(
      {
        contextType: 'case',
        contextId: parties.caseEngagementId,
        scheduledStart: START,
        scheduledEnd: END,
        engagementType: 'case',
        userId: parties.memberUserId,
      },
      log,
      { provisioner: recordingProvisioner() }
    );

    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(result.meeting.id, 'expert');
    await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: result.meeting.id,
      party: 'expert',
    });

    const rows = await calendarRowsFor(result.meeting.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
  });
});
