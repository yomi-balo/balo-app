import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { calendarConnections, meetingCalendarEvents, meetings } from '../schema';
import { expertDraftFactory, meetingFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import { calendarRepository } from './calendar';
import {
  meetingCalendarEventsRepository,
  type RecordProviderEventInput,
} from './meeting-calendar-events';

/**
 * BAL-396 §5 / BAL-433 — `meeting_calendar_events` against REAL Postgres.
 *
 * ⚠⚠ FOUR FAILURE MODES LIVE ONLY HERE, all green in `meeting-calendar-events.test.ts`
 * (which mocks the Drizzle client and never reaches a planner):
 *
 *   · **42P10** — `meeting_calendar_event_meeting_party_uq` is PARTIAL on
 *     `deleted_at IS NULL`, so BOTH writers' ON CONFLICT arbiters must restate that predicate
 *     as `targetWhere`. Without it, arbiter inference fails AT PLAN TIME and the FIRST write
 *     on an EMPTY table raises "no unique or exclusion constraint matching the ON CONFLICT
 *     specification".
 *
 *   · **SILENT RESURRECTION** — if the unique index ever loses its predicate, a
 *     cancelled-then-rebooked meeting takes the DO UPDATE arm against the soft-deleted row
 *     instead of inserting beside it. The row count and the row id are what catch that.
 *
 *   · **23514 ON THE BICONDITIONAL** — `delivery_mode = 'provider_event'` ⟺ all four provider
 *     columns present. This is what makes ADR-1044 Ruling 1 ("a provider write OR an ICS,
 *     never both") a constraint rather than a convention, and it is why `recordIcsDelivery`'s
 *     update arm must NULL the four columns.
 *
 *   · **23514 ON THE TWO-SIDED PARTY** — `meeting_participant_party` carries `observer`; this
 *     table does not accept it.
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

/** One meeting plus one live Apiroc connection — the two anchors a provider row needs. */
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

function providerInput(
  seeded: Seeded,
  overrides: Partial<RecordProviderEventInput> = {}
): RecordProviderEventInput {
  return {
    meetingId: seeded.meetingId,
    party: 'expert',
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

// ── recordProviderEvent ──────────────────────────────────────────

describe('meetingCalendarEventsRepository.recordProviderEvent', () => {
  it('persists the vendor event against its meeting, its party and its connection', async () => {
    const seeded = await seedMeetingAndConnection();

    const row = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { vendorEventId: 'vendor_abc', calendarId: 'cal_primary' })
    );

    expect(row).toMatchObject({
      meetingId: seeded.meetingId,
      party: 'expert',
      deliveryMode: 'provider_event',
      connectionId: seeded.connectionId,
      calendarId: 'cal_primary',
      vendorEventId: 'vendor_abc',
      deletedAt: null,
    });
    expect(row.id).toEqual(expect.any(String));
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  /**
   * ⚠⚠ THE 42P10 GATE, ON THE WIDENED ARBITER. A missing `targetWhere` fails on the FIRST
   * call below, not the second. The retry itself is the design: the vendor may answer with a
   * DIFFERENT id on the second attempt (Microsoft substitutes its own id silently), so the
   * row must end up holding the id that actually exists at the provider — one row, updated,
   * never two.
   */
  it('UPDATES IN PLACE on a retried write — one row, same id, no 42P10', async () => {
    const seeded = await seedMeetingAndConnection();

    const first = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { vendorEventId: 'vendor_first' })
    );
    const second = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { vendorEventId: 'vendor_second', calendarId: 'cal_other' })
    );

    expect(second.id).toBe(first.id);
    expect(second.vendorEventId).toBe('vendor_second');
    expect(second.calendarId).toBe('cal_other');
    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(1);
  });

  it('rejects a second LIVE row for the same (meeting, party) on a raw insert (23505)', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(seeded));

    // Probes the index itself rather than the upsert's DO UPDATE arm — the index is what
    // actually holds "one live calendar entry per (meeting, party)".
    await expectConstraintViolation('23505', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: seeded.meetingId,
        party: 'expert',
        deliveryMode: 'provider_event',
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
        party: 'expert',
        deliveryMode: 'provider_event',
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
        party: 'expert',
        deliveryMode: 'provider_event',
        connectionId: '00000000-0000-0000-0000-000000000000',
        calendarId: 'cal_work',
        vendorEventId: 'vendor_orphan',
        baloBookingId: 'balo_orphan',
      })
    );
  });
});

// ── recordIcsDelivery + the (meeting, party) grain ───────────────

describe('meetingCalendarEventsRepository.recordIcsDelivery', () => {
  /**
   * ⚠ SLICE 1 RECORDS A CONDITION AND SENDS NOTHING. The row IS the decision — BAL-475 reads
   * it rather than re-deriving "has this expert a writable calendar?" from
   * `calendar_connections`.
   */
  it('persists the fallback condition with NO provider payload at all', async () => {
    const { meeting } = await meetingFactory();

    const row = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: meeting.id,
      party: 'expert',
    });

    expect(row).toMatchObject({
      meetingId: meeting.id,
      party: 'expert',
      deliveryMode: 'ics',
      connectionId: null,
      calendarId: null,
      vendorEventId: null,
      baloBookingId: null,
      deletedAt: null,
    });
  });

  /**
   * THE GRAIN, PROVEN. Two parties, one meeting, two live rows — which is what makes the
   * client-party ICS (BAL-475) one repository call rather than a migration.
   */
  it('lets the two parties coexist on one meeting — two live rows, distinct ids', async () => {
    const seeded = await seedMeetingAndConnection();

    const expertRow = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded)
    );
    const clientRow = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: seeded.meetingId,
      party: 'client',
    });

    expect(clientRow.id).not.toBe(expertRow.id);
    const rows = await allRowsForMeeting(seeded.meetingId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.deletedAt === null)).toBe(true);
    expect(rows.map((row) => row.party).sort()).toEqual(['client', 'expert']);
  });

  /**
   * ⚠⚠ THE ORPHAN GUARD, AGAINST REAL POSTGRES. Overwriting a live `provider_event` row with
   * an ICS fallback would null the four columns that ADDRESS the vendor event while deleting
   * NOTHING at the provider — the event stays on the expert's external calendar for good,
   * blocking a window Balo no longer believes in, and Balo can no longer reach it.
   * `setWhere` narrows the DO UPDATE arm to rows that are already `ics`, so this conflict
   * updates zero rows and the repository throws.
   *
   * ⚠ NOT A CONSTRAINT VIOLATION — the statement SUCCEEDS and returns no row, so the outer
   * transaction is still usable and the assertions after the rejection are valid (unlike the
   * 23514 probes, which must each end their own `it`).
   */
  it('REFUSES to overwrite a live provider row with an ICS fallback, leaving it intact', async () => {
    const seeded = await seedMeetingAndConnection();

    const provider = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded)
    );

    await expect(
      meetingCalendarEventsRepository.recordIcsDelivery({
        meetingId: seeded.meetingId,
        party: 'expert',
      })
    ).rejects.toThrow(/provider_event/);

    const rows = await allRowsForMeeting(seeded.meetingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: provider.id,
      deliveryMode: 'provider_event',
      connectionId: seeded.connectionId,
      calendarId: 'cal_work',
      vendorEventId: 'vendor_evt_1',
      deletedAt: null,
    });
  });

  /**
   * THE SANCTIONED ORDER for that transition, proven end to end: delete at the vendor (not
   * this layer's job), soft-delete the row, THEN record the ICS. The partial unique ignores
   * the soft-deleted row, so this INSERTs beside it — which is why the refusal above costs a
   * caller nothing beyond the vendor delete it already owed.
   */
  it('accepts the ICS fallback once the provider row is soft-deleted — a NEW row beside it', async () => {
    const seeded = await seedMeetingAndConnection();

    const provider = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded)
    );
    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(seeded.meetingId, 'expert');

    const fallback = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: seeded.meetingId,
      party: 'expert',
    });

    expect(fallback.id).not.toBe(provider.id);
    expect(fallback.deliveryMode).toBe('ics');
    expect(fallback.connectionId).toBeNull();
    expect(fallback.calendarId).toBeNull();
    expect(fallback.vendorEventId).toBeNull();
    expect(fallback.baloBookingId).toBeNull();

    const rows = await allRowsForMeeting(seeded.meetingId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
  });

  /**
   * A RETRIED FALLBACK IS STILL IDEMPOTENT. `setWhere` gates on the EXISTING row's mode, so
   * an already-`ics` row takes the update arm exactly as before — the guard narrows the
   * dangerous direction only.
   */
  it('UPDATES IN PLACE on a retried ICS fallback — one row, same id', async () => {
    const { meeting } = await meetingFactory();

    const first = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: meeting.id,
      party: 'expert',
    });
    const second = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: meeting.id,
      party: 'expert',
    });

    expect(second.id).toBe(first.id);
    expect(await allRowsForMeeting(meeting.id)).toHaveLength(1);
  });

  /** The other direction: an ICS row that later gets a real vendor write. */
  it('REPLACES an ICS row in place when the same party gets a provider write', async () => {
    const seeded = await seedMeetingAndConnection();

    const fallback = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: seeded.meetingId,
      party: 'expert',
    });
    const provider = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { vendorEventId: 'vendor_late' })
    );

    expect(provider.id).toBe(fallback.id);
    expect(provider.deliveryMode).toBe('provider_event');
    expect(provider.vendorEventId).toBe('vendor_late');
    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(1);
  });
});

// ── CHECK constraints ────────────────────────────────────────────

describe('meeting_calendar_events — CHECK constraints', () => {
  /**
   * ⚠ THE BICONDITIONAL, BOTH WAYS. An `ics` row carrying a vendor id would claim an event
   * Balo never wrote; a `provider_event` row missing one claims an event it cannot address.
   */
  it('rejects an ics row carrying a provider payload, and a provider row missing one (23514)', async () => {
    const seeded = await seedMeetingAndConnection();

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: seeded.meetingId,
        party: 'expert',
        deliveryMode: 'ics',
        vendorEventId: 'vendor_should_not_exist',
      })
    );

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: seeded.meetingId,
        party: 'client',
        deliveryMode: 'provider_event',
        connectionId: seeded.connectionId,
        calendarId: 'cal_work',
        vendorEventId: null,
        baloBookingId: 'balo_tag',
      })
    );
  });

  /**
   * `meeting_participant_party` carries `observer` so a Balo staffer's presence needs no
   * `ALTER TYPE … ADD VALUE`. A calendar entry has exactly two sides, and the CHECK — not the
   * enum — is what says so.
   */
  it('rejects the third party label (23514)', async () => {
    const seeded = await seedMeetingAndConnection();

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(meetingCalendarEvents).values({
        meetingId: seeded.meetingId,
        party: 'observer',
        deliveryMode: 'ics',
      })
    );
  });
});

// ── reads ────────────────────────────────────────────────────────

describe('meetingCalendarEventsRepository reads', () => {
  it('findLiveExpertProviderEvent returns the live expert provider row, and undefined once soft-deleted', async () => {
    const seeded = await seedMeetingAndConnection();
    const written = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded)
    );

    expect(
      (await meetingCalendarEventsRepository.findLiveExpertProviderEvent(seeded.meetingId))?.id
    ).toBe(written.id);

    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(seeded.meetingId, 'expert');

    // `undefined` means "no live vendor event" — which a delete/amend path must read as
    // "nothing to address at the vendor", never as an error.
    expect(
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent(seeded.meetingId)
    ).toBeUndefined();
  });

  /**
   * ⚠⚠ THE REASON `findLiveByMeetingId` WAS DELETED RATHER THAN ADAPTED. Three reschedule
   * routes turn this read into `hasVendorEvent`, which feeds the availability exclusion: an
   * ICS-fallback row answering "yes" would drop a real busy block and let the expert be
   * DOUBLE-BOOKED, typecheck-clean and with every mocked test green.
   */
  it('findLiveExpertProviderEvent answers undefined for an ICS-fallback expert row', async () => {
    const { meeting } = await meetingFactory();
    await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: meeting.id,
      party: 'expert',
    });

    expect(
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent(meeting.id)
    ).toBeUndefined();
  });

  it('findLiveExpertProviderEvent answers undefined for a CLIENT-party provider row', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { party: 'client' })
    );

    // The party filter, isolated from the delivery-mode filter: whose calendar the entry
    // belongs to is a different question from what Balo can address at the vendor.
    expect(
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent(seeded.meetingId)
    ).toBeUndefined();
  });

  it('findLiveExpertProviderEvent returns undefined for a meeting Balo never wrote an entry for', async () => {
    const { meeting } = await meetingFactory();

    expect(
      await meetingCalendarEventsRepository.findLiveExpertProviderEvent(meeting.id)
    ).toBeUndefined();
  });

  it('listLiveByConnectionId returns every live event written through THAT connection', async () => {
    const first = await seedMeetingAndConnection();
    const { meeting: secondMeeting } = await meetingFactory();
    const other = await seedMeetingAndConnection('microsoft');

    const a = await meetingCalendarEventsRepository.recordProviderEvent(providerInput(first));
    const b = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput({ meetingId: secondMeeting.id, connectionId: first.connectionId })
    );
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(other));
    // An ICS row carries no `connection_id`, so it cannot appear in a connection's sweep.
    await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: first.meetingId,
      party: 'client',
    });

    const live = await meetingCalendarEventsRepository.listLiveByConnectionId(first.connectionId);

    // A different connection's events live in a different vendor account and are unreachable
    // with this pointer, so they must not appear in this connection's sweep list.
    expect(live.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('listLiveByConnectionId excludes soft-deleted rows and answers [] when there are none', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(seeded));
    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(seeded.meetingId, 'expert');

    expect(
      await meetingCalendarEventsRepository.listLiveByConnectionId(seeded.connectionId)
    ).toEqual([]);
  });
});

// ── soft delete + rebook ─────────────────────────────────────────

describe('meetingCalendarEventsRepository.softDeleteByMeetingAndParty', () => {
  /**
   * ⚠⚠ THE PARTIAL-UNIQUE PROOF, AND THE REASON THE INDEX KEPT ITS PREDICATE THROUGH THE
   * WIDENING. A cancelled meeting that is rebooked must be able to write a SECOND calendar
   * entry. With a NON-partial unique the write would instead take the DO UPDATE arm against
   * the invisible soft-deleted row — same id, one row — which is the documented Balo
   * soft-delete footgun (`reference_softdelete_nonpartial_unique_recreate`).
   */
  it('record → soft-delete → re-record INSERTS a fresh row beside the old one', async () => {
    const seeded = await seedMeetingAndConnection();

    const cancelled = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { vendorEventId: 'vendor_cancelled' })
    );
    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(seeded.meetingId, 'expert');

    const rebooked = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded, { vendorEventId: 'vendor_rebooked' })
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

  /**
   * ⚠ PARTY-SCOPED, AND THAT IS THE WHOLE RENAME. Both callers act on the EXPERT's event (a
   * vendor 404, a cancel). A whole-meeting soft delete would take the client's entry down as
   * collateral for a failure on the expert's calendar.
   */
  it('soft-deleting the expert row leaves the CLIENT row live', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(seeded));
    const clientRow = await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: seeded.meetingId,
      party: 'client',
    });

    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(seeded.meetingId, 'expert');

    const live = (await allRowsForMeeting(seeded.meetingId)).filter((r) => r.deletedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(clientRow.id);
  });

  it('is a no-op when there is no live row, and never touches another meeting', async () => {
    const mine = await seedMeetingAndConnection();
    const { meeting: theirs } = await meetingFactory();
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(mine));
    const untouched = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput({ meetingId: theirs.id, connectionId: mine.connectionId })
    );

    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(mine.meetingId, 'expert');
    // Second call has nothing live left to mark — it must not throw.
    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(mine.meetingId, 'expert');

    expect((await meetingCalendarEventsRepository.findLiveExpertProviderEvent(theirs.id))?.id).toBe(
      untouched.id
    );
  });
});

// ── cascades ─────────────────────────────────────────────────────

describe('meeting_calendar_events — FK cascades', () => {
  it('hard-deleting the meeting removes its calendar-event records', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(seeded));
    // The ICS row has no connection to cascade from — only the meeting FK holds it.
    await meetingCalendarEventsRepository.recordIcsDelivery({
      meetingId: seeded.meetingId,
      party: 'client',
    });

    // Hard delete is the seed truncator's path (nothing in the app hard-deletes a meeting) —
    // a record pointing at a vendor event for a meeting that no longer exists is worse than
    // no record.
    await db.delete(meetings).where(eq(meetings.id, seeded.meetingId));

    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(0);
  });

  it('hard-deleting the connection removes its calendar-event records', async () => {
    const seeded = await seedMeetingAndConnection();
    await meetingCalendarEventsRepository.recordProviderEvent(providerInput(seeded));

    await db.delete(calendarConnections).where(eq(calendarConnections.id, seeded.connectionId));

    expect(await allRowsForMeeting(seeded.meetingId)).toHaveLength(0);
  });

  it('SOFT-deleting the connection leaves the record intact — the event still exists at the vendor', async () => {
    const seeded = await seedMeetingAndConnection();
    const written = await meetingCalendarEventsRepository.recordProviderEvent(
      providerInput(seeded)
    );

    await db
      .update(calendarConnections)
      .set({ deletedAt: new Date() })
      .where(eq(calendarConnections.id, seeded.connectionId));

    // Disconnecting a calendar does not un-write the events Balo already put in it. The row
    // must survive so a sweep can still address them by `balo_booking_id`.
    expect(
      (await meetingCalendarEventsRepository.findLiveExpertProviderEvent(seeded.meetingId))?.id
    ).toBe(written.id);
  });
});
