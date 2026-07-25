import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { availabilityOverrides } from '../schema';
import { expertDraftFactory } from '../test/factories';
import { availabilityOverridesRepository } from './availability-overrides';

/**
 * Today's date as the DB sees it (UTC `CURRENT_DATE`). The integration
 * Postgres container runs in UTC, so the UTC ISO date matches `CURRENT_DATE`.
 */
function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  const [datePart] = d.toISOString().split('T');
  if (datePart === undefined) throw new Error('unreachable');
  return datePart;
}

const TODAY = isoDate(0);

// ── create ──────────────────────────────────────────────────────────

describe('availabilityOverridesRepository.create', () => {
  it('inserts a block and returns the row with the label stored', async () => {
    const draft = await expertDraftFactory();

    const override = await availabilityOverridesRepository.create({
      expertProfileId: draft.id,
      startDate: '2099-01-01',
      endDate: '2099-01-05',
      label: 'Annual leave',
    });

    expect(override.id).toBeTruthy();
    expect(override.expertProfileId).toBe(draft.id);
    expect(override.startDate).toBe('2099-01-01');
    expect(override.endDate).toBe('2099-01-05');
    expect(override.label).toBe('Annual leave');
    expect(override.deletedAt).toBeNull();
  });

  it('stores a null label when none is provided', async () => {
    const draft = await expertDraftFactory();

    const override = await availabilityOverridesRepository.create({
      expertProfileId: draft.id,
      startDate: '2099-02-01',
      endDate: '2099-02-01', // single-day block: start === end
    });

    expect(override.label).toBeNull();
    expect(override.startDate).toBe('2099-02-01');
    expect(override.endDate).toBe('2099-02-01');
  });
});

// ── listUpcoming ────────────────────────────────────────────────────

describe('availabilityOverridesRepository.listUpcoming', () => {
  it('excludes fully-past ranges and includes future ones', async () => {
    const draft = await expertDraftFactory();

    await db.insert(availabilityOverrides).values([
      // Fully elapsed — endDate < CURRENT_DATE.
      { expertProfileId: draft.id, startDate: '2000-01-01', endDate: '2000-01-02' },
      // Future.
      { expertProfileId: draft.id, startDate: '2099-06-01', endDate: '2099-06-03' },
    ]);

    const rows = await availabilityOverridesRepository.listUpcoming(draft.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.startDate).toBe('2099-06-01');
  });

  it('includes a block whose endDate is exactly today', async () => {
    const draft = await expertDraftFactory();

    // endDate === CURRENT_DATE must be inclusive (>= boundary).
    await db.insert(availabilityOverrides).values({
      expertProfileId: draft.id,
      startDate: isoDate(-3),
      endDate: TODAY,
    });

    const rows = await availabilityOverridesRepository.listUpcoming(draft.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.endDate).toBe(TODAY);
  });

  it('orders by startDate ascending', async () => {
    const draft = await expertDraftFactory();

    // Insert jumbled to prove ORDER BY does the work.
    await db.insert(availabilityOverrides).values([
      { expertProfileId: draft.id, startDate: '2099-09-10', endDate: '2099-09-12' },
      { expertProfileId: draft.id, startDate: '2099-07-01', endDate: '2099-07-01' },
      { expertProfileId: draft.id, startDate: '2099-08-15', endDate: '2099-08-20' },
    ]);

    const rows = await availabilityOverridesRepository.listUpcoming(draft.id);

    expect(rows).toHaveLength(3);
    expect(rows[0]?.startDate).toBe('2099-07-01');
    expect(rows[1]?.startDate).toBe('2099-08-15');
    expect(rows[2]?.startDate).toBe('2099-09-10');
  });

  it('excludes soft-deleted blocks', async () => {
    const draft = await expertDraftFactory();

    await db.insert(availabilityOverrides).values([
      { expertProfileId: draft.id, startDate: '2099-03-01', endDate: '2099-03-02' },
      {
        expertProfileId: draft.id,
        startDate: '2099-04-01',
        endDate: '2099-04-02',
        deletedAt: new Date(),
      },
    ]);

    const rows = await availabilityOverridesRepository.listUpcoming(draft.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.startDate).toBe('2099-03-01');
  });

  it('isolates blocks between experts', async () => {
    const alice = await expertDraftFactory();
    const bob = await expertDraftFactory();

    await db.insert(availabilityOverrides).values([
      { expertProfileId: alice.id, startDate: '2099-05-01', endDate: '2099-05-02' },
      { expertProfileId: bob.id, startDate: '2099-05-10', endDate: '2099-05-11' },
    ]);

    const aliceRows = await availabilityOverridesRepository.listUpcoming(alice.id);
    const bobRows = await availabilityOverridesRepository.listUpcoming(bob.id);

    expect(aliceRows).toHaveLength(1);
    expect(aliceRows[0]?.expertProfileId).toBe(alice.id);
    expect(aliceRows[0]?.startDate).toBe('2099-05-01');

    expect(bobRows).toHaveLength(1);
    expect(bobRows[0]?.expertProfileId).toBe(bob.id);
    expect(bobRows[0]?.startDate).toBe('2099-05-10');
  });

  it('includes multi-day and overlapping ranges', async () => {
    const draft = await expertDraftFactory();

    // Two overlapping multi-day ranges — both are valid upcoming blocks; the
    // resolver merges intervals downstream, so duplicates/overlaps are harmless.
    await db.insert(availabilityOverrides).values([
      { expertProfileId: draft.id, startDate: '2099-10-01', endDate: '2099-10-10' },
      { expertProfileId: draft.id, startDate: '2099-10-05', endDate: '2099-10-15' },
    ]);

    const rows = await availabilityOverridesRepository.listUpcoming(draft.id);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.startDate).toBe('2099-10-01');
    expect(rows[0]?.endDate).toBe('2099-10-10');
    expect(rows[1]?.startDate).toBe('2099-10-05');
    expect(rows[1]?.endDate).toBe('2099-10-15');
  });

  it('returns an empty array for an expert with no blocks', async () => {
    const draft = await expertDraftFactory();

    const rows = await availabilityOverridesRepository.listUpcoming(draft.id);

    expect(rows).toEqual([]);
  });
});

// ── softDelete ──────────────────────────────────────────────────────

describe('availabilityOverridesRepository.softDelete', () => {
  it('sets deletedAt, returns true, and removes the row from listUpcoming', async () => {
    const draft = await expertDraftFactory();
    const override = await availabilityOverridesRepository.create({
      expertProfileId: draft.id,
      startDate: '2099-11-01',
      endDate: '2099-11-02',
      label: 'Holiday',
    });

    const result = await availabilityOverridesRepository.softDelete(override.id, draft.id);
    expect(result).toBe(true);

    const [row] = await db
      .select()
      .from(availabilityOverrides)
      .where(eq(availabilityOverrides.id, override.id));
    expect(row?.deletedAt).not.toBeNull();

    const remaining = await availabilityOverridesRepository.listUpcoming(draft.id);
    expect(remaining).toHaveLength(0);
  });

  it('returns false for a mismatched expertProfileId (ownership scoping)', async () => {
    const owner = await expertDraftFactory();
    const attacker = await expertDraftFactory();
    const override = await availabilityOverridesRepository.create({
      expertProfileId: owner.id,
      startDate: '2099-12-01',
      endDate: '2099-12-02',
    });

    const result = await availabilityOverridesRepository.softDelete(override.id, attacker.id);
    expect(result).toBe(false);

    // The row is untouched — still active for its real owner.
    const rows = await availabilityOverridesRepository.listUpcoming(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(override.id);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it('is idempotent — a second delete returns false', async () => {
    const draft = await expertDraftFactory();
    const override = await availabilityOverridesRepository.create({
      expertProfileId: draft.id,
      startDate: '2099-12-20',
      endDate: '2099-12-21',
    });

    const first = await availabilityOverridesRepository.softDelete(override.id, draft.id);
    expect(first).toBe(true);

    const second = await availabilityOverridesRepository.softDelete(override.id, draft.id);
    expect(second).toBe(false);
  });
});
