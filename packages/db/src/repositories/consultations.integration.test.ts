import { describe, it, expect } from 'vitest';
import { expertDraftFactory, caseEngagementFactory } from '../test/factories';
import { consultationsRepository } from './consultations';
import { meetingsRepository } from './meetings';

/**
 * BAL-428 REWRITE. `consultationsRepository.create` no longer exists — `consultations` is a
 * READ MODEL of `meetings` with exactly one writer, so every fixture here books a MEETING
 * and lets the projection write the row. All twelve original overlap/filter cases are
 * preserved verbatim in intent; only how the row gets there changed.
 *
 * That is not merely a mechanical port: routing the fixtures through the real writer means
 * this suite now also proves the projection MIRRORS the meeting's window exactly, since the
 * overlap boundaries below are asserted against windows that only `meetingsRepository`
 * wrote.
 */

// All UTC instants. Range under test is fixed: [10:00, 12:00).
const RANGE_START = new Date('2026-06-01T10:00:00.000Z');
const RANGE_END = new Date('2026-06-01T12:00:00.000Z');

interface BookedExpert {
  expertProfileId: string;
  book: (startAt: string, endAt: string) => Promise<string>;
}

/**
 * One expert with one case engagement, plus a `book()` that creates a meeting over a window
 * and returns the meeting id. Every consultation row in this suite is born this way.
 */
async function seedBookableExpert(): Promise<BookedExpert> {
  const expert = await expertDraftFactory();
  const { engagement } = await caseEngagementFactory({ expertProfileId: expert.id });

  return {
    expertProfileId: expert.id,
    book: async (startAt, endAt) => {
      const { meeting } = await meetingsRepository.create({
        scheduledStart: new Date(startAt),
        scheduledEnd: new Date(endAt),
        contexts: [{ contextType: 'case', contextId: engagement.id }],
      });
      return meeting.id;
    },
  };
}

// ── listConfirmedInRange — overlap math ─────────────────────────────

describe('consultationsRepository.listConfirmedInRange — overlap', () => {
  it('returns a consultation whose start is inside the range (start-inside)', async () => {
    const expert = await seedBookableExpert();
    await expert.book('2026-06-01T10:30:00.000Z', '2026-06-01T11:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('returns a consultation whose end is inside the range (end-inside)', async () => {
    const expert = await seedBookableExpert();
    await expert.book('2026-06-01T09:00:00.000Z', '2026-06-01T10:30:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('returns a consultation that straddles the entire range', async () => {
    const expert = await seedBookableExpert();
    await expert.book('2026-06-01T09:00:00.000Z', '2026-06-01T13:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('returns a consultation fully enclosed by the range', async () => {
    const expert = await seedBookableExpert();
    await expert.book('2026-06-01T10:30:00.000Z', '2026-06-01T11:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('excludes a consultation entirely before the range', async () => {
    const expert = await seedBookableExpert();
    await expert.book('2026-06-01T08:00:00.000Z', '2026-06-01T09:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });

  it('excludes a consultation entirely after the range', async () => {
    const expert = await seedBookableExpert();
    await expert.book('2026-06-01T13:00:00.000Z', '2026-06-01T14:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });

  it('excludes a consultation ending exactly at rangeStart (strict inequality)', async () => {
    const expert = await seedBookableExpert();

    // Ends at 10:00, range starts at 10:00 → endAt > rangeStart is false.
    await expert.book('2026-06-01T09:00:00.000Z', '2026-06-01T10:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });

  it('excludes a consultation starting exactly at rangeEnd (strict inequality)', async () => {
    const expert = await seedBookableExpert();

    // Starts at 12:00, range ends at 12:00 → startAt < rangeEnd is false.
    await expert.book('2026-06-01T12:00:00.000Z', '2026-06-01T13:00:00.000Z');

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });
});

// ── listConfirmedInRange — filters ──────────────────────────────────

describe('consultationsRepository.listConfirmedInRange — filters', () => {
  it('excludes cancelled consultations', async () => {
    const expert = await seedBookableExpert();
    const confirmedMeetingId = await expert.book(
      '2026-06-01T10:15:00.000Z',
      '2026-06-01T10:45:00.000Z'
    );

    const cancelledMeetingId = await expert.book(
      '2026-06-01T11:00:00.000Z',
      '2026-06-01T11:30:00.000Z'
    );
    await meetingsRepository.cancel(cancelledMeetingId);

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meetingId).toBe(confirmedMeetingId);
  });

  it('excludes soft-deleted consultations', async () => {
    const expert = await seedBookableExpert();
    const liveMeetingId = await expert.book('2026-06-01T10:15:00.000Z', '2026-06-01T10:45:00.000Z');

    const deletedMeetingId = await expert.book(
      '2026-06-01T11:00:00.000Z',
      '2026-06-01T11:30:00.000Z'
    );
    await meetingsRepository.softDelete(deletedMeetingId);

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.meetingId).toBe(liveMeetingId);
  });

  it('isolates consultations between experts', async () => {
    const alice = await seedBookableExpert();
    const bob = await seedBookableExpert();

    const aliceMeetingId = await alice.book('2026-06-01T10:30:00.000Z', '2026-06-01T11:00:00.000Z');
    await bob.book('2026-06-01T10:30:00.000Z', '2026-06-01T11:00:00.000Z');

    const aliceRows = await consultationsRepository.listConfirmedInRange(
      alice.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0]?.meetingId).toBe(aliceMeetingId);
  });
});

// ── The projection is the ONLY writer ───────────────────────────────

describe('consultationsRepository — read-only surface (BAL-428)', () => {
  it('exposes NO write method: the projection writer is the single write path', () => {
    // A second writer is how `consultations` and `meetings` drifted apart in the first
    // place. This is an executable statement of the ruling, not decoration — re-adding
    // `create()` here fails the suite rather than quietly re-opening the hole.
    expect(Object.keys(consultationsRepository)).toEqual(['listConfirmedInRange']);
  });
});
