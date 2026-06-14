import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { companies, engagements, projectRequests, proposals } from '../schema';
import { engagementFactory, expertDraftFactory, proposalFactory } from '../test/factories';
import type { ProposalFactoryResult } from '../test/factories';
import { engagementsRepository, KickoffGatesIncompleteError } from './engagements';
import { EngagementTermsCoherenceError } from './proposal-coherence';
import { projectRequestsRepository, InvalidStatusTransitionError } from './project-requests';

/**
 * Seed the A6.5 kickoff fixture: a proposal whose request is advanced to
 * `accepted`, the proposal itself to `accepted`, and (optionally) both persisted
 * kickoff gates confirmed. Returns the proposal-factory result plus the request's
 * resolved `companyId` — the FK ids `materializeFromKickoff` needs.
 */
async function seedAcceptedKickoff(
  options: { bothGates?: boolean } = {}
): Promise<{ source: ProposalFactoryResult; companyId: string }> {
  const source = await proposalFactory({ values: { status: 'accepted' } });

  const gates = options.bothGates === true ? new Date() : null;
  await db
    .update(projectRequests)
    .set({
      status: 'accepted',
      clientBillingConfirmedAt: gates,
      expertTermsConfirmedAt: gates,
    })
    .where(eq(projectRequests.id, source.projectRequestId));

  const request = await projectRequestsRepository.findById(source.projectRequestId);
  if (request === undefined) throw new Error('seeded request vanished');

  return { source, companyId: request.companyId };
}

/** Seed a personal company and return its id (engagements need a company party). */
async function seedCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) throw new Error('company insert failed');
  return company.id;
}

describe('engagementsRepository.create — the seam proof', () => {
  it('creates WITH a source proposal: all provenance ids set, terms snapshotted, defaults applied', async () => {
    const { engagement, sourceProposal, companyId, expertProfileId } = await engagementFactory({
      withSourceProposal: true,
    });

    if (sourceProposal === undefined) throw new Error('expected a seeded source proposal');

    expect(engagement.companyId).toBe(companyId);
    expect(engagement.expertProfileId).toBe(expertProfileId);
    // All provenance wired from the proposal.
    expect(engagement.sourceProposalId).toBe(sourceProposal.proposal.id);
    expect(engagement.relationshipId).toBe(sourceProposal.relationshipId);
    expect(engagement.projectRequestId).toBe(sourceProposal.projectRequestId);
    // Snapshotted terms + defaults.
    expect(engagement.pricingMethod).toBe('fixed');
    expect(engagement.priceCents).toBe(500_000);
    expect(engagement.currency).toBe('aud');
    expect(engagement.billingModel).toBe('proposal'); // default
    expect(engagement.approvalModel).toBe('admin_invoice'); // default
    expect(engagement.status).toBe('active'); // default
    expect(engagement.activatedAt).toBeInstanceOf(Date);
  });

  it('creates WITHOUT a proposal (the retainer seam): only company + expert + terms → row created', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await engagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'tm',
      priceCents: 250_000,
      depositCents: 50_000,
      rateCents: 18_000,
      cadence: 'monthly',
      billingModel: 'retainer',
      approvalModel: 'auto',
    });

    // The load-bearing seam assertion: NO origination row whatsoever.
    expect(engagement.sourceProposalId).toBeNull();
    expect(engagement.relationshipId).toBeNull();
    expect(engagement.projectRequestId).toBeNull();
    // Terms carried on the engagement itself.
    expect(engagement.pricingMethod).toBe('tm');
    expect(engagement.priceCents).toBe(250_000);
    expect(engagement.depositCents).toBe(50_000);
    expect(engagement.rateCents).toBe(18_000);
    expect(engagement.cadence).toBe('monthly');
    expect(engagement.billingModel).toBe('retainer');
    expect(engagement.approvalModel).toBe('auto');
    expect(engagement.status).toBe('active');
    expect(engagement.activatedAt).toBeInstanceOf(Date);
  });

  it('SET NULL: hard-deleting the source proposal nulls source_proposal_id while the engagement survives', async () => {
    const { engagement, sourceProposal } = await engagementFactory({ withSourceProposal: true });
    if (sourceProposal === undefined) throw new Error('expected a seeded source proposal');

    expect(engagement.sourceProposalId).toBe(sourceProposal.proposal.id);

    // Hard DELETE (not soft) the origination proposal.
    await db.delete(proposals).where(eq(proposals.id, sourceProposal.proposal.id));

    const survivor = await engagementsRepository.findById(engagement.id);
    expect(survivor).toBeDefined();
    expect(survivor?.id).toBe(engagement.id);
    // ON DELETE SET NULL — the engagement outlives its origination proposal.
    expect(survivor?.sourceProposalId).toBeNull();
  });
});

describe('engagementsRepository.create — FK / CHECK constraints', () => {
  it('throws (FK 23503) for an unknown companyId', async () => {
    const expert = await expertDraftFactory();
    await expect(
      engagementsRepository.create({
        companyId: randomUUID(),
        expertProfileId: expert.id,
        pricingMethod: 'fixed',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });

  it('throws (FK 23503) for an unknown expertProfileId', async () => {
    const companyId = await seedCompanyId();
    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: randomUUID(),
        pricingMethod: 'fixed',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });

  it('rejects negative priceCents / depositCents / rateCents (CHECK)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'fixed',
        priceCents: -1,
      })
    ).rejects.toThrow();

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 1000,
        depositCents: -1,
      })
    ).rejects.toThrow();

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 1000,
        rateCents: -1,
      })
    ).rejects.toThrow();
  });
});

describe('engagement_request_unique_idx — at most one live engagement per request', () => {
  it('rejects a SECOND live engagement for the same project_request_id (partial unique 23505)', async () => {
    const { engagement, companyId, expertProfileId } = await engagementFactory({
      withSourceProposal: true,
    });
    const requestId = engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');

    await expect(
      engagementsRepository.create({
        companyId,
        expertProfileId,
        projectRequestId: requestId,
        pricingMethod: 'fixed',
        priceCents: 1000,
      })
    ).rejects.toThrow();
  });

  it('a SOFT-DELETED engagement does NOT block re-creating one for the same request (index is partial on deleted_at)', async () => {
    const { engagement, companyId, expertProfileId } = await engagementFactory({
      withSourceProposal: true,
    });
    const requestId = engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');

    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));

    // The unique index ignores the soft-deleted row → re-creation succeeds.
    const replacement = await engagementsRepository.create({
      companyId,
      expertProfileId,
      projectRequestId: requestId,
      pricingMethod: 'fixed',
      priceCents: 2000,
    });
    expect(replacement.projectRequestId).toBe(requestId);
    expect(replacement.id).not.toBe(engagement.id);
  });

  it('allows MANY engagements with a NULL project_request_id (the retainer seam — index is partial on NOT NULL)', async () => {
    const companyId = await seedCompanyId();
    const expertA = await expertDraftFactory();
    const expertB = await expertDraftFactory();

    const r1 = await engagementsRepository.create({
      companyId,
      expertProfileId: expertA.id,
      pricingMethod: 'tm',
      priceCents: 1000,
      rateCents: 18_000,
      cadence: 'monthly',
    });
    const r2 = await engagementsRepository.create({
      companyId,
      expertProfileId: expertB.id,
      pricingMethod: 'tm',
      priceCents: 2000,
      rateCents: 18_000,
      cadence: 'monthly',
    });

    // NULL project_request_id rows are outside the partial index → no collision.
    expect(r1.projectRequestId).toBeNull();
    expect(r2.projectRequestId).toBeNull();
    expect(r1.id).not.toBe(r2.id);
  });
});

describe('engagementsRepository.findById / listByCompany', () => {
  it('findById returns a live engagement and excludes soft-deleted', async () => {
    const { engagement } = await engagementFactory();

    expect((await engagementsRepository.findById(engagement.id))?.id).toBe(engagement.id);

    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));
    expect(await engagementsRepository.findById(engagement.id)).toBeUndefined();
  });

  it('listByCompany returns live engagements for the company only', async () => {
    const companyId = await seedCompanyId();
    const otherCompanyId = await seedCompanyId();
    const expertA = await expertDraftFactory();
    const expertB = await expertDraftFactory();

    const e1 = await engagementsRepository.create({
      companyId,
      expertProfileId: expertA.id,
      pricingMethod: 'fixed',
      priceCents: 1000,
    });
    const e2 = await engagementsRepository.create({
      companyId,
      expertProfileId: expertB.id,
      pricingMethod: 'fixed',
      priceCents: 2000,
    });
    // A different company's engagement must not appear.
    const other = await engagementsRepository.create({
      companyId: otherCompanyId,
      expertProfileId: expertA.id,
      pricingMethod: 'fixed',
      priceCents: 3000,
    });

    const list = await engagementsRepository.listByCompany(companyId);
    const ids = list.map((e) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).toContain(e2.id);
    expect(ids).not.toContain(other.id);

    // Soft-deleted excluded.
    await db.update(engagements).set({ deletedAt: new Date() }).where(eq(engagements.id, e1.id));
    const afterDelete = await engagementsRepository.listByCompany(companyId);
    expect(afterDelete.map((e) => e.id)).not.toContain(e1.id);
    expect(afterDelete.map((e) => e.id)).toContain(e2.id);
  });
});

describe('engagementsRepository.materializeFromKickoff — accept→approve writer', () => {
  it('happy path: advances the request to kickoff_approved AND materialises the engagement with snapshotted terms', async () => {
    const { source, companyId } = await seedAcceptedKickoff({ bothGates: true });

    const { engagement, request } = await engagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      pricingMethod: 'tm',
      priceCents: 250_000,
      currency: 'usd',
      depositCents: 50_000,
      rateCents: 18_000,
      cadence: 'monthly',
    });

    // The request is advanced.
    expect(request.status).toBe('kickoff_approved');
    const reloadedRequest = await projectRequestsRepository.findById(source.projectRequestId);
    expect(reloadedRequest?.status).toBe('kickoff_approved');

    // The engagement row exists with the passed provenance + snapshotted terms.
    expect(engagement.companyId).toBe(companyId);
    expect(engagement.expertProfileId).toBe(source.expertProfileId);
    expect(engagement.sourceProposalId).toBe(source.proposal.id);
    expect(engagement.relationshipId).toBe(source.relationshipId);
    expect(engagement.projectRequestId).toBe(source.projectRequestId);
    expect(engagement.pricingMethod).toBe('tm');
    expect(engagement.priceCents).toBe(250_000);
    expect(engagement.currency).toBe('usd');
    expect(engagement.depositCents).toBe(50_000);
    expect(engagement.rateCents).toBe(18_000);
    expect(engagement.cadence).toBe('monthly');
    // Defaults from the table.
    expect(engagement.billingModel).toBe('proposal');
    expect(engagement.approvalModel).toBe('admin_invoice');
    expect(engagement.status).toBe('active');
    expect(engagement.activatedAt).toBeInstanceOf(Date);

    // Persisted (not just returned).
    const persisted = await engagementsRepository.findById(engagement.id);
    expect(persisted?.id).toBe(engagement.id);
  });

  it('double-call: the second call throws InvalidStatusTransitionError and only ONE engagement exists', async () => {
    const { source, companyId } = await seedAcceptedKickoff({ bothGates: true });

    const args = {
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      pricingMethod: 'fixed' as const,
      priceCents: 500_000,
    };

    await engagementsRepository.materializeFromKickoff(args);

    // Second call — the request is now `kickoff_approved`, not `accepted`.
    await expect(engagementsRepository.materializeFromKickoff(args)).rejects.toBeInstanceOf(
      InvalidStatusTransitionError
    );

    // Exactly one engagement was created for this request.
    const rows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.projectRequestId, source.projectRequestId));
    expect(rows).toHaveLength(1);
  });

  it('throws KickoffGatesIncompleteError when a gate is still null, leaving the request accepted and no engagement', async () => {
    // Only the client_billing gate set; expert_terms left null.
    const source = await proposalFactory({ values: { status: 'accepted' } });
    await db
      .update(projectRequests)
      .set({ status: 'accepted', clientBillingConfirmedAt: new Date() })
      .where(eq(projectRequests.id, source.projectRequestId));
    const request = await projectRequestsRepository.findById(source.projectRequestId);
    if (request === undefined) throw new Error('seeded request vanished');

    await expect(
      engagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId: request.companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        pricingMethod: 'fixed',
        priceCents: 500_000,
      })
    ).rejects.toBeInstanceOf(KickoffGatesIncompleteError);

    // Request untouched, no engagement.
    const reloaded = await projectRequestsRepository.findById(source.projectRequestId);
    expect(reloaded?.status).toBe('accepted');
    const rows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.projectRequestId, source.projectRequestId));
    expect(rows).toHaveLength(0);
  });

  it('throws InvalidStatusTransitionError when the request is not accepted (e.g. proposal_submitted)', async () => {
    // Both gates set, but the request status is proposal_submitted (not accepted).
    const source = await proposalFactory();
    await db
      .update(projectRequests)
      .set({
        status: 'proposal_submitted',
        clientBillingConfirmedAt: new Date(),
        expertTermsConfirmedAt: new Date(),
      })
      .where(eq(projectRequests.id, source.projectRequestId));
    const request = await projectRequestsRepository.findById(source.projectRequestId);
    if (request === undefined) throw new Error('seeded request vanished');
    expect(request.status).toBe('proposal_submitted');

    await expect(
      engagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId: request.companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        pricingMethod: 'fixed',
        priceCents: 500_000,
      })
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);

    const rows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.projectRequestId, source.projectRequestId));
    expect(rows).toHaveLength(0);
  });
});

// ── BAL-293: engagement-terms coherence guard (rollback proofs) ──────────────

describe('engagementsRepository.create — coherence guard (BAL-293)', () => {
  it('rejects tm terms missing a rate (tm_missing_rate) and persists nothing', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const err = await engagementsRepository
      .create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 250_000,
        // rateCents / cadence intentionally omitted → incoherent tm.
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngagementTermsCoherenceError);
    expect((err as EngagementTermsCoherenceError).rule).toBe('tm_missing_rate');

    // No engagement row inserted for the company.
    expect(await engagementsRepository.listByCompany(companyId)).toHaveLength(0);
  });

  it('rejects a negative deposit (deposit_negative) and persists nothing', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const err = await engagementsRepository
      .create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'fixed',
        priceCents: 100_000,
        depositCents: -1,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngagementTermsCoherenceError);
    expect((err as EngagementTermsCoherenceError).rule).toBe('deposit_negative');

    expect(await engagementsRepository.listByCompany(companyId)).toHaveLength(0);
  });

  it('accepts coherent fixed terms (no installment requirement at the engagement seam)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await engagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 500_000,
    });
    expect(engagement.pricingMethod).toBe('fixed');
    expect(engagement.priceCents).toBe(500_000);
  });
});

describe('engagementsRepository.materializeFromKickoff — coherence guard (BAL-293)', () => {
  it('rejects incoherent tm terms (missing rate), leaving the request accepted and no engagement', async () => {
    const { source, companyId } = await seedAcceptedKickoff({ bothGates: true });

    const err = await engagementsRepository
      .materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        pricingMethod: 'tm',
        priceCents: 250_000,
        // rateCents / cadence intentionally omitted → incoherent tm.
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngagementTermsCoherenceError);
    expect((err as EngagementTermsCoherenceError).rule).toBe('tm_missing_rate');

    // Request stays accepted (NOT kickoff_approved); no engagement materialised.
    const reloaded = await projectRequestsRepository.findById(source.projectRequestId);
    expect(reloaded?.status).toBe('accepted');
    const rows = await db
      .select()
      .from(engagements)
      .where(eq(engagements.projectRequestId, source.projectRequestId));
    expect(rows).toHaveLength(0);
  });
});
