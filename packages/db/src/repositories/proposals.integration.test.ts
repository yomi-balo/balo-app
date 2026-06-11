import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { proposals, proposalChangeRequests } from '../schema';
import { proposalFactory, requestExpertRelationshipFactory, userFactory } from '../test/factories';
import {
  proposalsRepository,
  InvalidProposalTransitionError,
  ProposalNotDraftError,
  PROPOSAL_STATUS_TRANSITIONS,
  isAllowedProposalTransition,
} from './proposals';
import {
  InvalidRelationshipTransitionError,
  requestExpertRelationshipsRepository,
} from './request-expert-relationships';

describe('proposalsRepository.submit', () => {
  it('inserts the proposal (v1, current, submitted) and advances the relationship proposal_requested→proposal_submitted', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_requested' } });

    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Two-week discovery + build.</p>',
      pricingMethod: 'fixed',
      priceCents: 500000,
    });

    expect(proposal.relationshipId).toBe(relationship.id);
    expect(proposal.projectRequestId).toBe(projectRequestId);
    expect(proposal.expertProfileId).toBe(expertProfileId);
    expect(proposal.status).toBe('submitted');
    expect(proposal.version).toBe(1);
    expect(proposal.isCurrent).toBe(true);
    expect(proposal.pricingMethod).toBe('fixed');
    expect(proposal.overview).toBe('<p>Two-week discovery + build.</p>');
    expect(proposal.priceCents).toBe(500000);
    expect(proposal.currency).toBe('aud'); // default
    expect(proposal.acceptedAt).toBeNull();

    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_submitted');
  });

  it('honors an explicit currency and the T&M header fields', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });

    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'tm',
      priceCents: 100000,
      currency: 'usd',
      timeframeWeeks: 10,
      exclusions: '<p>Not included.</p>',
      depositCents: 25000,
      rateCents: 18000,
      cadence: 'monthly',
    });

    expect(proposal.currency).toBe('usd');
    expect(proposal.pricingMethod).toBe('tm');
    expect(proposal.timeframeWeeks).toBe(10);
    expect(proposal.exclusions).toBe('<p>Not included.</p>');
    expect(proposal.depositCents).toBe(25000);
    expect(proposal.rateCents).toBe(18000);
    expect(proposal.cadence).toBe('monthly');
  });

  it('rolls back (no orphan proposal) when the relationship is not in proposal_requested', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    await expect(
      proposalsRepository.submit({
        relationshipId: relationship.id,
        overview: '<p>Should fail — relationship still invited.</p>',
        pricingMethod: 'fixed',
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
        overview: '<p>Negative price.</p>',
        pricingMethod: 'fixed',
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
        overview: '<p>No relationship.</p>',
        pricingMethod: 'fixed',
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
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
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

  it('rejects accept from a non-submitted proposal (changes_requested) with InvalidProposalTransitionError', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    // Move to changes_requested (a valid out-edge of submitted).
    await proposalsRepository.transitionStatus({
      id: proposal.id,
      to: 'changes_requested',
      expectedFrom: 'submitted',
    });

    await expect(proposalsRepository.accept({ id: proposal.id })).rejects.toBeInstanceOf(
      InvalidProposalTransitionError
    );

    // Status untouched on disk.
    const [raw] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(raw?.status).toBe('changes_requested');
    expect(raw?.acceptedAt).toBeNull();
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
        status: 'submitted',
        pricingMethod: 'fixed',
        overview: '<p>Detached proposal.</p>',
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

describe('proposal status transition map', () => {
  it('encodes the lifecycle (submitted out-edges, terminal states)', () => {
    expect(isAllowedProposalTransition('draft', 'submitted')).toBe(true);
    expect(isAllowedProposalTransition('submitted', 'accepted')).toBe(true);
    expect(isAllowedProposalTransition('submitted', 'changes_requested')).toBe(true);
    expect(isAllowedProposalTransition('submitted', 'withdrawn')).toBe(true);
    expect(isAllowedProposalTransition('changes_requested', 'resubmitted')).toBe(true);
    // Terminal — no out-edges.
    expect(PROPOSAL_STATUS_TRANSITIONS.accepted).toHaveLength(0);
    expect(PROPOSAL_STATUS_TRANSITIONS.withdrawn).toHaveLength(0);
    expect(PROPOSAL_STATUS_TRANSITIONS.resubmitted).toHaveLength(0);
    // An illegal jump.
    expect(isAllowedProposalTransition('draft', 'accepted')).toBe(false);
  });
});

describe('proposalsRepository.transitionStatus', () => {
  it('performs a legal submitted→changes_requested move', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });

    const moved = await proposalsRepository.transitionStatus({
      id: proposal.id,
      to: 'changes_requested',
    });
    expect(moved.status).toBe('changes_requested');
  });

  it('rejects an illegal draft→accepted move', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_submitted' } });
    const [draft] = await db
      .insert(proposals)
      .values({
        relationshipId: relationship.id,
        projectRequestId,
        expertProfileId,
        status: 'draft',
        pricingMethod: 'fixed',
        overview: '<p>Draft.</p>',
        priceCents: 1000,
      })
      .returning();
    if (draft === undefined) throw new Error('draft insert failed');

    await expect(
      proposalsRepository.transitionStatus({ id: draft.id, to: 'accepted' })
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError);
  });

  it('rejects an expectedFrom mismatch', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });

    await expect(
      proposalsRepository.transitionStatus({
        id: proposal.id,
        to: 'changes_requested',
        expectedFrom: 'draft', // it is actually `submitted`
      })
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError);
  });

  it('rejects all out-edges from a terminal accepted row', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    await proposalsRepository.accept({ id: proposal.id });

    await expect(
      proposalsRepository.transitionStatus({ id: proposal.id, to: 'withdrawn' })
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError);
  });

  it('throws for an unknown id', async () => {
    await expect(
      proposalsRepository.transitionStatus({ id: randomUUID(), to: 'accepted' })
    ).rejects.toThrow();
  });

  it('throws for a soft-deleted row and leaves its status untouched', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    await db.update(proposals).set({ deletedAt: new Date() }).where(eq(proposals.id, proposal.id));

    await expect(
      proposalsRepository.transitionStatus({ id: proposal.id, to: 'changes_requested' })
    ).rejects.toThrow();

    const [raw] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(raw?.status).toBe('submitted');
  });
});

describe('proposalsRepository.requestChanges', () => {
  it('flips submitted→changes_requested AND writes a change request with proposalVersion = the proposal version', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    const client = await userFactory();

    const cr = await proposalsRepository.requestChanges({
      proposalId: proposal.id,
      requestedByUserId: client.id,
      section: 'pricing',
      note: 'Please reduce the upfront installment.',
    });

    expect(cr.proposalId).toBe(proposal.id);
    expect(cr.requestedByUserId).toBe(client.id);
    expect(cr.section).toBe('pricing');
    expect(cr.proposalVersion).toBe(proposal.version);

    const [raw] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(raw?.status).toBe('changes_requested');

    const crRows = await db
      .select()
      .from(proposalChangeRequests)
      .where(eq(proposalChangeRequests.proposalId, proposal.id));
    expect(crRows).toHaveLength(1);
  });

  it('rejects when the proposal is not submitted (and writes no change request)', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    await proposalsRepository.accept({ id: proposal.id });
    const client = await userFactory();

    await expect(
      proposalsRepository.requestChanges({
        proposalId: proposal.id,
        requestedByUserId: client.id,
        note: 'Too late.',
      })
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError);

    const crRows = await db
      .select()
      .from(proposalChangeRequests)
      .where(eq(proposalChangeRequests.proposalId, proposal.id));
    expect(crRows).toHaveLength(0);
  });
});

describe('proposalsRepository.resubmit', () => {
  it('increments the version, supersedes the old row, and keeps exactly one current', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const v1 = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>v1.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    const client = await userFactory();
    await proposalsRepository.requestChanges({
      proposalId: v1.id,
      requestedByUserId: client.id,
      note: 'Revise pricing.',
    });

    const v2 = await proposalsRepository.resubmit({
      relationshipId: relationship.id,
      overview: '<p>v2.</p>',
      pricingMethod: 'fixed',
      priceCents: 2000,
    });

    expect(v2.version).toBe(2);
    expect(v2.isCurrent).toBe(true);
    expect(v2.status).toBe('submitted');

    // The old row is superseded.
    const [oldRaw] = await db.select().from(proposals).where(eq(proposals.id, v1.id));
    expect(oldRaw?.version).toBe(1);
    expect(oldRaw?.isCurrent).toBe(false);
    expect(oldRaw?.status).toBe('resubmitted');

    // Exactly one current live row for the relationship — and it's v2 (the
    // partial-unique index did NOT trip: flip-before-insert).
    const current = await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.relationshipId, relationship.id),
          eq(proposals.isCurrent, true),
          isNull(proposals.deletedAt)
        )
      );
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(v2.id);

    // Full two-row history is intact.
    const all = await db
      .select()
      .from(proposals)
      .where(eq(proposals.relationshipId, relationship.id));
    expect(all).toHaveLength(2);
  });

  it('throws when the current proposal is not changes_requested', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>v1.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });

    // Current is `submitted`, not `changes_requested`.
    await expect(
      proposalsRepository.resubmit({
        relationshipId: relationship.id,
        overview: '<p>v2.</p>',
        pricingMethod: 'fixed',
        priceCents: 2000,
      })
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError);
  });
});

describe('proposalsRepository list / find', () => {
  it('findById returns a live proposal and excludes soft-deleted', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
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
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });

    const byRequest = await proposalsRepository.listByRequest(projectRequestId);
    const byRelationship = await proposalsRepository.listByRelationship(relationship.id);

    expect(byRequest.map((p) => p.id)).toContain(proposal.id);
    expect(byRelationship.map((p) => p.id)).toContain(proposal.id);
  });

  it('findCurrentByRelationship returns the is_current row and undefined once soft-deleted', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const proposal = await proposalsRepository.submit({
      relationshipId: relationship.id,
      overview: '<p>Scope.</p>',
      pricingMethod: 'fixed',
      priceCents: 1000,
    });

    const current = await proposalsRepository.findCurrentByRelationship(relationship.id);
    expect(current?.id).toBe(proposal.id);

    await db.update(proposals).set({ deletedAt: new Date() }).where(eq(proposals.id, proposal.id));
    expect(await proposalsRepository.findCurrentByRelationship(relationship.id)).toBeUndefined();
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
        status: 'submitted',
        pricingMethod: 'fixed',
        overview: '<p>Divergent.</p>',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });
});

describe('proposalsRepository.createDraft', () => {
  it('inserts the FIRST draft (draft, v1, current) WITHOUT advancing the relationship', async () => {
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_requested' } });

    const draft = await proposalsRepository.createDraft({
      relationshipId: relationship.id,
      overview: '<p>Working draft…</p>',
      pricingMethod: 'fixed',
      priceCents: 0,
    });

    // Denormalised ids read from the locked relationship row (not caller-supplied).
    expect(draft.relationshipId).toBe(relationship.id);
    expect(draft.projectRequestId).toBe(projectRequestId);
    expect(draft.expertProfileId).toBe(expertProfileId);
    expect(draft.status).toBe('draft');
    expect(draft.version).toBe(1);
    expect(draft.isCurrent).toBe(true);
    expect(draft.priceCents).toBe(0);
    expect(draft.currency).toBe('aud'); // default
    expect(draft.submittedAt).toBeInstanceOf(Date); // creation-time stamp (re-stamped on submit)

    // The relationship is NOT advanced — drafts are private.
    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_requested');
  });

  it('honours an explicit currency + the T&M header fields on a draft', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });

    const draft = await proposalsRepository.createDraft({
      relationshipId: relationship.id,
      overview: '<p>T&M draft.</p>',
      pricingMethod: 'tm',
      priceCents: 0,
      currency: 'usd',
      timeframeWeeks: 8,
      exclusions: '<p>Out of scope.</p>',
      depositCents: 50000,
      rateCents: 20000,
      cadence: 'fortnightly',
    });

    expect(draft.status).toBe('draft');
    expect(draft.pricingMethod).toBe('tm');
    expect(draft.currency).toBe('usd');
    expect(draft.timeframeWeeks).toBe(8);
    expect(draft.exclusions).toBe('<p>Out of scope.</p>');
    expect(draft.depositCents).toBe(50000);
    expect(draft.rateCents).toBe(20000);
    expect(draft.cadence).toBe('fortnightly');
  });

  it('throws a 23505 (one-current) when a current proposal already exists for the relationship', async () => {
    // Seed an existing current proposal directly on the relationship.
    const { relationshipId } = await proposalFactory({ values: { status: 'draft' } });

    // A second current draft for the same relationship trips
    // `proposal_current_per_relationship_idx`.
    await expect(
      proposalsRepository.createDraft({
        relationshipId,
        overview: '<p>Second draft — should collide.</p>',
        pricingMethod: 'fixed',
        priceCents: 0,
      })
    ).rejects.toThrow();

    // Still exactly one current live row.
    const current = await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.relationshipId, relationshipId),
          eq(proposals.isCurrent, true),
          isNull(proposals.deletedAt)
        )
      );
    expect(current).toHaveLength(1);
  });

  it('throws for an unknown relationship id', async () => {
    await expect(
      proposalsRepository.createDraft({
        relationshipId: randomUUID(),
        overview: '<p>No relationship.</p>',
        pricingMethod: 'fixed',
        priceCents: 0,
      })
    ).rejects.toThrow();
  });
});

describe('proposalsRepository.updateDraft', () => {
  it('updates the header fields of a current draft, keeping it a draft', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const draft = await proposalsRepository.createDraft({
      relationshipId: relationship.id,
      overview: '<p>v0.</p>',
      pricingMethod: 'fixed',
      priceCents: 0,
    });
    const before = draft.updatedAt;

    const updated = await proposalsRepository.updateDraft({
      proposalId: draft.id,
      overview: '<p>Revised overview.</p>',
      pricingMethod: 'tm',
      priceCents: 750000,
      currency: 'usd',
      timeframeWeeks: 12,
      exclusions: '<p>Excludes data migration.</p>',
      depositCents: 100000,
      rateCents: 25000,
      cadence: 'monthly',
    });

    expect(updated.id).toBe(draft.id);
    expect(updated.status).toBe('draft'); // still a draft
    expect(updated.overview).toBe('<p>Revised overview.</p>');
    expect(updated.pricingMethod).toBe('tm');
    expect(updated.priceCents).toBe(750000);
    expect(updated.currency).toBe('usd');
    expect(updated.timeframeWeeks).toBe(12);
    expect(updated.exclusions).toBe('<p>Excludes data migration.</p>');
    expect(updated.depositCents).toBe(100000);
    expect(updated.rateCents).toBe(25000);
    expect(updated.cadence).toBe('monthly');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('rejects (ProposalNotDraftError) a non-draft (submitted) row and leaves it untouched', async () => {
    const { proposal } = await proposalFactory({ values: { status: 'submitted' } });

    await expect(
      proposalsRepository.updateDraft({
        proposalId: proposal.id,
        overview: '<p>Stale autosave that must NOT land.</p>',
        pricingMethod: 'fixed',
        priceCents: 999999,
      })
    ).rejects.toBeInstanceOf(ProposalNotDraftError);

    // The submitted proposal is unchanged on disk.
    const [raw] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(raw?.status).toBe('submitted');
    expect(raw?.overview).toBe(proposal.overview);
    expect(raw?.priceCents).toBe(proposal.priceCents);
  });

  it('rejects (ProposalNotDraftError) a soft-deleted draft', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const draft = await proposalsRepository.createDraft({
      relationshipId: relationship.id,
      overview: '<p>To be soft-deleted.</p>',
      pricingMethod: 'fixed',
      priceCents: 0,
    });
    await db.update(proposals).set({ deletedAt: new Date() }).where(eq(proposals.id, draft.id));

    await expect(
      proposalsRepository.updateDraft({
        proposalId: draft.id,
        overview: '<p>Should not apply.</p>',
        pricingMethod: 'fixed',
        priceCents: 1000,
      })
    ).rejects.toBeInstanceOf(ProposalNotDraftError);
  });

  it('throws ProposalNotDraftError for an unknown id', async () => {
    await expect(
      proposalsRepository.updateDraft({
        proposalId: randomUUID(),
        overview: '<p>No such proposal.</p>',
        pricingMethod: 'fixed',
        priceCents: 0,
      })
    ).rejects.toBeInstanceOf(ProposalNotDraftError);
  });
});

describe('proposalsRepository.promoteToSubmit', () => {
  it('promotes draft→submitted, advances the relationship, and re-stamps submittedAt to ~now', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const draft = await proposalsRepository.createDraft({
      relationshipId: relationship.id,
      overview: '<p>Ready to submit.</p>',
      pricingMethod: 'fixed',
      priceCents: 500000,
    });
    const draftSubmittedAt = draft.submittedAt; // creation-time stamp

    // Backdate the draft's submittedAt so the re-stamp is observably newer.
    const past = new Date(Date.now() - 60_000);
    await db.update(proposals).set({ submittedAt: past }).where(eq(proposals.id, draft.id));

    const before = Date.now();
    const submitted = await proposalsRepository.promoteToSubmit({
      proposalId: draft.id,
      relationshipId: relationship.id,
    });
    const after = Date.now();

    expect(submitted.id).toBe(draft.id); // same row — no new version
    expect(submitted.status).toBe('submitted');
    expect(submitted.isCurrent).toBe(true); // unchanged (no flip)
    expect(submitted.version).toBe(1);

    // submittedAt re-stamped to ~now (newer than both the backdated value and the
    // original creation-time stamp).
    expect(submitted.submittedAt.getTime()).toBeGreaterThan(past.getTime());
    expect(submitted.submittedAt.getTime()).toBeGreaterThanOrEqual(
      draftSubmittedAt.getTime() - 1000
    );
    expect(submitted.submittedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(submitted.submittedAt.getTime()).toBeLessThanOrEqual(after + 1000);

    // The relationship spine advanced.
    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_submitted');

    // Exactly one current live row, and it is the same proposal.
    const current = await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.relationshipId, relationship.id),
          eq(proposals.isCurrent, true),
          isNull(proposals.deletedAt)
        )
      );
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(draft.id);
  });

  it('rejects (InvalidProposalTransitionError) when the proposal is not a draft', async () => {
    // A non-draft (submitted) proposal whose relationship is still
    // proposal_requested: the relationship spine advances first, then the proposal
    // flip is rejected because expectedFrom:'draft' mismatches → whole tx rolls back.
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_requested' } });
    const [proposal] = await db
      .insert(proposals)
      .values({
        relationshipId: relationship.id,
        projectRequestId,
        expertProfileId,
        status: 'submitted',
        pricingMethod: 'fixed',
        overview: '<p>Already submitted — cannot promote a non-draft.</p>',
        priceCents: 1000,
      })
      .returning();
    if (proposal === undefined) throw new Error('proposal insert failed');

    await expect(
      proposalsRepository.promoteToSubmit({
        proposalId: proposal.id,
        relationshipId: relationship.id,
      })
    ).rejects.toBeInstanceOf(InvalidProposalTransitionError);

    // Nothing moved: proposal still submitted, relationship rolled back to requested.
    const [raw] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(raw?.status).toBe('submitted');
    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_requested');
  });

  it('rejects (InvalidRelationshipTransitionError) and rolls back when the relationship is not at proposal_requested', async () => {
    // Relationship already at proposal_submitted; a fresh draft sitting under it.
    const { relationship, projectRequestId, expertProfileId } =
      await requestExpertRelationshipFactory({ values: { status: 'proposal_submitted' } });
    const [draft] = await db
      .insert(proposals)
      .values({
        relationshipId: relationship.id,
        projectRequestId,
        expertProfileId,
        status: 'draft',
        pricingMethod: 'fixed',
        overview: '<p>Draft under an already-advanced relationship.</p>',
        priceCents: 1000,
      })
      .returning();
    if (draft === undefined) throw new Error('draft insert failed');

    await expect(
      proposalsRepository.promoteToSubmit({
        proposalId: draft.id,
        relationshipId: relationship.id,
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

    // The proposal status did NOT flip (relationship advance failed first → rollback).
    const [raw] = await db.select().from(proposals).where(eq(proposals.id, draft.id));
    expect(raw?.status).toBe('draft');
  });

  it('throws for an unknown proposal id (relationship advanced, proposal missing → rollback)', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });

    await expect(
      proposalsRepository.promoteToSubmit({
        proposalId: randomUUID(),
        relationshipId: relationship.id,
      })
    ).rejects.toThrow();

    // The relationship advance rolled back with the failed proposal flip.
    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('proposal_requested');
  });
});
