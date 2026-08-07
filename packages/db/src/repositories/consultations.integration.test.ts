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

/**
 * THE OVERLAP MATRIX against the fixed range `[10:00, 12:00)`. Every case is the same three
 * steps against a different window, so it is ONE parameterized test rather than eight
 * copy-pasted bodies (a SonarCloud "replace these N tests with a single Parameterized one"
 * finding, and it reads better: the boundary math is now a table you can scan).
 *
 * ⚠ ONE GAP CLOSED IN PASSING. The eight hand-written cases this replaced included
 * "start-inside" and "fully enclosed" — with the SAME window, `10:30–11:00`. They were two
 * names for one fixture, which left the real "starts inside, ends AFTER the range" boundary
 * untested. `start-inside` below is now `11:30–13:00`, and `fully-enclosed` keeps
 * `10:30–11:00`, so the four inclusion shapes are genuinely distinct.
 *
 * Overlap is `startAt < rangeEnd AND endAt > rangeStart` — STRICT both ends, which is what
 * the two touching cases pin.
 */
const OVERLAP_CASES: readonly {
  label: string;
  startAt: string;
  endAt: string;
  overlaps: boolean;
}[] = [
  // ── Included ──
  { label: 'start-inside (ends after)', startAt: '11:30', endAt: '13:00', overlaps: true },
  { label: 'end-inside (starts before)', startAt: '09:00', endAt: '10:30', overlaps: true },
  { label: 'straddles the entire range', startAt: '09:00', endAt: '13:00', overlaps: true },
  { label: 'fully enclosed by the range', startAt: '10:30', endAt: '11:00', overlaps: true },
  // ── Excluded ──
  { label: 'entirely before the range', startAt: '08:00', endAt: '09:00', overlaps: false },
  { label: 'entirely after the range', startAt: '13:00', endAt: '14:00', overlaps: false },
  // Ends AT rangeStart → `endAt > rangeStart` is false. The slot is free at that instant.
  {
    label: 'ends exactly at rangeStart (strict)',
    startAt: '09:00',
    endAt: '10:00',
    overlaps: false,
  },
  // Starts AT rangeEnd → `startAt < rangeEnd` is false.
  {
    label: 'starts exactly at rangeEnd (strict)',
    startAt: '12:00',
    endAt: '13:00',
    overlaps: false,
  },
];

describe('consultationsRepository.listConfirmedInRange — overlap', () => {
  it.each(OVERLAP_CASES)('$label → overlaps=$overlaps', async ({ startAt, endAt, overlaps }) => {
    const expert = await seedBookableExpert();
    await expert.book(`2026-06-01T${startAt}:00.000Z`, `2026-06-01T${endAt}:00.000Z`);

    const rows = await consultationsRepository.listConfirmedInRange(
      expert.expertProfileId,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(overlaps ? 1 : 0);
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
