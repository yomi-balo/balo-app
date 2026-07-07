import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  auditEvents,
  companies,
  engagements,
  expertProfiles,
  projectRequests,
  proposalMilestones,
  proposals,
  type AuditEvent,
} from '../schema';
import {
  engagementFactory,
  engagementMilestoneFactory,
  expertDraftFactory,
  proposalFactory,
  userFactory,
} from '../test/factories';
import type { ProposalFactoryResult } from '../test/factories';
import {
  engagementsRepository,
  KickoffGatesIncompleteError,
  InvalidEngagementTransitionError,
  MilestonesIncompleteError,
} from './engagements';
import { EngagementTermsCoherenceError } from './proposal-coherence';
import { projectRequestsRepository, InvalidStatusTransitionError } from './project-requests';

/**
 * Read delivery audit rows for one entity from main's generic `audit_events` table
 * (BAL-344). Engagement lifecycle events use `entity_id = engagementId`; that table
 * has no `engagement_id` column (the id is folded into `metadata.engagementId`).
 * Ordered createdAt asc, ties by id.
 */
async function auditEventsForEntity(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
}

/**
 * Seed the A6.5 kickoff fixture: a proposal whose request is advanced to
 * `accepted`, the proposal itself to `accepted`, and (optionally) both persisted
 * kickoff gates confirmed. Returns the proposal-factory result plus the request's
 * resolved `companyId` — the FK ids `materializeFromKickoff` needs.
 */
async function seedAcceptedKickoff(
  options: { bothGates?: boolean; milestoneCount?: number } = {}
): Promise<{ source: ProposalFactoryResult; companyId: string; adminId: string }> {
  const source = await proposalFactory({ values: { status: 'accepted' } });

  // Optionally seed N proposal milestones (the snapshot source for BAL-330).
  const count = options.milestoneCount ?? 0;
  if (count > 0) {
    await db.insert(proposalMilestones).values(
      Array.from({ length: count }, (_unused, i) => ({
        proposalId: source.proposal.id,
        sortOrder: i,
        title: `Milestone ${i + 1}`,
        descriptionHtml: `<p>Deliverable ${i + 1}</p>`,
        acceptanceCriteria: `Signed off ${i + 1}`,
        valueCents: 100_000,
      }))
    );
  }

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

  const admin = await userFactory({ platformRole: 'admin' });

  return { source, companyId: request.companyId, adminId: admin.id };
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
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const { engagement, request } = await engagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
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
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const args = {
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
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
    const admin = await userFactory({ platformRole: 'admin' });

    await expect(
      engagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId: request.companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: admin.id,
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
    const admin = await userFactory({ platformRole: 'admin' });

    await expect(
      engagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId: request.companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: admin.id,
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
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const err = await engagementsRepository
      .materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: adminId,
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

// ── BAL-330: delivery lifecycle transitions + snapshot + reads ───────────────

/** Seed a fresh ACTIVE engagement plus a distinct acting user. */
async function seedActiveEngagement(): Promise<{
  engagementId: string;
  companyId: string;
  expertProfileId: string;
  userId: string;
}> {
  const { engagement, companyId, expertProfileId } = await engagementFactory();
  const user = await userFactory();
  return { engagementId: engagement.id, companyId, expertProfileId, userId: user.id };
}

/**
 * Seed a `pending_acceptance` engagement DIRECTLY (bypassing requestCompletion, so
 * the audit trail starts empty) with the completion-request stamps populated.
 */
async function seedPendingAcceptanceEngagement(overrides?: {
  completionRequestedAt?: Date;
}): Promise<{ engagementId: string; userId: string; requesterId: string }> {
  const { engagement } = await engagementFactory();
  const requester = await userFactory();
  const actor = await userFactory();
  await db
    .update(engagements)
    .set({
      status: 'pending_acceptance',
      completionRequestedByUserId: requester.id,
      completionRequestedAt: overrides?.completionRequestedAt ?? new Date(),
    })
    .where(eq(engagements.id, engagement.id));
  return { engagementId: engagement.id, userId: actor.id, requesterId: requester.id };
}

describe('engagementsRepository.materializeFromKickoff — milestone snapshot (BAL-330)', () => {
  it('snapshots N proposal milestones → N engagement milestones (provenance + created_by=admin) + one snapshot audit', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({
      bothGates: true,
      milestoneCount: 3,
    });
    const proposalMs = await db
      .select()
      .from(proposalMilestones)
      .where(eq(proposalMilestones.proposalId, source.proposal.id))
      .orderBy(asc(proposalMilestones.sortOrder));

    const { engagement } = await engagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 300_000,
    });

    const snapshot = await engagementsRepository.listMilestones(engagement.id);
    expect(snapshot).toHaveLength(3);
    // Provenance + snapshot fields copied, order preserved, created_by=admin.
    snapshot.forEach((m, i) => {
      const src = proposalMs[i];
      expect(src).toBeDefined();
      expect(m.sourceProposalMilestoneId).toBe(src?.id);
      expect(m.title).toBe(src?.title);
      expect(m.descriptionHtml).toBe(src?.descriptionHtml);
      expect(m.acceptanceCriteria).toBe(src?.acceptanceCriteria);
      expect(m.valueCents).toBe(src?.valueCents);
      expect(m.sortOrder).toBe(src?.sortOrder);
      expect(m.status).toBe('pending');
      expect(m.createdByUserId).toBe(adminId);
    });

    // Exactly one snapshot audit event with milestone_count=3.
    const events = await auditEventsForEntity(engagement.id);
    const snapshotEvents = events.filter((e) => e.action === 'engagement.milestones_snapshotted');
    expect(snapshotEvents).toHaveLength(1);
    expect(snapshotEvents[0]?.entityType).toBe('engagement');
    expect(snapshotEvents[0]?.actorUserId).toBe(adminId);
    expect(snapshotEvents[0]?.metadata).toMatchObject({
      milestone_count: 3,
      source_proposal_id: source.proposal.id,
      engagementId: engagement.id,
    });
  });

  it('zero-milestone proposal → zero engagement milestones + snapshot audit with milestone_count:0', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const { engagement } = await engagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 300_000,
    });

    expect(await engagementsRepository.listMilestones(engagement.id)).toHaveLength(0);
    const events = await auditEventsForEntity(engagement.id);
    const snapshotEvent = events.find((e) => e.action === 'engagement.milestones_snapshotted');
    expect(snapshotEvent?.metadata).toMatchObject({ milestone_count: 0 });
  });
});

describe('engagementsRepository.requestCompletion', () => {
  it('all live milestones completed → pending_acceptance, stamps + audit', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    await engagementMilestoneFactory({
      engagementId,
      values: { status: 'completed', sortOrder: 0 },
    });
    await engagementMilestoneFactory({
      engagementId,
      values: { status: 'completed', sortOrder: 1 },
    });

    const advanced = await engagementsRepository.requestCompletion({ engagementId, userId });
    expect(advanced.status).toBe('pending_acceptance');
    expect(advanced.completionRequestedByUserId).toBe(userId);
    expect(advanced.completionRequestedAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(engagementId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('engagement.completion_requested');
    expect(events[0]?.entityType).toBe('engagement');
    expect(events[0]?.metadata).toMatchObject({ engagementId });
  });

  it('zero-milestone engagement → allowed (vacuous "all completed")', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    const advanced = await engagementsRepository.requestCompletion({ engagementId, userId });
    expect(advanced.status).toBe('pending_acceptance');
  });

  it('throws MilestonesIncompleteError when a live milestone is not completed (nothing mutated)', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    await engagementMilestoneFactory({
      engagementId,
      values: { status: 'completed', sortOrder: 0 },
    });
    await engagementMilestoneFactory({
      engagementId,
      values: { status: 'in_progress', sortOrder: 1 },
    });

    await expect(
      engagementsRepository.requestCompletion({ engagementId, userId })
    ).rejects.toBeInstanceOf(MilestonesIncompleteError);

    const reloaded = await engagementsRepository.findById(engagementId);
    expect(reloaded?.status).toBe('active');
    expect(reloaded?.completionRequestedAt).toBeNull();
    // No audit event written (whole tx rolled back).
    expect(await auditEventsForEntity(engagementId)).toHaveLength(0);
  });

  it('a SOFT-DELETED incomplete milestone does not block completion (only live milestones count)', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    await engagementMilestoneFactory({
      engagementId,
      values: { status: 'completed', sortOrder: 0 },
    });
    await engagementMilestoneFactory({
      engagementId,
      values: { status: 'in_progress', sortOrder: 1, deletedAt: new Date() },
    });

    const advanced = await engagementsRepository.requestCompletion({ engagementId, userId });
    expect(advanced.status).toBe('pending_acceptance');
  });

  it('throws InvalidEngagementTransitionError when the engagement is not active', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();
    await expect(
      engagementsRepository.requestCompletion({ engagementId, userId })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('engagementsRepository.withdrawCompletionRequest', () => {
  it('pending_acceptance → active, clears completion stamps + audit', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await engagementsRepository.withdrawCompletionRequest({
      engagementId,
      userId,
    });
    expect(advanced.status).toBe('active');
    expect(advanced.completionRequestedByUserId).toBeNull();
    expect(advanced.completionRequestedAt).toBeNull();

    const events = await auditEventsForEntity(engagementId);
    expect(events[0]?.action).toBe('engagement.completion_withdrawn');
    expect(events[0]?.metadata).toMatchObject({ engagementId });
  });

  it('illegal from active → InvalidEngagementTransitionError', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    await expect(
      engagementsRepository.withdrawCompletionRequest({ engagementId, userId })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('engagementsRepository.acceptCompletion', () => {
  it('client path: → completed, accepted_by=user, acceptance_method=client, actor=user audit', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await engagementsRepository.acceptCompletion({
      engagementId,
      method: 'client',
      userId,
    });
    expect(advanced.status).toBe('completed');
    expect(advanced.acceptedByUserId).toBe(userId);
    expect(advanced.acceptanceMethod).toBe('client');
    expect(advanced.acceptedAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(engagementId);
    const acceptEvent = events.find((e) => e.action === 'engagement.accepted');
    expect(acceptEvent?.actorUserId).toBe(userId);
    expect(acceptEvent?.metadata).toMatchObject({ acceptance_method: 'client', engagementId });
  });

  it('auto path: → completed, accepted_by=null, acceptance_method=auto, audit actor null', async () => {
    const { engagementId } = await seedPendingAcceptanceEngagement();

    const advanced = await engagementsRepository.acceptCompletion({ engagementId, method: 'auto' });
    expect(advanced.status).toBe('completed');
    expect(advanced.acceptedByUserId).toBeNull();
    expect(advanced.acceptanceMethod).toBe('auto');
    expect(advanced.acceptedAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(engagementId);
    const acceptEvent = events.find((e) => e.action === 'engagement.accepted');
    expect(acceptEvent?.actorUserId).toBeNull();
    expect(acceptEvent?.metadata).toMatchObject({ acceptance_method: 'auto', engagementId });
  });

  it('illegal from active → InvalidEngagementTransitionError', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    await expect(
      engagementsRepository.acceptCompletion({ engagementId, method: 'client', userId })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('engagementsRepository.requestChanges', () => {
  it('pending_acceptance → active, stores note + attribution, clears completion stamps, audit {note}', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await engagementsRepository.requestChanges({
      engagementId,
      userId,
      note: 'Please revise the data model section.',
    });
    expect(advanced.status).toBe('active');
    expect(advanced.changeRequestNote).toBe('Please revise the data model section.');
    expect(advanced.changeRequestedByUserId).toBe(userId);
    expect(advanced.changeRequestedAt).toBeInstanceOf(Date);
    expect(advanced.completionRequestedByUserId).toBeNull();
    expect(advanced.completionRequestedAt).toBeNull();

    const events = await auditEventsForEntity(engagementId);
    const changeEvent = events.find((e) => e.action === 'engagement.changes_requested');
    expect(changeEvent?.metadata).toMatchObject({
      note: 'Please revise the data model section.',
      engagementId,
    });
  });

  it('illegal from active → InvalidEngagementTransitionError', async () => {
    const { engagementId, userId } = await seedActiveEngagement();
    await expect(
      engagementsRepository.requestChanges({ engagementId, userId, note: 'x' })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('engagementsRepository.cancelEngagement', () => {
  it('from ACTIVE → cancelled + reason/attribution + audit', async () => {
    const { engagementId, userId } = await seedActiveEngagement();

    const advanced = await engagementsRepository.cancelEngagement({
      engagementId,
      userId,
      reason: 'Client withdrew.',
    });
    expect(advanced.status).toBe('cancelled');
    expect(advanced.cancelledByUserId).toBe(userId);
    expect(advanced.cancellationReason).toBe('Client withdrew.');
    expect(advanced.cancelledAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(engagementId);
    const cancelEvent = events.find((e) => e.action === 'engagement.cancelled');
    expect(cancelEvent?.metadata).toMatchObject({
      from: 'active',
      to: 'cancelled',
      reason: 'Client withdrew.',
      engagementId,
    });
  });

  it('from PENDING_ACCEPTANCE → cancelled (two legal sources, no expectedFrom)', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await engagementsRepository.cancelEngagement({
      engagementId,
      userId,
      reason: 'Scope void.',
    });
    expect(advanced.status).toBe('cancelled');
    const events = await auditEventsForEntity(engagementId);
    expect(events.find((e) => e.action === 'engagement.cancelled')?.metadata).toMatchObject({
      from: 'pending_acceptance',
      engagementId,
    });
  });

  it('terminal (completed) → InvalidEngagementTransitionError', async () => {
    const { engagement } = await engagementFactory({ values: { status: 'completed' } });
    const user = await userFactory();
    await expect(
      engagementsRepository.cancelEngagement({
        engagementId: engagement.id,
        userId: user.id,
        reason: 'nope',
      })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('engagement transitions — missing engagement (advanceEngagementStatus not-found branch)', () => {
  it('withdrawCompletionRequest on a non-existent engagement throws Error(not found)', async () => {
    const user = await userFactory();
    await expect(
      engagementsRepository.withdrawCompletionRequest({
        engagementId: randomUUID(),
        userId: user.id,
      })
    ).rejects.toThrow(/Engagement not found/);
  });

  it('acceptCompletion (auto) on a non-existent engagement throws Error(not found)', async () => {
    await expect(
      engagementsRepository.acceptCompletion({ engagementId: randomUUID(), method: 'auto' })
    ).rejects.toThrow(/Engagement not found/);
  });

  it('requestChanges on a non-existent engagement throws Error(not found)', async () => {
    const user = await userFactory();
    await expect(
      engagementsRepository.requestChanges({
        engagementId: randomUUID(),
        userId: user.id,
        note: 'x',
      })
    ).rejects.toThrow(/Engagement not found/);
  });
});

describe('engagementsRepository.findEngagementWithMilestones', () => {
  it('returns live milestones ordered (soft-deleted excluded) + freelancer agency=null', async () => {
    const { engagementId } = await seedActiveEngagement();
    await engagementMilestoneFactory({ engagementId, values: { title: 'B', sortOrder: 1 } });
    await engagementMilestoneFactory({ engagementId, values: { title: 'A', sortOrder: 0 } });
    await engagementMilestoneFactory({
      engagementId,
      values: { title: 'Gone', sortOrder: 2, deletedAt: new Date() },
    });

    const hydrated = await engagementsRepository.findEngagementWithMilestones(engagementId);
    expect(hydrated).toBeDefined();
    expect(hydrated?.milestones.map((m) => m.title)).toEqual(['A', 'B']); // sort_order asc, soft-deleted gone
    // The engagementFactory expert is a freelancer → agency is null; user present.
    expect(hydrated?.expertProfile.user).toBeDefined();
    expect(hydrated?.expertProfile.agency).toBeNull();
  });

  it('agency expert → expertProfile.agency name is present', async () => {
    const [agency] = await db.insert(agencies).values({ name: 'Cloud Consulting Co' }).returning();
    if (agency === undefined) throw new Error('agency insert failed');
    const expert = await expertDraftFactory({ type: 'agency' });
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, expert.id));

    const { engagement } = await engagementFactory({ expertProfileId: expert.id });
    const hydrated = await engagementsRepository.findEngagementWithMilestones(engagement.id);
    expect(hydrated?.expertProfile.agency?.name).toBe('Cloud Consulting Co');
    expect(hydrated?.expertProfile.agency?.logoUrl).toBeDefined(); // null is fine — key present, projected
    // SECURITY (BAL-330 review): the projected shape must NOT leak secrets/PII.
    expect(hydrated?.expertProfile).not.toHaveProperty('stripeConnectId');
    expect(hydrated?.expertProfile.agency).not.toHaveProperty('stripeConnectId');
    expect(hydrated?.expertProfile.user).not.toHaveProperty('workosId');
    expect(hydrated?.expertProfile.user).not.toHaveProperty('email');
    expect(hydrated?.expertProfile.user).not.toHaveProperty('phone');
    // The person display name IS present (party-aware copy needs it).
    expect(hydrated?.expertProfile.user).toHaveProperty('firstName');
  });

  it('returns undefined for a missing/soft-deleted engagement', async () => {
    const { engagement } = await engagementFactory();
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));
    expect(await engagementsRepository.findEngagementWithMilestones(engagement.id)).toBeUndefined();
    expect(await engagementsRepository.findEngagementWithMilestones(randomUUID())).toBeUndefined();
  });
});

describe('engagementsRepository.listActiveWithProgress', () => {
  it('derives counts + lastActivityAt; excludes non-active engagements and soft-deleted milestones; scoped by company', async () => {
    const companyId = await seedCompanyId();
    const expertA = await expertDraftFactory();
    const { engagement: e1 } = await engagementFactory({
      companyId,
      expertProfileId: expertA.id,
    });

    const t2 = new Date('2026-02-02T00:00:00.000Z');
    const t3 = new Date('2026-03-03T00:00:00.000Z');
    await engagementMilestoneFactory({
      engagementId: e1.id,
      values: { status: 'completed', sortOrder: 0, completedAt: t3 },
    });
    await engagementMilestoneFactory({
      engagementId: e1.id,
      values: { status: 'in_progress', sortOrder: 1, startedAt: t2 },
    });
    await engagementMilestoneFactory({
      engagementId: e1.id,
      values: { status: 'pending', sortOrder: 2 },
    });
    // Soft-deleted milestone must NOT count.
    await engagementMilestoneFactory({
      engagementId: e1.id,
      values: { status: 'completed', sortOrder: 3, completedAt: new Date(), deletedAt: new Date() },
    });

    // A second active engagement with zero milestones → lastActivityAt falls back.
    const { engagement: e2 } = await engagementFactory({ companyId });
    // A completed engagement must be excluded.
    await engagementFactory({ companyId, values: { status: 'completed' } });

    const rows = await engagementsRepository.listActiveWithProgress({ companyId });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(e1.id);
    expect(ids).toContain(e2.id);
    expect(rows).toHaveLength(2); // completed engagement excluded

    const r1 = rows.find((r) => r.id === e1.id);
    expect(r1?.totalMilestones).toBe(3); // soft-deleted excluded
    expect(r1?.completedMilestones).toBe(1);
    expect(r1?.inProgressMilestones).toBe(1);
    expect(r1?.lastActivityAt?.getTime()).toBe(t3.getTime()); // MAX(GREATEST(started, completed))

    const r2 = rows.find((r) => r.id === e2.id);
    expect(r2?.totalMilestones).toBe(0);
    expect(r2?.lastActivityAt).toBeInstanceOf(Date); // fallback to activated_at/created_at
  });

  it('scopes by expert and excludes another expert’s engagement', async () => {
    const companyId = await seedCompanyId();
    const expertA = await expertDraftFactory();
    const expertB = await expertDraftFactory();
    const { engagement: mine } = await engagementFactory({
      companyId,
      expertProfileId: expertA.id,
    });
    await engagementFactory({ companyId, expertProfileId: expertB.id });

    const rows = await engagementsRepository.listActiveWithProgress({
      expertProfileId: expertA.id,
    });
    expect(rows.map((r) => r.id)).toEqual([mine.id]);
  });
});

describe('engagementsRepository.listPortfolioEngagements', () => {
  it('returns ALL four non-deleted statuses for one company', async () => {
    const companyId = await seedCompanyId();
    const statuses = ['active', 'pending_acceptance', 'completed', 'cancelled'] as const;
    for (const status of statuses) {
      await engagementFactory({ companyId, values: { status } });
    }

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(statuses));
  });

  it('excludes soft-deleted engagements', async () => {
    const companyId = await seedCompanyId();
    const live = await engagementFactory({ companyId });
    const gone = await engagementFactory({ companyId, values: { deletedAt: new Date() } });

    const ids = (await engagementsRepository.listPortfolioEngagements({ companyId })).map(
      (r) => r.id
    );
    expect(ids).toContain(live.engagement.id);
    expect(ids).not.toContain(gone.engagement.id);
  });

  it('scopes by company (company A rows never appear for company B)', async () => {
    const companyA = await seedCompanyId();
    const companyB = await seedCompanyId();
    const a = await engagementFactory({ companyId: companyA });
    const b = await engagementFactory({ companyId: companyB });

    const ids = (await engagementsRepository.listPortfolioEngagements({ companyId: companyB })).map(
      (r) => r.id
    );
    expect(ids).toContain(b.engagement.id);
    expect(ids).not.toContain(a.engagement.id);
  });

  it('scopes by expert (another expert’s engagement is excluded)', async () => {
    const companyId = await seedCompanyId();
    const expertA = await expertDraftFactory();
    const expertB = await expertDraftFactory();
    const mine = await engagementFactory({ companyId, expertProfileId: expertA.id });
    await engagementFactory({ companyId, expertProfileId: expertB.id });

    const rows = await engagementsRepository.listPortfolioEngagements({
      expertProfileId: expertA.id,
    });
    expect(rows.map((r) => r.id)).toEqual([mine.engagement.id]);
  });

  it('platform scope returns engagements spanning ≥2 companies', async () => {
    const companyA = await seedCompanyId();
    const companyB = await seedCompanyId();
    const a = await engagementFactory({ companyId: companyA });
    const b = await engagementFactory({ companyId: companyB });

    const rows = await engagementsRepository.listPortfolioEngagements({ platform: true });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.engagement.id);
    expect(ids).toContain(b.engagement.id);
    expect(new Set(rows.map((r) => r.companyId)).size).toBeGreaterThanOrEqual(2);
  });

  it('derives milestone progress + lastActivityAt = MAX(GREATEST(started, completed))', async () => {
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId });
    const startedAt = new Date('2026-02-02T00:00:00.000Z');
    const latestCompleted = new Date('2026-03-03T00:00:00.000Z');
    const earlierCompleted = new Date('2026-01-01T00:00:00.000Z');
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'completed', sortOrder: 0, completedAt: latestCompleted },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'completed', sortOrder: 1, completedAt: earlierCompleted },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'in_progress', sortOrder: 2, startedAt },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'pending', sortOrder: 3 },
    });

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.totalMilestones).toBe(4);
    expect(row?.completedMilestones).toBe(2);
    expect(row?.inProgressMilestones).toBe(1);
    expect(row?.lastActivityAt?.getTime()).toBe(latestCompleted.getTime());
  });

  it('zero-milestone (retainer) → total 0, lastActivityAt falls back to activatedAt', async () => {
    const companyId = await seedCompanyId();
    const activatedAt = new Date('2026-01-15T00:00:00.000Z');
    const { engagement } = await engagementFactory({ companyId, values: { activatedAt } });

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.totalMilestones).toBe(0);
    expect(row?.lastActivityAt?.getTime()).toBe(activatedAt.getTime());
  });

  it('hydrates a freelancer counterpart (agency null, person + company names present)', async () => {
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId });

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.expertProfile.type).toBe('freelancer');
    expect(row?.expertProfile.agency).toBeNull();
    expect(typeof row?.expertProfile.user.firstName).toBe('string');
    expect(row?.company.name).toBeDefined();
  });

  it('hydrates an agency counterpart (agency name present)', async () => {
    const [agency] = await db.insert(agencies).values({ name: 'Cloud Consulting Co' }).returning();
    if (agency === undefined) throw new Error('agency insert failed');
    const expert = await expertDraftFactory({ type: 'agency' });
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, expert.id));
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId, expertProfileId: expert.id });

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.expertProfile.agency?.name).toBe('Cloud Consulting Co');
  });

  it('hydrates the projectRequest title (source proposal) and null for a retainer', async () => {
    const withRequest = await engagementFactory({ withSourceProposal: true });
    const retainer = await engagementFactory({ companyId: withRequest.companyId });

    const rows = await engagementsRepository.listPortfolioEngagements({
      companyId: withRequest.companyId,
    });
    const requestRow = rows.find((r) => r.id === withRequest.engagement.id);
    const retainerRow = rows.find((r) => r.id === retainer.engagement.id);
    expect(typeof requestRow?.projectRequest?.title).toBe('string');
    expect(retainerRow?.projectRequest).toBeNull();
  });

  it('projects ONLY the allow-listed columns — never secrets/PII', async () => {
    const [agency] = await db.insert(agencies).values({ name: 'Redshift Partners' }).returning();
    if (agency === undefined) throw new Error('agency insert failed');
    const expert = await expertDraftFactory({ type: 'agency' });
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, expert.id));
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId, expertProfileId: expert.id });

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    if (row === undefined) throw new Error('expected the seeded engagement row');

    // The expertProfile graph carries ONLY the allow-listed keys.
    expect(new Set(Object.keys(row.expertProfile))).toEqual(
      new Set(['id', 'agencyId', 'type', 'user', 'agency'])
    );
    expect(row.expertProfile.user).not.toHaveProperty('workosId');
    expect(row.expertProfile.user).not.toHaveProperty('email');
    expect(row.expertProfile.user).not.toHaveProperty('phone');
    expect(row.expertProfile).not.toHaveProperty('stripeConnectId');
    expect(row.expertProfile.agency).not.toHaveProperty('stripeConnectId');
    expect(row.company).not.toHaveProperty('stripeConnectId');
  });

  it('orders by lastActivityAt desc', async () => {
    const companyId = await seedCompanyId();
    const older = await engagementFactory({
      companyId,
      values: { activatedAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const newer = await engagementFactory({
      companyId,
      values: { activatedAt: new Date('2026-05-01T00:00:00.000Z') },
    });

    const rows = await engagementsRepository.listPortfolioEngagements({ companyId });
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(newer.engagement.id)).toBeLessThan(ids.indexOf(older.engagement.id));
  });

  it('listActiveWithProgress stays behaviour-preserving after the aggregate extraction', async () => {
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId });
    const completedAt = new Date('2026-04-04T00:00:00.000Z');
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'completed', sortOrder: 0, completedAt },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'in_progress', sortOrder: 1 },
    });

    const rows = await engagementsRepository.listActiveWithProgress({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.totalMilestones).toBe(2);
    expect(row?.completedMilestones).toBe(1);
    expect(row?.inProgressMilestones).toBe(1);
    expect(row?.lastActivityAt?.getTime()).toBe(completedAt.getTime());
  });
});

describe('engagementsRepository.listPendingAutoAccept', () => {
  it('returns only pending_acceptance with completion_requested_at <= cutoff, oldest first; excludes others + soft-deleted', async () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    const fiveDaysAgo = new Date(now.getTime() - 5 * 86_400_000);
    const inFuture = new Date(now.getTime() + 86_400_000);

    const oldest = await seedPendingAcceptanceEngagement({ completionRequestedAt: tenDaysAgo });
    const newer = await seedPendingAcceptanceEngagement({ completionRequestedAt: fiveDaysAgo });
    // Past-cutoff (requested in the future) → excluded.
    await seedPendingAcceptanceEngagement({ completionRequestedAt: inFuture });
    // Active engagement → excluded.
    await seedActiveEngagement();
    // Soft-deleted pending_acceptance → excluded.
    const deleted = await seedPendingAcceptanceEngagement({ completionRequestedAt: tenDaysAgo });
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, deleted.engagementId));

    const rows = await engagementsRepository.listPendingAutoAccept(now);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(oldest.engagementId);
    expect(ids).toContain(newer.engagementId);
    expect(ids).not.toContain(deleted.engagementId);
    // Oldest completion_requested_at first.
    expect(ids.indexOf(oldest.engagementId)).toBeLessThan(ids.indexOf(newer.engagementId));
    // Every returned row is pending_acceptance and within cutoff.
    rows.forEach((r) => {
      expect(r.status).toBe('pending_acceptance');
      expect(r.completionRequestedAt?.getTime()).toBeLessThanOrEqual(now.getTime());
    });
  });
});
