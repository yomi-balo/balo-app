import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { engagementMilestones, proposalMilestones } from '../schema';
import type { EngagementStatus } from './engagements';
import {
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
} from './engagement-milestones';
import { auditEventsRepository } from './audit-events';

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

    const events = await auditEventsRepository.listByEngagement(engagementId);
    expect(events.at(-1)?.action).toBe('engagement_milestone.started');
    expect(events.at(-1)?.entityId).toBe(milestoneId);
    expect(events.at(-1)?.metadata).toMatchObject({ from: 'pending', to: 'in_progress' });
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

    const events = await auditEventsRepository.listByEngagement(engagementId);
    expect(events.at(-1)?.action).toBe('engagement_milestone.completed');
    expect(events.at(-1)?.metadata).toMatchObject({ note: 'Deployed to prod.' });
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

    const events = await auditEventsRepository.listByEngagement(engagementId);
    expect(events.at(-1)?.action).toBe('engagement_milestone.reverted');
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
  const nonActiveStatuses: EngagementStatus[] = ['pending_acceptance', 'completed', 'cancelled'];

  for (const status of nonActiveStatuses) {
    it(`every mutating op throws EngagementNotActiveError when the engagement is ${status}`, async () => {
      const { engagement } = await engagementFactory({ values: { status } });
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

    const events = await auditEventsRepository.listByEngagement(engagementId);
    expect(events.at(-1)?.action).toBe('engagement_milestone.edited');
    expect(events.at(-1)?.metadata).toMatchObject({
      fields: ['title', 'descriptionHtml', 'acceptanceCriteria', 'estimatedMinutes'],
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

    const events = await auditEventsRepository.listByEngagement(engagement.id);
    expect(events.at(-1)?.action).toBe('engagement_milestone.added');
    expect(events.at(-1)?.metadata).toMatchObject({ sort_order: 6 });
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

    const events = await auditEventsRepository.listByEngagement(engagementId);
    expect(events.at(-1)?.action).toBe('engagement_milestone.removed');
  });

  it('permits removing a COMPLETED milestone under an active engagement (D0 policy)', async () => {
    const { milestoneId, userId } = await seedMilestone({ status: 'completed' });
    const removed = await engagementMilestonesRepository.softDelete({ milestoneId, userId });
    expect(removed.deletedAt).toBeInstanceOf(Date);
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
