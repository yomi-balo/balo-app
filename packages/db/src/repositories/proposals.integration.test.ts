import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { proposals } from '../schema';
import { requestExpertRelationshipFactory } from '../test/factories';
import { proposalsRepository } from './proposals';
import { requestExpertRelationshipsRepository } from './request-expert-relationships';

describe('proposalsRepository.submit', () => {
  it('inserts the proposal and advances the relationship proposal_requested→proposal_submitted', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_requested' } });

    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      scope: '<p>Two-week discovery + build.</p>',
      priceCents: 500000,
    });

    expect(proposal.relationshipId).toBe(relationship.id);
    expect(proposal.projectRequestId).toBe(projectRequestId);
    expect(proposal.expertProfileId).toBe(expertProfileId);
    expect(proposal.status).toBe('submitted');
    expect(proposal.priceCents).toBe(500000);
    expect(proposal.currency).toBe('aud'); // default
    expect(proposal.acceptedAt).toBeNull();

    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_submitted');
  });

  it('honors an explicit currency', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });

    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      scope: '<p>Scope.</p>',
      priceCents: 100000,
      currency: 'usd',
    });

    expect(proposal.currency).toBe('usd');
  });

  it('rolls back (no orphan proposal) when the relationship is not in proposal_requested', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    await expect(
      proposalsRepository.submit({
        relationshipId: relationship.id,
        scope: '<p>Should fail — relationship still invited.</p>',
        priceCents: 1000,
      })
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(proposals)
      .where(eq(proposals.relationshipId, relationship.id));
    expect(rows).toHaveLength(0);
  });

  it('rejects a negative price_cents (check constraint) and rolls back', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });

    await expect(
      proposalsRepository.submit({
        relationshipId: relationship.id,
        scope: '<p>Negative price.</p>',
        priceCents: -1,
      })
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(proposals)
      .where(eq(proposals.relationshipId, relationship.id));
    expect(rows).toHaveLength(0);

    // The relationship advance also rolled back.
    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_requested');
  });

  it('throws for an unknown relationship id', async () => {
    await expect(
      proposalsRepository.submit({
        relationshipId: randomUUID(),
        scope: '<p>No relationship.</p>',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });
});

describe('proposalsRepository.accept', () => {
  it('accepts the proposal + relationship, sets acceptedAt, and creates no other rows', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      scope: '<p>Scope.</p>',
      priceCents: 250000,
    });

    const accepted = await proposalsRepository.accept({ id: proposal.id });

    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedAt).toBeInstanceOf(Date);

    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('accepted');

    // Boundary: accept touches exactly the one proposal row and the relationship.
    // No second proposal row materialised.
    const proposalRows = await db
      .select()
      .from(proposals)
      .where(eq(proposals.relationshipId, relationship.id));
    expect(proposalRows).toHaveLength(1);
  });

  it('throws for an unknown proposal id', async () => {
    await expect(proposalsRepository.accept({ id: randomUUID() })).rejects.toThrow();
  });

  it('rolls back when the relationship is not in proposal_submitted', async () => {
    // Build a proposal but leave the relationship at proposal_requested by
    // inserting the proposal row directly (bypassing submit's advance).
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_requested' } });
    const [proposal] = await db
      .insert(proposals)
      .values({
        relationshipId: relationship.id,
        projectRequestId,
        expertProfileId,
        scope: '<p>Detached proposal.</p>',
        priceCents: 1000,
      })
      .returning();
    if (proposal === undefined) throw new Error('proposal insert failed');

    await expect(proposalsRepository.accept({ id: proposal.id })).rejects.toThrow();

    // Proposal status unchanged.
    const [raw] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(raw?.status).toBe('submitted');
    expect(raw?.acceptedAt).toBeNull();
  });
});

describe('proposalsRepository list / find', () => {
  it('findById returns a live proposal and excludes soft-deleted', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      scope: '<p>Scope.</p>',
      priceCents: 1000,
    });

    expect((await proposalsRepository.findById(proposal.id))?.id).toBe(proposal.id);

    await db.update(proposals).set({ deletedAt: new Date() }).where(eq(proposals.id, proposal.id));
    expect(await proposalsRepository.findById(proposal.id)).toBeUndefined();
  });

  it('listByRequest and listByRelationship return the proposal', async () => {
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      scope: '<p>Scope.</p>',
      priceCents: 1000,
    });

    const byRequest = await proposalsRepository.listByRequest(projectRequestId);
    const byRelationship = await proposalsRepository.listByRelationship(relationship.id);

    expect(byRequest.map((p) => p.id)).toContain(proposal.id);
    expect(byRelationship.map((p) => p.id)).toContain(proposal.id);
  });
});

describe('proposals composite-FK backstop', () => {
  it('rejects a proposal whose denormalised project_request_id diverges from the relationship', async () => {
    const { relationship, expertProfileId } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    // A different, valid project request that is NOT this relationship's.
    const { projectRequestId: otherRequestId } = await requestExpertRelationshipFactory();

    // The single-column FK accepts otherRequestId (a real project_requests row), but the
    // composite FK pins (relationship_id, project_request_id) to the relationship's own
    // pair — so a divergent raw insert is rejected. Last DB action (it aborts the tx).
    await expect(
      db.insert(proposals).values({
        relationshipId: relationship.id,
        projectRequestId: otherRequestId,
        expertProfileId,
        scope: '<p>Divergent.</p>',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });
});
