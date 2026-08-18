import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { calendarConnections, meetingCalendarEvents, meetings } from '../schema';
import { expertDraftFactory, meetingFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { calendarRepository } from './calendar';
import {
  meetingCalendarEventsRepository,
  type RecordCalendarEventInput,
} from './meeting-calendar-events';

/**
 * BAL-396 §5 — `meeting_calendar_events` against REAL Postgres.
 *
 * ⚠⚠ TWO FAILURE MODES LIVE ONLY HERE, both green in `meeting-calendar-events.test.ts`
 * (which mocks the Drizzle client and never reaches a planner):
 *
 *   · **42P10** — `meeting_calendar_event_meeting_uq` is PARTIAL on `deleted_at IS NULL`, so
 *     `record`'s ON CONFLICT arbiter must restate that predicate as `targetWhere`. Without
 *     it, arbiter inference fails AT PLAN TIME and the FIRST write on an EMPTY table raises
 *     "no unique or exclusion constraint matching the ON CONFLICT specification".
 *
 *   · **SILENT RESURRECTION** — if the unique index ever loses its predicate, a
 *     cancelled-then-rebooked meeting takes the DO UPDATE arm against the soft-deleted row
 *     instead of inserting beside it. The row count and the row id are what catch that.
 *
 * ⚠ SOME TESTS END ON A REJECTED CALL WITH NOTHING AFTER IT. Deliberate: the harness holds
 * each test in ONE outer transaction, so a statement that fails on the module-level `db`
 * ABORTS it and every later statement answers `25P02` instead of the code under assertion.
 * Raw probes go through `expectConstraintViolation` (its own SAVEPOINT); repository probes
 * cannot, so each is the LAST statement of its own `it`.
 */

// ── Fixtures ──────────────────────────────────────────────────────

interface Seeded {
  meetingId: string;
  connectionId: string;
}

/** One meeting plus one live Apiroc connection — the two anchors every row needs. */
async function seedMeetingAndConnection(provider = 'google'): Promise<Seeded> {
  const { meeting } = await meetingFactory();
  const expert = await expertDraftFactory();
  const connection = await calendarRepository.upsertApirocConnection({
    expertProfileId: expert.id,
    provider,
    endUserAccountId: `eua_${provider}_${expert.id.slice(0, 8)}`,
  });
  return { meetingId: meeting.id, connectionId: connection.id };
}

function recordInput(
  seeded: Seeded,
  overrides: Partial<RecordCalendarEventInput> = {}
): RecordCalendarEventInput {
  return {
    meetingId: seeded.meetingId,
    connectionId: seeded.connectionId,
    calendarId: 'cal_work',
    vendorEventId: 'vendor_evt_1',
    baloBookingId: `balo_${seeded.meetingId}`,
    ...overrides,
  };
}

/** Every row for a meeting, live or soft-deleted. */
async function allRowsForMeeting(
  meetingId: string
): Promise<(typeof meetingCalendarEvents.$inferSelect)[]> {
  return db
    .select()
    .from(meetingCalendarEvents)
    .where(eq(meetingCalendarEvents.meetingId, meetingId));
}

// ── record ───────────────────────────────────────────────────────

describe('meetingCalendarEventsRepository.record', () => {
  it('persists the vendor event against its meeting and its connection', async () => {
    const seeded = await seedMeetingAndConnection();

    const row = await meetingCalendarEventsRepository.record(
      recordInput(seeded, { vendorEventId: 'vendor_abc', calendarId: 'cal_primary' })
    );

    expect(row).toMatchObject({
      meetingId: seeded.meetingId,
      connectionId: seeded.connectionId,
      calendarId: 'cal_primary',
      vendorEventId: 'vendor_abc',
      deletedAt: null,
    });
    expect(row.id).toEqual(expect.any(String));
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  /**
   * ⚠⚠ THE 42P10 GATE. A missing `targetWhere` fails on the FIRST call below, not the second.
   * The retry itself is the design: the vendor may answer with a DIFFERENT id on the second
   * attempt (Microsoft substitutes its own id silently), so the row must end up holding the
   * id that actually exists at the provider — one row, updated, never two.
   */
  it('UPDATES IN PLACE on a retried write — one row, same id, no 42P10', async () => {
    const seeded = await seedMeetingAndConnection();

    const first = await meetingCalendarEventsRepository.record(
      recordInput(seeded, { vendorEventId: 'vendor_first' })
    );
    const second = await meetingCalendarEventsRepository.record(
      recordInput(seeded, { vendorEventId: 'vendor_second', calendarId: 'cal_other' })
    );

    expect(second.id).toBe(first.id);
    expect(second.vendorEventId).toBe('vendor_second');
    expect(second.calendarId).toBe('cal_other');
    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(1);
  });

  it('rejects a second LIVE row for the same meeting on a raw insert (23505)', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.record(recordInput(seeded));

    // Probes the index itself rather than the upsert's DO UPDATE arm — the index is what
    // actually holds "one live calendar event per meeting".
    await expectConstraintViolation('23505', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: seeded.meetingId,
        connectionId: seeded.connectionId,
        calendarId: 'cal_dupe',
        vendorEventId: 'vendor_dupe',
        baloBookingId: 'balo_dupe',
      })
    );
  });

  it('refuses a row that names no real meeting (23503)', async () => {
    const seeded = await seedMeetingAndConnection();

    await expectConstraintViolation('23503', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: '00000000-0000-0000-0000-000000000000',
        connectionId: seeded.connectionId,
        calendarId: 'cal_work',
        vendorEventId: 'vendor_orphan',
        baloBookingId: 'balo_orphan',
      })
    );
  });

  it('refuses a row that names no real connection (23503)', async () => {
    const seeded = await seedMeetingAndConnection();

    await expectConstraintViolation('23503', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: seeded.meetingId,
        connectionId: '00000000-0000-0000-0000-000000000000',
        calendarId: 'cal_work',
        vendorEventId: 'vendor_orphan',
        baloBookingId: 'balo_orphan',
      })
    );
  });
});

// ── reads ────────────────────────────────────────────────────────

describe('meetingCalendarEventsRepository reads', () => {
  it('findLiveByMeetingId returns the live row, and undefined once it is soft-deleted', async () => {
    const seeded = await seedMeetingAndConnection();
    const written = await meetingCalendarEventsRepository.record(recordInput(seeded));

    expect((await meetingCalendarEventsRepository.findLiveByMeetingId(seeded.meetingId))?.id).toBe(
      written.id
    );

    await meetingCalendarEventsRepository.softDeleteByMeetingId(seeded.meetingId);

    // `undefined` means "no live calendar event" — which a delete path must read as "nothing
    // to delete at the vendor", never as an error.
    expect(
      await meetingCalendarEventsRepository.findLiveByMeetingId(seeded.meetingId)
    ).toBeUndefined();
  });

  it('findLiveByMeetingId returns undefined for a meeting Balo never wrote an event for', async () => {
    const { meeting } = await meetingFactory();

    expect(await meetingCalendarEventsRepository.findLiveByMeetingId(meeting.id)).toBeUndefined();
  });

  it('listLiveByConnectionId returns every live event written through THAT connection', async () => {
    const first = await seedMeetingAndConnection();
    const { meeting: secondMeeting } = await meetingFactory();
    const other = await seedMeetingAndConnection('microsoft');

    const a = await meetingCalendarEventsRepository.record(recordInput(first));
    const b = await meetingCalendarEventsRepository.record(
      recordInput({ meetingId: secondMeeting.id, connectionId: first.connectionId })
    );
    await meetingCalendarEventsRepository.record(recordInput(other));

    const live = await meetingCalendarEventsRepository.listLiveByConnectionId(first.connectionId);

    // A different connection's events live in a different vendor account and are unreachable
    // with this pointer, so they must not appear in this connection's sweep list.
    expect(live.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('listLiveByConnectionId excludes soft-deleted rows and answers [] when there are none', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.record(recordInput(seeded));
    await meetingCalendarEventsRepository.softDeleteByMeetingId(seeded.meetingId);

    expect(
      await meetingCalendarEventsRepository.listLiveByConnectionId(seeded.connectionId)
    ).toEqual([]);
  });
});

// ── soft delete + rebook ─────────────────────────────────────────

describe('meetingCalendarEventsRepository.softDeleteByMeetingId', () => {
  /**
   * ⚠⚠ THE PARTIAL-UNIQUE PROOF, AND THE REASON THE INDEX CARRIES A PREDICATE. A cancelled
   * meeting that is rebooked must be able to write a SECOND calendar event. With a
   * NON-partial unique the write would instead take the DO UPDATE arm against the invisible
   * soft-deleted row — same id, one row — which is the documented Balo soft-delete footgun
   * (`reference_softdelete_nonpartial_unique_recreate`).
   */
  it('record → find → soft-delete → re-record INSERTS a fresh row beside the old one', async () => {
    const seeded = await seedMeetingAndConnection();

    const cancelled = await meetingCalendarEventsRepository.record(
      recordInput(seeded, { vendorEventId: 'vendor_cancelled' })
    );
    await meetingCalendarEventsRepository.softDeleteByMeetingId(seeded.meetingId);

    const rebooked = await meetingCalendarEventsRepository.record(
      recordInput(seeded, { vendorEventId: 'vendor_rebooked' })
    );

    expect(rebooked.id).not.toBe(cancelled.id);
    expect(rebooked.deletedAt).toBeNull();
    expect(rebooked.vendorEventId).toBe('vendor_rebooked');
    // Exactly one LIVE row, two rows in total — the cancelled one survives as history.
    expect(
      (await allRowsForMeeting(seeded.meetingId)).filter((r) => r.deletedAt === null)
    ).toHaveLength(1);
    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(2);
  });

  it('is a no-op when there is no live row, and never touches another meeting', async () => {
    const mine = await seedMeetingAndConnection();
    const { meeting: theirs } = await meetingFactory();
    await meetingCalendarEventsRepository.record(recordInput(mine));
    const untouched = await meetingCalendarEventsRepository.record(
      recordInput({ meetingId: theirs.id, connectionId: mine.connectionId })
    );

    await meetingCalendarEventsRepository.softDeleteByMeetingId(mine.meetingId);
    // Second call has nothing live left to mark — it must not throw.
    await meetingCalendarEventsRepository.softDeleteByMeetingId(mine.meetingId);

    expect((await meetingCalendarEventsRepository.findLiveByMeetingId(theirs.id))?.id).toBe(
      untouched.id
    );
  });
});

// ── cascades ─────────────────────────────────────────────────────

describe('meeting_calendar_events — FK cascades', () => {
  it('hard-deleting the meeting removes its calendar-event record', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.record(recordInput(seeded));

    // Hard delete is the seed truncator's path (nothing in the app hard-deletes a meeting) —
    // a record pointing at a vendor event for a meeting that no longer exists is worse than
    // no record.
    await db.delete(meetings).where(eq(meetings.id, seeded.meetingId));

    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(0);
  });

  it('hard-deleting the connection removes its calendar-event records', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.record(recordInput(seeded));

    await db.delete(calendarConnections).where(eq(calendarConnections.id, seeded.connectionId));

    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(0);
  });

  it('SOFT-deleting the connection leaves the record intact — the event still exists at the vendor', async () => {
    const seeded = await seedMeetingAndConnection();
    const written = await meetingCalendarEventsRepository.record(recordInput(seeded));

    await db
      .update(calendarConnections)
      .set({ deletedAt: new Date() })
      .where(eq(calendarConnections.id, seeded.connectionId));

    // Disconnecting a calendar does not un-write the events Balo already put in it. The row
    // must survive so a sweep can still address them by `balo_booking_id`.
    expect((await meetingCalendarEventsRepository.findLiveByMeetingId(seeded.meetingId))?.id).toBe(
      written.id
    );
  });
});
