import { describe, it, expect } from 'vitest';
import { expertDraftFactory } from '../test/factories';
import { consultationsRepository } from './consultations';

// All UTC instants. Range under test is fixed: [10:00, 12:00).
const RANGE_START = new Date('2026-06-01T10:00:00.000Z');
const RANGE_END = new Date('2026-06-01T12:00:00.000Z');

// ── create ──────────────────────────────────────────────────────────

describe('consultationsRepository.create', () => {
  it('inserts a confirmed consultation with returned id and defaults', async () => {
    const draft = await expertDraftFactory();

    const row = await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T10:00:00.000Z'),
      endAt: new Date('2026-06-01T11:00:00.000Z'),
    });

    expect(row.id).toBeDefined();
    expect(row.expertProfileId).toBe(draft.id);
    expect(row.status).toBe('confirmed'); // default
    expect(row.deletedAt).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});

// ── listConfirmedInRange — overlap math ─────────────────────────────

describe('consultationsRepository.listConfirmedInRange — overlap', () => {
  it('returns a consultation whose start is inside the range (start-inside)', async () => {
    const draft = await expertDraftFactory();

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T10:30:00.000Z'),
      endAt: new Date('2026-06-01T11:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('returns a consultation whose end is inside the range (end-inside)', async () => {
    const draft = await expertDraftFactory();

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T10:30:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('returns a consultation that straddles the entire range', async () => {
    const draft = await expertDraftFactory();

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T13:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('returns a consultation fully enclosed by the range', async () => {
    const draft = await expertDraftFactory();

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T10:30:00.000Z'),
      endAt: new Date('2026-06-01T11:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
  });

  it('excludes a consultation entirely before the range', async () => {
    const draft = await expertDraftFactory();

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T08:00:00.000Z'),
      endAt: new Date('2026-06-01T09:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });

  it('excludes a consultation entirely after the range', async () => {
    const draft = await expertDraftFactory();

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T13:00:00.000Z'),
      endAt: new Date('2026-06-01T14:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });

  it('excludes a consultation ending exactly at rangeStart (strict inequality)', async () => {
    const draft = await expertDraftFactory();

    // Ends at 10:00, range starts at 10:00 → endAt > rangeStart is false.
    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T09:00:00.000Z'),
      endAt: new Date('2026-06-01T10:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });

  it('excludes a consultation starting exactly at rangeEnd (strict inequality)', async () => {
    const draft = await expertDraftFactory();

    // Starts at 12:00, range ends at 12:00 → startAt < rangeEnd is false.
    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T12:00:00.000Z'),
      endAt: new Date('2026-06-01T13:00:00.000Z'),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toEqual([]);
  });
});

// ── listConfirmedInRange — filters ──────────────────────────────────

describe('consultationsRepository.listConfirmedInRange — filters', () => {
  it('excludes cancelled consultations', async () => {
    const draft = await expertDraftFactory();

    const confirmed = await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T10:15:00.000Z'),
      endAt: new Date('2026-06-01T10:45:00.000Z'),
      status: 'confirmed',
    });

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T11:00:00.000Z'),
      endAt: new Date('2026-06-01T11:30:00.000Z'),
      status: 'cancelled',
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(confirmed.id);
  });

  it('excludes soft-deleted consultations', async () => {
    const draft = await expertDraftFactory();

    const live = await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T10:15:00.000Z'),
      endAt: new Date('2026-06-01T10:45:00.000Z'),
    });

    await consultationsRepository.create({
      expertProfileId: draft.id,
      startAt: new Date('2026-06-01T11:00:00.000Z'),
      endAt: new Date('2026-06-01T11:30:00.000Z'),
      deletedAt: new Date(),
    });

    const rows = await consultationsRepository.listConfirmedInRange(
      draft.id,
      RANGE_START,
      RANGE_END
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(live.id);
  });

  it('isolates consultations between experts', async () => {
    const alice = await expertDraftFactory();
    const bob = await expertDraftFactory();

    const aliceConsult = await consultationsRepository.create({
      expertProfileId: alice.id,
      startAt: new Date('2026-06-01T10:30:00.000Z'),
      endAt: new Date('2026-06-01T11:00:00.000Z'),
    });

    await consultationsRepository.create({
      expertProfileId: bob.id,
      startAt: new Date('2026-06-01T10:30:00.000Z'),
      endAt: new Date('2026-06-01T11:00:00.000Z'),
    });

    const aliceRows = await consultationsRepository.listConfirmedInRange(
      alice.id,
      RANGE_START,
      RANGE_END
    );
    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0]?.id).toBe(aliceConsult.id);
  });
});
