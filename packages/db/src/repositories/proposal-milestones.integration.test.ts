import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { proposalMilestones } from '../schema';
import { proposalFactory } from '../test/factories';
import { proposalMilestonesRepository } from './proposal-milestones';

describe('proposalMilestonesRepository.setForProposal', () => {
  it('inserts an ordered set with sortOrder 0..n-1 and honours nullable valueCents', async () => {
    const { proposal } = await proposalFactory();

    const rows = await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [
        { title: 'Discovery', valueCents: 100000 },
        {
          title: 'Build',
          descriptionHtml: '<p>Implement.</p>',
          acceptanceCriteria: 'Done when shipped',
        },
        { title: 'Handover', valueCents: null },
      ],
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((m) => m.sortOrder)).toEqual([0, 1, 2]);
    expect(rows.map((m) => m.title)).toEqual(['Discovery', 'Build', 'Handover']);
    const [first, second, third] = rows;
    expect(first?.valueCents).toBe(100000);
    expect(second?.descriptionHtml).toBe('<p>Implement.</p>');
    expect(second?.acceptanceCriteria).toBe('Done when shipped');
    expect(second?.valueCents).toBeNull();
    expect(third?.valueCents).toBeNull();
  });

  it('replace-all soft-deletes the prior set and returns only the new live rows in order', async () => {
    const { proposal } = await proposalFactory();

    const firstSet = await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [{ title: 'Old A' }, { title: 'Old B' }],
    });

    const secondSet = await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [{ title: 'New A' }, { title: 'New B' }, { title: 'New C' }],
    });

    expect(secondSet.map((m) => m.title)).toEqual(['New A', 'New B', 'New C']);

    const live = await proposalMilestonesRepository.listByProposal(proposal.id);
    expect(live.map((m) => m.title)).toEqual(['New A', 'New B', 'New C']);

    // The old rows are soft-deleted (still on disk, but excluded).
    const all = await db
      .select()
      .from(proposalMilestones)
      .where(eq(proposalMilestones.proposalId, proposal.id));
    expect(all).toHaveLength(5);
    const oldIds = firstSet.map((m) => m.id);
    const oldOnDisk = all.filter((r) => oldIds.includes(r.id));
    expect(oldOnDisk.every((r) => r.deletedAt !== null)).toBe(true);
  });

  it('an empty input clears the set', async () => {
    const { proposal } = await proposalFactory();
    await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [{ title: 'Solo' }],
    });

    const cleared = await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [],
    });
    expect(cleared).toEqual([]);
    expect(await proposalMilestonesRepository.listByProposal(proposal.id)).toHaveLength(0);
  });

  it('throws (FK 23503) for an unknown proposalId', async () => {
    await expect(
      proposalMilestonesRepository.setForProposal({
        proposalId: randomUUID(),
        milestones: [{ title: 'Orphan' }],
      })
    ).rejects.toThrow();
  });

  it('rejects a negative valueCents (CHECK) and rolls the set back', async () => {
    const { proposal } = await proposalFactory();

    await expect(
      proposalMilestonesRepository.setForProposal({
        proposalId: proposal.id,
        milestones: [{ title: 'Bad', valueCents: -1 }],
      })
    ).rejects.toThrow();

    expect(await proposalMilestonesRepository.listByProposal(proposal.id)).toHaveLength(0);
  });

  it('round-trips estimatedMinutes (present + null) — BAL-294', async () => {
    const { proposal } = await proposalFactory();

    const rows = await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [
        { title: 'Discovery', estimatedMinutes: 90 },
        { title: 'Build', estimatedMinutes: 0 },
        { title: 'Handover', estimatedMinutes: null },
        { title: 'No effort field' }, // omitted → defaults to null
      ],
    });

    const [discovery, build, handover, omitted] = rows;
    expect(discovery?.estimatedMinutes).toBe(90);
    expect(build?.estimatedMinutes).toBe(0);
    expect(handover?.estimatedMinutes).toBeNull();
    expect(omitted?.estimatedMinutes).toBeNull();

    // Re-read through listByProposal to confirm the column persists.
    const live = await proposalMilestonesRepository.listByProposal(proposal.id);
    expect(live.map((m) => m.estimatedMinutes)).toEqual([90, 0, null, null]);
  });

  it('rejects a negative estimatedMinutes (CHECK proposal_milestone_estimated_minutes_nonneg) and rolls the set back — BAL-294', async () => {
    const { proposal } = await proposalFactory();

    await expect(
      proposalMilestonesRepository.setForProposal({
        proposalId: proposal.id,
        milestones: [{ title: 'Bad effort', estimatedMinutes: -1 }],
      })
    ).rejects.toThrow();

    expect(await proposalMilestonesRepository.listByProposal(proposal.id)).toHaveLength(0);
  });
});

describe('proposalMilestonesRepository.listByProposal', () => {
  it('returns live rows ordered by sortOrder asc and excludes soft-deleted', async () => {
    const { proposal } = await proposalFactory();
    const rows = await proposalMilestonesRepository.setForProposal({
      proposalId: proposal.id,
      milestones: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
    });

    const [first] = rows;
    if (first === undefined) throw new Error('expected a seeded milestone');
    await db
      .update(proposalMilestones)
      .set({ deletedAt: new Date() })
      .where(eq(proposalMilestones.id, first.id));

    const live = await proposalMilestonesRepository.listByProposal(proposal.id);
    expect(live.map((m) => m.title)).toEqual(['B', 'C']);
    expect(live.map((m) => m.sortOrder)).toEqual([1, 2]);
  });
});
