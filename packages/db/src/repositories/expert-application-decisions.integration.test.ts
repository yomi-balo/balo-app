import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { expertApplicationDecisions } from '../schema';
import { expertDraftFactory, userFactory } from '../test/factories';
import { expertApplicationDecisionsRepository } from './expert-application-decisions';

const NOTE = 'Staff-only: needs delivery lead depth.';

describe('expertApplicationDecisionsRepository.archiveTx', () => {
  it('appends one row on the caller transaction and returns its id', async () => {
    const draft = await expertDraftFactory();
    const staff = await userFactory({ platformRole: 'admin' });
    const decidedAt = new Date('2026-08-01T10:00:00.000Z');
    const submittedAt = new Date('2026-07-25T10:00:00.000Z');

    const archived = await db.transaction((tx) =>
      expertApplicationDecisionsRepository.archiveTx(tx, {
        expertProfileId: draft.id,
        decision: 'declined',
        decidedAt,
        decidedByUserId: staff.id,
        declineReason: 'not_a_fit',
        declineNote: NOTE,
        submittedAt,
      })
    );

    const rows = await db
      .select()
      .from(expertApplicationDecisions)
      .where(eq(expertApplicationDecisions.expertProfileId, draft.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: archived.id,
      decision: 'declined',
      decidedAt,
      decidedByUserId: staff.id,
      declineReason: 'not_a_fit',
      declineNote: NOTE,
      submittedAt,
      deletedAt: null,
    });
  });

  it('archives a legacy decline whose floor columns are all NULL', async () => {
    const draft = await expertDraftFactory();

    const archived = await expertApplicationDecisionsRepository.archiveTx(db, {
      expertProfileId: draft.id,
      decision: 'declined',
      decidedAt: null,
      decidedByUserId: null,
      declineReason: null,
      declineNote: null,
      submittedAt: null,
    });

    const [row] = await expertApplicationDecisionsRepository.listForStaffReview(draft.id);
    expect(row).toMatchObject({
      id: archived.id,
      decidedAt: null,
      decidedByUserId: null,
      declineReason: null,
      declineNote: null,
      submittedAt: null,
    });
  });
});

describe('expertApplicationDecisionsRepository.listForStaffReview', () => {
  it('returns live rows newest first, with the staff-only note, and never another profile', async () => {
    const draft = await expertDraftFactory();
    const other = await expertDraftFactory();
    const base = {
      decision: 'declined' as const,
      decidedAt: null,
      decidedByUserId: null,
      declineReason: 'experience_depth' as const,
      submittedAt: null,
    };
    const older = await expertApplicationDecisionsRepository.archiveTx(db, {
      ...base,
      expertProfileId: draft.id,
      declineNote: 'first',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = await expertApplicationDecisionsRepository.archiveTx(db, {
      ...base,
      expertProfileId: draft.id,
      declineNote: 'second',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });
    const deleted = await expertApplicationDecisionsRepository.archiveTx(db, {
      ...base,
      expertProfileId: draft.id,
      declineNote: 'deleted',
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    await db
      .update(expertApplicationDecisions)
      .set({ deletedAt: new Date() })
      .where(eq(expertApplicationDecisions.id, deleted.id));
    await expertApplicationDecisionsRepository.archiveTx(db, {
      ...base,
      expertProfileId: other.id,
      declineNote: 'other profile',
    });

    const rows = await expertApplicationDecisionsRepository.listForStaffReview(draft.id);

    expect(rows.map((r) => [r.id, r.declineNote])).toEqual([
      [newer.id, 'second'],
      [older.id, 'first'],
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'createdAt',
        'decidedAt',
        'decidedByUserId',
        'decision',
        'declineNote',
        'declineReason',
        'id',
        'submittedAt',
      ].sort()
    );
  });

  it('returns [] for an application with no archived decision', async () => {
    const draft = await expertDraftFactory();

    await expect(
      expertApplicationDecisionsRepository.listForStaffReview(draft.id)
    ).resolves.toEqual([]);
  });
});

describe('expertApplicationDecisionsRepository.existsForProfileTx', () => {
  it('is false with no row, true with a live row, false again once it is soft-deleted', async () => {
    const draft = await expertDraftFactory();
    expect(await expertApplicationDecisionsRepository.existsForProfileTx(db, draft.id)).toBe(false);

    const archived = await expertApplicationDecisionsRepository.archiveTx(db, {
      expertProfileId: draft.id,
      decision: 'declined',
    });
    expect(await expertApplicationDecisionsRepository.existsForProfileTx(db, draft.id)).toBe(true);

    await db
      .update(expertApplicationDecisions)
      .set({ deletedAt: new Date() })
      .where(eq(expertApplicationDecisions.id, archived.id));
    expect(await expertApplicationDecisionsRepository.existsForProfileTx(db, draft.id)).toBe(false);
  });
});
