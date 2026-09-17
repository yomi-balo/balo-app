import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../../client';
import { meetingCalendarEvents } from '../../schema';
import { meetingFactory } from '../../test/factories';
import { meetingCalendarEventsRepository } from '../meeting-calendar-events';
import { bumpCalendarSequencesForMeetingTx } from './calendar-sequence';

/**
 * BAL-475 — `bumpCalendarSequencesForMeetingTx`, the ONLY writer of
 * `meeting_calendar_events.sequence`, against REAL Postgres.
 *
 * `sequence = sequence + 1` must read the STORED value (a mocked client cannot tell `+ 1` from
 * `= 1`), and the live-row scope must leave a retired series and other meetings alone. Its
 * transactional placement inside `meetingsRepository.updateSchedule` is proven in
 * `meetings.integration.test.ts`.
 */

/** One meeting with a live client ICS row and a live expert ICS row. */
async function seedTwoSidedMeeting(): Promise<{
  meetingId: string;
  clientId: string;
  expertId: string;
}> {
  const { meeting } = await meetingFactory();
  const client = await meetingCalendarEventsRepository.recordIcsDelivery({
    meetingId: meeting.id,
    party: 'client',
  });
  const expert = await meetingCalendarEventsRepository.recordIcsDelivery({
    meetingId: meeting.id,
    party: 'expert',
  });
  return { meetingId: meeting.id, clientId: client.id, expertId: expert.id };
}

async function storedSequence(id: string): Promise<number | undefined> {
  const [row] = await db
    .select({ sequence: meetingCalendarEvents.sequence })
    .from(meetingCalendarEvents)
    .where(eq(meetingCalendarEvents.id, id));
  return row?.sequence;
}

describe('bumpCalendarSequencesForMeetingTx', () => {
  it('bumps every live row of the meeting by exactly 1 and returns the post-bump rows, client first', async () => {
    const seeded = await seedTwoSidedMeeting();
    await db
      .update(meetingCalendarEvents)
      .set({ sequence: 4 })
      .where(eq(meetingCalendarEvents.id, seeded.expertId));

    const bumps = await bumpCalendarSequencesForMeetingTx(db, seeded.meetingId);

    expect(bumps).toEqual([
      { id: seeded.clientId, party: 'client', deliveryMode: 'ics', sequence: 1 },
      { id: seeded.expertId, party: 'expert', deliveryMode: 'ics', sequence: 5 },
    ]);
    expect(await storedSequence(seeded.clientId)).toBe(1);
    expect(await storedSequence(seeded.expertId)).toBe(5);
  });

  it('two calls bump twice, and never touch the uid', async () => {
    const seeded = await seedTwoSidedMeeting();
    const before = await meetingCalendarEventsRepository.listLiveByMeeting(seeded.meetingId);

    await bumpCalendarSequencesForMeetingTx(db, seeded.meetingId);
    const second = await bumpCalendarSequencesForMeetingTx(db, seeded.meetingId);

    expect(second.map((bump) => bump.sequence)).toEqual([2, 2]);
    const after = await meetingCalendarEventsRepository.listLiveByMeeting(seeded.meetingId);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((row) => row.uid))).toEqual(new Set(before.map((row) => row.uid)));
  });

  /** A retired series is never re-sent, so its SEQUENCE is history and must stay put. */
  it('leaves a soft-deleted row untouched and bumps only the live one', async () => {
    const seeded = await seedTwoSidedMeeting();
    await meetingCalendarEventsRepository.softDeleteByMeetingAndParty(seeded.meetingId, 'expert');

    const bumps = await bumpCalendarSequencesForMeetingTx(db, seeded.meetingId);

    expect(bumps).toEqual([
      { id: seeded.clientId, party: 'client', deliveryMode: 'ics', sequence: 1 },
    ]);
    expect(await storedSequence(seeded.expertId)).toBe(0);
  });

  it("never touches another meeting's rows", async () => {
    const mine = await seedTwoSidedMeeting();
    const theirs = await seedTwoSidedMeeting();

    await bumpCalendarSequencesForMeetingTx(db, mine.meetingId);

    expect(await storedSequence(theirs.clientId)).toBe(0);
    expect(await storedSequence(theirs.expertId)).toBe(0);
  });

  it('answers [] for a meeting with no calendar rows', async () => {
    const { meeting } = await meetingFactory();

    expect(await bumpCalendarSequencesForMeetingTx(db, meeting.id)).toEqual([]);
  });
});
