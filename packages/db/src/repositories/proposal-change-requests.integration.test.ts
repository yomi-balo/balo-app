import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { proposalChangeRequests } from '../schema';
import { proposalFactory, userFactory } from '../test/factories';
import { proposalChangeRequestsRepository } from './proposal-change-requests';

describe('proposalChangeRequestsRepository.create', () => {
  it('defaults section to general and persists note/version/requester', async () => {
    const { proposal } = await proposalFactory();
    const requester = await userFactory();

    const cr = await proposalChangeRequestsRepository.create({
      proposalId: proposal.id,
      requestedByUserId: requester.id,
      note: 'Please revisit the timeline.',
      proposalVersion: 1,
    });

    expect(cr.proposalId).toBe(proposal.id);
    expect(cr.requestedByUserId).toBe(requester.id);
    expect(cr.note).toBe('Please revisit the timeline.');
    expect(cr.proposalVersion).toBe(1);
    expect(cr.section).toBe('general'); // default
    expect(cr.deletedAt).toBeNull();
  });

  it('honours an explicit section', async () => {
    const { proposal } = await proposalFactory();
    const requester = await userFactory();

    const cr = await proposalChangeRequestsRepository.create({
      proposalId: proposal.id,
      requestedByUserId: requester.id,
      section: 'milestones',
      note: 'Split milestone 2.',
      proposalVersion: 1,
    });

    expect(cr.section).toBe('milestones');
  });

  it('throws for an unknown proposalId (FK cascade) and an unknown requester (FK restrict)', async () => {
    const { proposal } = await proposalFactory();
    const requester = await userFactory();

    await expect(
      proposalChangeRequestsRepository.create({
        proposalId: randomUUID(),
        requestedByUserId: requester.id,
        note: 'Orphan.',
        proposalVersion: 1,
      })
    ).rejects.toThrow();

    await expect(
      proposalChangeRequestsRepository.create({
        proposalId: proposal.id,
        requestedByUserId: randomUUID(),
        note: 'No requester.',
        proposalVersion: 1,
      })
    ).rejects.toThrow();
  });

  it('rejects proposalVersion < 1 (CHECK)', async () => {
    const { proposal } = await proposalFactory();
    const requester = await userFactory();

    await expect(
      proposalChangeRequestsRepository.create({
        proposalId: proposal.id,
        requestedByUserId: requester.id,
        note: 'Bad version.',
        proposalVersion: 0,
      })
    ).rejects.toThrow();
  });
});

describe('proposalChangeRequestsRepository.listByProposal', () => {
  it('returns live change requests newest-first and excludes soft-deleted', async () => {
    const { proposal } = await proposalFactory();
    const requester = await userFactory();

    const older = await proposalChangeRequestsRepository.create({
      proposalId: proposal.id,
      requestedByUserId: requester.id,
      note: 'First.',
      proposalVersion: 1,
    });
    // Force a distinct, later createdAt so the newest-first order is unambiguous.
    const newer = await proposalChangeRequestsRepository.create({
      proposalId: proposal.id,
      requestedByUserId: requester.id,
      note: 'Second.',
      proposalVersion: 1,
    });
    await db
      .update(proposalChangeRequests)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(proposalChangeRequests.id, newer.id));

    const list = await proposalChangeRequestsRepository.listByProposal(proposal.id);
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);

    await db
      .update(proposalChangeRequests)
      .set({ deletedAt: new Date() })
      .where(eq(proposalChangeRequests.id, newer.id));

    const afterDelete = await proposalChangeRequestsRepository.listByProposal(proposal.id);
    expect(afterDelete.map((c) => c.id)).toEqual([older.id]);
  });
});
