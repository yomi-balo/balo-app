import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, engagementMilestones, proposalMilestones, type AuditEvent } from '../schema';
import type { ProjectDeliveryStatus } from './_shared/engagement-supertype';
import { EngagementTypeMismatchError } from './_shared/engagement-supertype';
import {
  caseEngagementFactory,
  engagementChangeOrderFactory,
  engagementFactory,
  engagementMilestoneFactory,
  proposalFactory,
  userFactory,
} from '../test/factories';
import {
  engagementMilestonesRepository,
  snapshotFromProposalTx,
  InvalidMilestoneTransitionError,
  EngagementNotActiveError,
  MilestoneReorderMismatchError,
} from './engagement-milestones';
import {
  MilestoneChangePendingError,
  ScopeChangeRequiresChangeOrderError,
} from './_shared/change-order-guards';
import { recordDeliveryAudit } from './_shared/delivery-audit';

/**
 * Read delivery audit rows for one polymorphic entity from main's generic
 * `audit_events` table (BAL-344). That table has NO `engagement_id` column — the
 * engagement id is FOLDED into `metadata.engagementId` by the delivery repos — and
 * is keyed by (`entity_type`, `entity_id`).
 *
 * Ordered by the BAL-426 trail contract — `created_at` then `seq`, both ascending. NEVER `id`:
 * it is `defaultRandom()`, and `created_at` is the TRANSACTION timestamp, so `(created_at, id)`
 * is a coin flip for rows written in one `db.transaction`.
 */
async function auditEventsForEntity(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

/** Seed an active engagement + a milestone in the given status + an acting user. */
async function seedMilestone(
  values: Partial<typeof engagementMilestones.$inferInsert> = {}
): Promise<{
  engagementId: string;
  milestoneId: string;
  userId: string;
}> {
  const { engagement } = await engagementFactory();
  const { milestone } = await engagementMilestoneFactory({
    engagementId: engagement.id,
    values,
  });
  const user = await userFactory();
  return { engagementId: engagement.id, milestoneId: milestone.id, userId: user.id };
}

async function statusOf(milestoneId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: engagementMilestones.status })
    .from(engagementMilestones)
    .where(eq(engagementMilestones.id, milestoneId));
  return row?.status;
}

describe('engagementMilestonesRepository.start', () => {
  it('pending → in_progress stamps started_by/started_at + writes started audit', async () => {
    const { engagementId, milestoneId, userId } = await seedMilestone({ status: 'pending' });

    const updated = await engagementMilestonesRepository.start({ milestoneId, userId });
    expect(updated.status).toBe('in_progress');
    expect(updated.startedByUserId).toBe(userId);
    expect(updated.startedAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(milestoneId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('engagement_milestone.started');
    expect(events[0]?.entityType).toBe('engagement_milestone');
    expect(events[0]?.entityId).toBe(milestoneId);
    // engagementId is folded into metadata (main's table has no engagement_id column).
    expect(events[0]?.metadata).toMatchObject({ from: 'pending', to: 'in_progress', engagementId });
  });
});

describe('engagementMilestonesRepository.complete', () => {
  it('in_progress → completed stamps completed_by/completed_at/completion_note + audit', async () => {
    const { engagementId, milestoneId, userId } = await seedMilestone({ status: 'in_progress' });

    const updated = await engagementMilestonesRepository.complete({
      milestoneId,
      userId,
      completionNote: 'Deployed to prod.',
    });
    expect(updated.status).toBe('completed');
    expect(updated.completedByUserId).toBe(userId);
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.completionNote).toBe('Deployed to prod.');

    const events = await auditEventsForEntity(milestoneId);
    expect(events[0]?.action).toBe('engagement_milestone.completed');
    expect(events[0]?.metadata).toMatchObject({ note: 'Deployed to prod.', engagementId });
  });
});

describe('engagementMilestonesRepository.revert', () => {
  it('completed → in_progress CLEARS completion fields, KEEPS started_*, + audit', async () => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const { engagementId, milestoneId, userId } = await seedMilestone({
      status: 'completed',
      startedByUserId: null,
      startedAt,
      completedAt: new Date(),
      completionNote: 'done',
    });

    const updated = await engagementMilestonesRepository.revert({ milestoneId, userId });
    expect(updated.status).toBe('in_progress');
    expect(updated.completedByUserId).toBeNull();
    expect(updated.completedAt).toBeNull();
    expect(updated.completionNote).toBeNull();
    // started_* preserved.
    expect(updated.startedAt?.getTime()).toBe(startedAt.getTime());

    const events = await auditEventsForEntity(milestoneId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('engagement_milestone.reverted');
    // A plain revert carries no change-request id — only `requestChanges` adds one.
    expect(events[0]?.metadata).toEqual({ from: 'completed', to: 'in_progress', engagementId });
  });
});

describe('engagementMilestonesRepository — illegal transition matrix', () => {
  it('pending → completed throws InvalidMilestoneTransitionError and mutates nothing', async () => {
    const { milestoneId, userId } = await seedMilestone({ status: 'pending' });
    await expect(
      engagementMilestonesRepository.complete({ milestoneId, userId })
    ).rejects.toBeInstanceOf(InvalidMilestoneTransitionError);
    expect(await statusOf(milestoneId)).toBe('pending');
  });

  it('in_progress → in_progress (start) throws and mutates nothing', async () => {
    const { milestoneId, userId } = await seedMilestone({ status: 'in_progress' });
    await expect(
      engagementMilestonesRepository.start({ milestoneId, userId })
    ).rejects.toBeInstanceOf(InvalidMilestoneTransitionError);
    expect(await statusOf(milestoneId)).toBe('in_progress');
  });

  it('completed → completed (complete) throws and mutates nothing', async () => {
    const { milestoneId, userId } = await seedMilestone({ status: 'completed' });
    await expect(
      engagementMilestonesRepository.complete({ milestoneId, userId })
    ).rejects.toBeInstanceOf(InvalidMilestoneTransitionError);
    expect(await statusOf(milestoneId)).toBe('completed');
  });

  // NOTE: `pending → pending` is not reachable — no repository op targets `pending`.
  // `revert` targets `in_progress`, and `pending → in_progress` IS a legal move (the
  // guard is `isAllowed(status,'in_progress')`, shared with `start`), so revert on a
  // pending milestone is intentionally NOT an error.
});

describe('engagementMilestonesRepository — engagement-active guard (EngagementNotActiveError)', () => {
  // ⚠ RE-TYPED, NOT SHORTENED (BAL-417) — see the identical note in
  // `action-items.integration.test.ts`. The `pending_acceptance` arm is the only
  // coverage of `lockActiveEngagement`'s child read.
  const nonActiveStatuses: ProjectDeliveryStatus[] = [
    'pending_acceptance',
    'completed',
    'cancelled',
  ];

  for (const status of nonActiveStatuses) {
    it(`every mutating op throws EngagementNotActiveError when the engagement is ${status}`, async () => {
      const { engagement } = await engagementFactory({
        projectValues: { deliveryStatus: status },
      });
      const { milestone } = await engagementMilestoneFactory({
        engagementId: engagement.id,
        values: { status: 'in_progress' },
      });
      const user = await userFactory();
      const milestoneId = milestone.id;
      const userId = user.id;

      await expect(
        engagementMilestonesRepository.start({ milestoneId, userId })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        engagementMilestonesRepository.complete({ milestoneId, userId })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        engagementMilestonesRepository.revert({ milestoneId, userId })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        engagementMilestonesRepository.editDescriptive({ milestoneId, userId, title: 'x' })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        engagementMilestonesRepository.softDelete({ milestoneId, userId })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        engagementMilestonesRepository.add({ engagementId: engagement.id, userId, title: 'y' })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        engagementMilestonesRepository.reorder({
          engagementId: engagement.id,
          userId,
          orderedMilestoneIds: [milestoneId],
        })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
    });
  }
});

describe('engagementMilestonesRepository.editDescriptive', () => {
  it('updates descriptive fields; leaves valueCents unchanged (immutable, not in signature); audits edited', async () => {
    const { engagementId, milestoneId, userId } = await seedMilestone({
      status: 'pending',
      valueCents: 100_000,
      title: 'Old title',
    });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      title: 'New title',
      descriptionHtml: '<p>updated</p>',
      acceptanceCriteria: 'signed off',
      estimatedMinutes: 480,
    });
    expect(updated.title).toBe('New title');
    expect(updated.descriptionHtml).toBe('<p>updated</p>');
    expect(updated.acceptanceCriteria).toBe('signed off');
    expect(updated.estimatedMinutes).toBe(480);
    // valueCents is NOT an accepted key → unchanged.
    expect(updated.valueCents).toBe(100_000);
    expect(updated.status).toBe('pending'); // no status change

    const events = await auditEventsForEntity(milestoneId);
    expect(events[0]?.action).toBe('engagement_milestone.edited');
    expect(events[0]?.metadata).toMatchObject({
      fields: ['title', 'descriptionHtml', 'acceptanceCriteria', 'estimatedMinutes'],
      engagementId,
    });
  });
});

describe('engagementMilestonesRepository.add', () => {
  it('inserts a pending milestone with created_by=userId, source=null, sort_order = max+1 when omitted; audits added', async () => {
    const { engagement } = await engagementFactory();
    await engagementMilestoneFactory({ engagementId: engagement.id, values: { sortOrder: 0 } });
    await engagementMilestoneFactory({ engagementId: engagement.id, values: { sortOrder: 5 } });
    const user = await userFactory();

    const added = await engagementMilestonesRepository.add({
      engagementId: engagement.id,
      userId: user.id,
      title: 'Expert-added deliverable',
      estimatedMinutes: 120,
    });
    expect(added.status).toBe('pending');
    expect(added.createdByUserId).toBe(user.id);
    expect(added.sourceProposalMilestoneId).toBeNull();
    expect(added.sortOrder).toBe(6); // max(0,5) + 1
    expect(added.estimatedMinutes).toBe(120);

    const events = await auditEventsForEntity(added.id);
    expect(events[0]?.action).toBe('engagement_milestone.added');
    expect(events[0]?.metadata).toMatchObject({ sort_order: 6, engagementId: engagement.id });
  });

  it('uses sort_order 0 for the first milestone of an engagement', async () => {
    const { engagement } = await engagementFactory();
    const user = await userFactory();
    const added = await engagementMilestonesRepository.add({
      engagementId: engagement.id,
      userId: user.id,
      title: 'First',
    });
    expect(added.sortOrder).toBe(0);
  });

  it('throws Error for a missing engagement', async () => {
    const user = await userFactory();
    await expect(
      engagementMilestonesRepository.add({
        engagementId: randomUUID(),
        userId: user.id,
        title: 'x',
      })
    ).rejects.toThrow(/Engagement not found/);
  });
});

describe('engagementMilestonesRepository.softDelete', () => {
  it('sets deleted_at, hides from listByEngagement, audits removed', async () => {
    const { engagementId, milestoneId, userId } = await seedMilestone({ status: 'pending' });

    const removed = await engagementMilestonesRepository.softDelete({ milestoneId, userId });
    expect(removed.deletedAt).toBeInstanceOf(Date);

    const live = await engagementMilestonesRepository.listByEngagement(engagementId);
    expect(live.map((m) => m.id)).not.toContain(milestoneId);

    const events = await auditEventsForEntity(milestoneId);
    expect(events[0]?.action).toBe('engagement_milestone.removed');
    expect(events[0]?.metadata).toMatchObject({ engagementId });
  });

  it('permits removing a COMPLETED milestone under an active engagement (D0 policy)', async () => {
    const { milestoneId, userId } = await seedMilestone({ status: 'completed' });
    const removed = await engagementMilestonesRepository.softDelete({ milestoneId, userId });
    expect(removed.deletedAt).toBeInstanceOf(Date);
  });
});

describe('engagementMilestonesRepository.reorder', () => {
  /** Seed an active engagement + three live milestones (A/B/C) + an acting user. */
  async function seedThree(): Promise<{
    engagementId: string;
    userId: string;
    a: string;
    b: string;
    c: string;
  }> {
    const { engagement } = await engagementFactory();
    const { milestone: mA } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'A', sortOrder: 0 },
    });
    const { milestone: mB } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'B', sortOrder: 1 },
    });
    const { milestone: mC } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'C', sortOrder: 2, status: 'completed', completedAt: new Date() },
    });
    const user = await userFactory();
    return { engagementId: engagement.id, userId: user.id, a: mA.id, b: mB.id, c: mC.id };
  }

  it('rewrites sort_order to 0..n-1 in the given order and returns the new live order', async () => {
    const { engagementId, userId, a, b, c } = await seedThree();

    const result = await engagementMilestonesRepository.reorder({
      engagementId,
      userId,
      orderedMilestoneIds: [c, a, b],
    });
    expect(result.map((m) => m.id)).toEqual([c, a, b]);
    expect(result.map((m) => m.sortOrder)).toEqual([0, 1, 2]);

    const live = await engagementMilestonesRepository.listByEngagement(engagementId);
    expect(live.map((m) => m.id)).toEqual([c, a, b]);
  });

  it('is NOT a REPLACE-ALL: a completed milestone keeps status/completedAt/valueCents/completionNote', async () => {
    const { engagement } = await engagementFactory();
    const completedAt = new Date('2026-06-30T00:00:00.000Z');
    const { milestone: mDone } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: {
        title: 'Done',
        sortOrder: 0,
        status: 'completed',
        completedAt,
        completionNote: 'shipped',
        valueCents: 250_000,
      },
    });
    const { milestone: mNext } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'Next', sortOrder: 1 },
    });
    const user = await userFactory();

    await engagementMilestonesRepository.reorder({
      engagementId: engagement.id,
      userId: user.id,
      orderedMilestoneIds: [mNext.id, mDone.id],
    });

    const [done] = await db
      .select()
      .from(engagementMilestones)
      .where(eq(engagementMilestones.id, mDone.id));
    expect(done?.status).toBe('completed');
    expect(done?.completedAt?.getTime()).toBe(completedAt.getTime());
    expect(done?.completionNote).toBe('shipped');
    expect(done?.valueCents).toBe(250_000);
    expect(done?.sortOrder).toBe(1); // moved to the end
  });

  it('audits engagement_milestone.reordered engagement-scoped with metadata { order, engagementId }', async () => {
    const { engagementId, userId, a, b, c } = await seedThree();
    const order = [b, c, a];

    await engagementMilestonesRepository.reorder({
      engagementId,
      userId,
      orderedMilestoneIds: order,
    });

    const events = await auditEventsForEntity(engagementId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('engagement_milestone.reordered');
    expect(events[0]?.entityType).toBe('engagement');
    expect(events[0]?.entityId).toBe(engagementId);
    expect(events[0]?.metadata).toMatchObject({ order, engagementId });
  });

  it('throws MilestoneReorderMismatchError when the list OMITS a live id', async () => {
    const { engagementId, userId, a, b } = await seedThree();
    await expect(
      engagementMilestonesRepository.reorder({ engagementId, userId, orderedMilestoneIds: [a, b] })
    ).rejects.toBeInstanceOf(MilestoneReorderMismatchError);
  });

  it('throws MilestoneReorderMismatchError when the list includes a FOREIGN id', async () => {
    const { engagementId, userId, a, b, c } = await seedThree();
    await expect(
      engagementMilestonesRepository.reorder({
        engagementId,
        userId,
        orderedMilestoneIds: [a, b, c, randomUUID()],
      })
    ).rejects.toBeInstanceOf(MilestoneReorderMismatchError);
  });

  it('throws MilestoneReorderMismatchError when the list contains a DUPLICATE id', async () => {
    const { engagementId, userId, a, b } = await seedThree();
    await expect(
      engagementMilestonesRepository.reorder({
        engagementId,
        userId,
        orderedMilestoneIds: [a, b, a],
      })
    ).rejects.toBeInstanceOf(MilestoneReorderMismatchError);
  });

  it('excludes soft-deleted rows from the live set (a deleted id in the list → mismatch)', async () => {
    const { engagement } = await engagementFactory();
    const { milestone: mLive } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'Live', sortOrder: 0 },
    });
    const { milestone: mDeleted } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'Deleted', sortOrder: 1, deletedAt: new Date() },
    });
    const user = await userFactory();

    // The deleted row is NOT part of the live set, so a list of just [live] is a valid
    // permutation, but a list including the deleted id is a mismatch.
    await expect(
      engagementMilestonesRepository.reorder({
        engagementId: engagement.id,
        userId: user.id,
        orderedMilestoneIds: [mLive.id, mDeleted.id],
      })
    ).rejects.toBeInstanceOf(MilestoneReorderMismatchError);

    const okResult = await engagementMilestonesRepository.reorder({
      engagementId: engagement.id,
      userId: user.id,
      orderedMilestoneIds: [mLive.id],
    });
    expect(okResult.map((m) => m.id)).toEqual([mLive.id]);
  });
});

describe('engagementMilestonesRepository.listByEngagement', () => {
  it('returns live milestones only, ordered by sort_order asc then id asc', async () => {
    const { engagement } = await engagementFactory();
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'C', sortOrder: 2 },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'A', sortOrder: 0 },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'B', sortOrder: 1 },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { title: 'Deleted', sortOrder: 3, deletedAt: new Date() },
    });

    const list = await engagementMilestonesRepository.listByEngagement(engagement.id);
    expect(list.map((m) => m.title)).toEqual(['A', 'B', 'C']);
  });

  it('throws Error for a missing milestone (start on unknown id)', async () => {
    const user = await userFactory();
    await expect(
      engagementMilestonesRepository.start({ milestoneId: randomUUID(), userId: user.id })
    ).rejects.toThrow(/Milestone not found/);
  });
});

describe('snapshotFromProposalTx', () => {
  it('N proposal milestones → N engagement milestones (provenance + fields copied, status pending, created_by=admin, order preserved)', async () => {
    const source = await proposalFactory();
    await db.insert(proposalMilestones).values([
      {
        proposalId: source.proposal.id,
        sortOrder: 0,
        title: 'Discovery',
        descriptionHtml: '<p>discovery</p>',
        acceptanceCriteria: 'kickoff done',
        valueCents: 120_000,
      },
      {
        proposalId: source.proposal.id,
        sortOrder: 1,
        title: 'Build',
        descriptionHtml: '<p>build</p>',
        acceptanceCriteria: 'shipped',
        valueCents: 380_000,
      },
    ]);
    const sources = await db
      .select()
      .from(proposalMilestones)
      .where(eq(proposalMilestones.proposalId, source.proposal.id))
      .orderBy(proposalMilestones.sortOrder);

    const { engagement } = await engagementFactory();
    const admin = await userFactory({ platformRole: 'admin' });

    const inserted = await db.transaction((tx) =>
      snapshotFromProposalTx(tx, {
        engagementId: engagement.id,
        approvingAdminUserId: admin.id,
        sources,
      })
    );
    expect(inserted).toHaveLength(2);

    const live = await engagementMilestonesRepository.listByEngagement(engagement.id);
    expect(live.map((m) => m.title)).toEqual(['Discovery', 'Build']); // order preserved
    live.forEach((m, i) => {
      const src = sources[i];
      expect(src).toBeDefined();
      expect(m.sourceProposalMilestoneId).toBe(src?.id);
      expect(m.descriptionHtml).toBe(src?.descriptionHtml);
      expect(m.acceptanceCriteria).toBe(src?.acceptanceCriteria);
      expect(m.valueCents).toBe(src?.valueCents);
      expect(m.sortOrder).toBe(src?.sortOrder);
      expect(m.status).toBe('pending');
      expect(m.createdByUserId).toBe(admin.id);
    });
  });

  it('empty sources → [] (zero rows), a legal zero-milestone snapshot', async () => {
    const { engagement } = await engagementFactory();
    const admin = await userFactory({ platformRole: 'admin' });
    const inserted = await db.transaction((tx) =>
      snapshotFromProposalTx(tx, {
        engagementId: engagement.id,
        approvingAdminUserId: admin.id,
        sources: [],
      })
    );
    expect(inserted).toEqual([]);
    expect(await engagementMilestonesRepository.listByEngagement(engagement.id)).toHaveLength(0);
  });
});

describe('engagementMilestonesRepository — the CASE widening is BLOCKED (BAL-417 / R4)', () => {
  it('add / reorder against a `case` engagement throw EngagementTypeMismatchError', async () => {
    // A Case is NOT milestone-shaped, and `aggregateMilestoneProgress` must never count
    // Case milestones — so unlike `action_items` / `transcripts` (whose widening IS
    // intended), every milestone writer passes `{ requireType: 'project' }`. Without
    // it a live Case, being `'active'` on the parent, would sail straight through.
    const { engagement } = await caseEngagementFactory();
    const user = await userFactory();

    await expect(
      engagementMilestonesRepository.add({
        engagementId: engagement.id,
        userId: user.id,
        title: 'Should never exist',
      })
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);

    await expect(
      engagementMilestonesRepository.reorder({
        engagementId: engagement.id,
        userId: user.id,
        orderedMilestoneIds: [],
      })
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);
  });

  it('start / complete against a milestone hanging off a `case` engagement throw EngagementTypeMismatchError', async () => {
    // `add`/`reorder` cover only TWO of the three `lockActiveEngagement` call sites.
    // The third — inside `lockEngagementAndMilestone` — is the one behind start /
    // complete / revert / editDescriptive / softDelete (five of the seven writers), and
    // it takes a MILESTONE id, so a case-id probe has to route through a seeded
    // milestone.
    //
    // ⚠ `engagement_milestones.engagement_id` FKs the SUPERTYPE, so a milestone CAN be
    // hung off a case out of band — nothing at the DB level forbids it. That is exactly
    // why the repository guard has to hold: it is the only thing standing between a Case
    // and the project-shaped milestone lifecycle.
    const { engagement } = await caseEngagementFactory();
    const user = await userFactory();
    const { milestone } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'pending' },
    });

    await expect(
      engagementMilestonesRepository.start({ milestoneId: milestone.id, userId: user.id })
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);

    const { milestone: inProgress } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'in_progress', sortOrder: 1, startedAt: new Date() },
    });
    await expect(
      engagementMilestonesRepository.complete({ milestoneId: inProgress.id, userId: user.id })
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);

    // The guard fires BEFORE any write — both milestones are untouched.
    const rows = await db
      .select()
      .from(engagementMilestones)
      .where(eq(engagementMilestones.engagementId, engagement.id));
    expect(rows.map((r) => r.status).sort()).toEqual(['in_progress', 'pending']);
    expect(rows.every((r) => r.completedAt === null)).toBe(true);
    expect(rows.every((r) => r.startedByUserId === null)).toBe(true);
  });
});

describe('engagementMilestonesRepository — milestones locked by a sent change order', () => {
  /** A sent order with an edit line on `locked` and a remove line on `removing`. */
  async function seedLocked(status: 'sent' | 'draft' = 'sent'): Promise<{
    lockedId: string;
    removingId: string;
    freeId: string;
    userId: string;
  }> {
    const { engagement } = await engagementFactory();
    const { milestone: locked } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { sortOrder: 0, title: 'Locked' },
    });
    const { milestone: removing } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { sortOrder: 1, title: 'Removing', status: 'in_progress' },
    });
    const { milestone: free } = await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { sortOrder: 2, title: 'Free' },
    });
    await engagementChangeOrderFactory({
      engagementId: engagement.id,
      status,
      lines: [
        { op: 'edit', engagementMilestoneId: locked.id, title: 'Locked v2' },
        { op: 'remove', engagementMilestoneId: removing.id, title: 'Removing' },
        { op: 'edit', engagementMilestoneId: free.id, title: 'gone', deletedAt: new Date() },
      ],
    });
    const user = await userFactory();
    return { lockedId: locked.id, removingId: removing.id, freeId: free.id, userId: user.id };
  }

  it('refuses a plain edit or removal of a targeted milestone, and writes nothing', async () => {
    const { lockedId, removingId, userId } = await seedLocked();

    await expect(
      engagementMilestonesRepository.editDescriptive({ milestoneId: lockedId, userId, title: 'x' })
    ).rejects.toBeInstanceOf(MilestoneChangePendingError);
    await expect(
      engagementMilestonesRepository.softDelete({ milestoneId: removingId, userId })
    ).rejects.toBeInstanceOf(MilestoneChangePendingError);

    const [locked] = await db
      .select()
      .from(engagementMilestones)
      .where(eq(engagementMilestones.id, lockedId));
    expect(locked?.title).toBe('Locked');
    expect(await auditEventsForEntity(lockedId)).toHaveLength(0);
  });

  it('still lets delivery move: start and complete a targeted milestone', async () => {
    const { lockedId, removingId, userId } = await seedLocked();

    const started = await engagementMilestonesRepository.start({ milestoneId: lockedId, userId });
    const completed = await engagementMilestonesRepository.complete({
      milestoneId: removingId,
      userId,
    });

    expect(started.status).toBe('in_progress');
    expect(completed.status).toBe('completed');
  });

  it('does not lock a milestone targeted only by a soft-deleted line or by a draft', async () => {
    const sent = await seedLocked();
    const edited = await engagementMilestonesRepository.editDescriptive({
      milestoneId: sent.freeId,
      userId: sent.userId,
      title: 'Free v2',
    });
    expect(edited.title).toBe('Free v2');

    const draft = await seedLocked('draft');
    const removed = await engagementMilestonesRepository.softDelete({
      milestoneId: draft.removingId,
      userId: draft.userId,
    });
    expect(removed.deletedAt).toBeInstanceOf(Date);
  });
});

// ── Scope guards and "changed since the proposal" (BAL-623) ─────────────────

const TM_TERMS = {
  pricingMethod: 'tm',
  priceCents: 900_000,
  rateCents: 20_000,
  cadence: 'monthly',
} as const;

/** A live proposal milestone to point `source_proposal_milestone_id` at. */
async function seedProposalMilestoneId(): Promise<string> {
  const source = await proposalFactory();
  const [row] = await db
    .insert(proposalMilestones)
    .values({ proposalId: source.proposal.id, sortOrder: 0, title: 'From the proposal' })
    .returning({ id: proposalMilestones.id });
  if (row === undefined) throw new Error('proposal milestone insert failed');
  return row.id;
}

/** An active project on `pricing` with one milestone carrying `values`, and an acting user. */
async function seedOn(
  pricing: 'fixed' | 'tm',
  values: Partial<typeof engagementMilestones.$inferInsert> = {}
): Promise<{ engagementId: string; milestoneId: string; userId: string }> {
  const { engagement } = await engagementFactory(
    pricing === 'tm' ? { projectValues: TM_TERMS } : {}
  );
  const { milestone } = await engagementMilestoneFactory({ engagementId: engagement.id, values });
  const user = await userFactory();
  return { engagementId: engagement.id, milestoneId: milestone.id, userId: user.id };
}

type EngagementMilestoneRow = typeof engagementMilestones.$inferSelect;

async function milestoneRow(milestoneId: string): Promise<EngagementMilestoneRow | undefined> {
  const [row] = await db
    .select()
    .from(engagementMilestones)
    .where(eq(engagementMilestones.id, milestoneId));
  return row;
}

async function expectScopeRefusal(
  promise: Promise<unknown>,
  expected: Pick<ScopeChangeRequiresChangeOrderError, 'reason' | 'pricingMethod' | 'milestoneId'>
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ScopeChangeRequiresChangeOrderError);
  expect(error).toMatchObject(expected);
}

describe('engagementMilestonesRepository.editDescriptive — the T&M estimate guard', () => {
  it('refuses a different estimate on T&M and writes nothing', async () => {
    const { milestoneId, userId } = await seedOn('tm', { estimatedMinutes: 600, title: 'Build' });

    await expectScopeRefusal(
      engagementMilestonesRepository.editDescriptive({
        milestoneId,
        userId,
        title: 'Build v2',
        estimatedMinutes: 900,
      }),
      { reason: 'estimate_change', pricingMethod: 'tm', milestoneId }
    );

    const row = await milestoneRow(milestoneId);
    expect(row?.estimatedMinutes).toBe(600);
    expect(row?.title).toBe('Build');
    expect(await auditEventsForEntity(milestoneId)).toHaveLength(0);
  });

  it('accepts the same estimate re-sent on T&M alongside a wording change', async () => {
    const { milestoneId, userId } = await seedOn('tm', { estimatedMinutes: 600, title: 'Build' });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      title: 'Build v2',
      estimatedMinutes: 600,
    });

    expect(updated.title).toBe('Build v2');
    expect(updated.estimatedMinutes).toBe(600);
    const [event] = await auditEventsForEntity(milestoneId);
    expect(event?.metadata).toMatchObject({
      fields: ['title', 'estimatedMinutes'],
      before: { title: 'Build' },
    });
    expect(event?.metadata?.before).not.toHaveProperty('estimatedMinutes');
  });

  it('lets a fixed-price estimate change through, without stamping a proposal-origin milestone', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { milestoneId, userId } = await seedOn('fixed', {
      sourceProposalMilestoneId,
      estimatedMinutes: 600,
    });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      estimatedMinutes: 900,
    });

    expect(updated.estimatedMinutes).toBe(900);
    expect(updated.contentEditedAt).toBeNull();
    const [event] = await auditEventsForEntity(milestoneId);
    expect(event?.metadata).toMatchObject({ before: { estimatedMinutes: 600 } });
  });

  it('a pending sent change wins over the scope guard', async () => {
    const { engagementId, milestoneId, userId } = await seedOn('tm', { estimatedMinutes: 600 });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'sent',
      lines: [{ op: 'edit', engagementMilestoneId: milestoneId, title: 'Next' }],
    });

    await expect(
      engagementMilestonesRepository.editDescriptive({ milestoneId, userId, estimatedMinutes: 1 })
    ).rejects.toBeInstanceOf(MilestoneChangePendingError);
  });
});

describe('engagementMilestonesRepository.editDescriptive — marking proposal wording edits', () => {
  it('stamps content_edited_at on a proposal-origin title edit and audits the old title', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { milestoneId, userId } = await seedOn('fixed', {
      sourceProposalMilestoneId,
      title: 'Discovery',
      descriptionHtml: '<p>Map it</p>',
    });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      title: 'Discovery and design',
      descriptionHtml: '<p>Map it</p>',
    });

    expect(updated.contentEditedAt).toBeInstanceOf(Date);
    const [event] = await auditEventsForEntity(milestoneId);
    expect(event?.metadata).toMatchObject({
      fields: ['title', 'descriptionHtml'],
      before: { title: 'Discovery' },
    });
    expect(event?.metadata?.before).toEqual({ title: 'Discovery' });
  });

  it('stamps on a description or acceptance-criteria change, recording a null prior value', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { milestoneId, userId } = await seedOn('fixed', {
      sourceProposalMilestoneId,
      acceptanceCriteria: null,
    });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      acceptanceCriteria: 'Signed off by the client',
    });

    expect(updated.contentEditedAt).toBeInstanceOf(Date);
    const [event] = await auditEventsForEntity(milestoneId);
    expect(event?.metadata?.before).toEqual({ acceptanceCriteria: null });
  });

  it('records before on an expert-added milestone but never stamps it', async () => {
    const { milestoneId, userId } = await seedOn('fixed', { title: 'Expert added' });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      title: 'Expert added v2',
    });

    expect(updated.contentEditedAt).toBeNull();
    const [event] = await auditEventsForEntity(milestoneId);
    expect(event?.metadata?.before).toEqual({ title: 'Expert added' });
  });

  it('an edit that changes nothing records no before and stamps nothing', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { milestoneId, userId } = await seedOn('fixed', {
      sourceProposalMilestoneId,
      title: 'Discovery',
    });

    const updated = await engagementMilestonesRepository.editDescriptive({
      milestoneId,
      userId,
      title: 'Discovery',
    });

    expect(updated.contentEditedAt).toBeNull();
    const [event] = await auditEventsForEntity(milestoneId);
    expect(event?.metadata).not.toHaveProperty('before');
  });
});

describe('engagementMilestonesRepository.add — the T&M guard', () => {
  it('refuses an add on T&M and inserts nothing', async () => {
    const { engagement } = await engagementFactory({ projectValues: TM_TERMS });
    const user = await userFactory();

    await expectScopeRefusal(
      engagementMilestonesRepository.add({
        engagementId: engagement.id,
        userId: user.id,
        title: 'Data migration',
      }),
      { reason: 'add_on_tm', pricingMethod: 'tm', milestoneId: null }
    );

    expect(await engagementMilestonesRepository.listByEngagement(engagement.id)).toHaveLength(0);
  });

  it('adds on a fixed price', async () => {
    const { engagement } = await engagementFactory({ projectValues: { pricingMethod: 'fixed' } });
    const user = await userFactory();

    const added = await engagementMilestonesRepository.add({
      engagementId: engagement.id,
      userId: user.id,
      title: 'Data migration',
    });

    expect(added.valueCents).toBeNull();
  });
});

describe('engagementMilestonesRepository.softDelete — contracted scope on a fixed price', () => {
  async function expectRemoveRefused(milestoneId: string, userId: string): Promise<void> {
    await expectScopeRefusal(engagementMilestonesRepository.softDelete({ milestoneId, userId }), {
      reason: 'remove_contracted',
      pricingMethod: 'fixed',
      milestoneId,
    });
    expect((await milestoneRow(milestoneId))?.deletedAt).toBeNull();
    expect(await auditEventsForEntity(milestoneId)).toHaveLength(0);
  }

  it('refuses a proposal-origin milestone', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { milestoneId, userId } = await seedOn('fixed', { sourceProposalMilestoneId });
    await expectRemoveRefused(milestoneId, userId);
  });

  it('refuses a milestone carrying a value', async () => {
    const { milestoneId, userId } = await seedOn('fixed', { valueCents: 0 });
    await expectRemoveRefused(milestoneId, userId);
  });

  it('refuses a milestone an approved change order added', async () => {
    const { engagementId, milestoneId, userId } = await seedOn('fixed');
    await engagementChangeOrderFactory({
      engagementId,
      status: 'approved',
      lines: [{ op: 'add', engagementMilestoneId: milestoneId, title: 'Discovery & design' }],
    });
    await expectRemoveRefused(milestoneId, userId);
  });

  it('removes an expert-added milestone, including one a declined order or a deleted line named', async () => {
    const { engagementId, milestoneId, userId } = await seedOn('fixed');
    await engagementChangeOrderFactory({
      engagementId,
      status: 'declined',
      lines: [{ op: 'add', engagementMilestoneId: milestoneId, title: 'Discovery & design' }],
    });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'approved',
      lines: [
        {
          op: 'add',
          engagementMilestoneId: milestoneId,
          title: 'Discovery & design',
          deletedAt: new Date(),
        },
      ],
    });

    const removed = await engagementMilestonesRepository.softDelete({ milestoneId, userId });
    expect(removed.deletedAt).toBeInstanceOf(Date);
  });

  it('removes a proposal-origin milestone on T&M', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { milestoneId, userId } = await seedOn('tm', { sourceProposalMilestoneId });

    const removed = await engagementMilestonesRepository.softDelete({ milestoneId, userId });
    expect(removed.deletedAt).toBeInstanceOf(Date);
  });

  it('a pending sent change wins over the scope guard', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { engagementId, milestoneId, userId } = await seedOn('fixed', {
      sourceProposalMilestoneId,
    });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'sent',
      lines: [{ op: 'remove', engagementMilestoneId: milestoneId, title: 'Discovery & design' }],
    });

    await expect(
      engagementMilestonesRepository.softDelete({ milestoneId, userId })
    ).rejects.toBeInstanceOf(MilestoneChangePendingError);
  });
});

describe('engagementMilestonesRepository.listProposalContentEdits', () => {
  it('returns [] for no ids', async () => {
    expect(await engagementMilestonesRepository.listProposalContentEdits([])).toEqual([]);
  });

  it('returns direct and change-order edit rows in trail order, leaving out edits with neither', async () => {
    const sourceProposalMilestoneId = await seedProposalMilestoneId();
    const { engagementId, milestoneId, userId } = await seedOn('fixed', {
      sourceProposalMilestoneId,
      title: 'Discovery',
    });
    const { milestoneId: otherId } = await seedOn('fixed', { title: 'Other' });

    await engagementMilestonesRepository.editDescriptive({ milestoneId, userId, title: 'D2' });
    await engagementMilestonesRepository.editDescriptive({ milestoneId, userId, title: 'D2' });
    await db.transaction((tx) =>
      recordDeliveryAudit(tx, {
        actorUserId: userId,
        action: 'engagement_milestone.edited',
        entityType: 'engagement_milestone',
        entityId: milestoneId,
        engagementId,
        metadata: { changeOrderId: randomUUID() },
      })
    );
    await engagementMilestonesRepository.editDescriptive({ milestoneId, userId, title: 'D3' });
    await engagementMilestonesRepository.editDescriptive({
      milestoneId: otherId,
      userId,
      title: 'Other v2',
    });
    await engagementMilestonesRepository.start({ milestoneId, userId });

    const rows = await engagementMilestonesRepository.listProposalContentEdits([milestoneId]);

    expect(rows).toEqual([
      { milestoneId, kind: 'direct', before: { title: 'Discovery' } },
      { milestoneId, kind: 'change_order', before: {} },
      { milestoneId, kind: 'direct', before: { title: 'D2' } },
    ]);
  });

  it('drops a before key of the wrong type', async () => {
    const { engagementId, milestoneId, userId } = await seedOn('fixed');
    await db.transaction((tx) =>
      recordDeliveryAudit(tx, {
        actorUserId: userId,
        action: 'engagement_milestone.edited',
        entityType: 'engagement_milestone',
        entityId: milestoneId,
        engagementId,
        metadata: {
          fields: ['title', 'estimatedMinutes'],
          before: { title: 42, descriptionHtml: null, estimatedMinutes: 'ten' },
        },
      })
    );

    expect(await engagementMilestonesRepository.listProposalContentEdits([milestoneId])).toEqual([
      { milestoneId, kind: 'direct', before: { descriptionHtml: null } },
    ]);
  });
});
