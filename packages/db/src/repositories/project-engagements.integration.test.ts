import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  auditEvents,
  companies,
  conversations,
  engagements,
  expertProfiles,
  projectEngagements,
  projectRequests,
  proposalMilestones,
  proposals,
  requestExpertRelationships,
  type AuditEvent,
} from '../schema';
import {
  caseEngagementFactory,
  engagementFactory,
  engagementMilestoneFactory,
  expertDraftFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
  proposalFactory,
  reviewFactory,
  userFactory,
} from '../test/factories';
import type { ProposalFactoryResult } from '../test/factories';
import { softDeleteEngagementFixture } from '../test/helpers/soft-delete-engagement';
import { expectCheckViolation } from '../test/helpers/expect-check-violation';
import { engagementsRepository } from './engagements';
import {
  projectEngagementsRepository,
  KickoffGatesIncompleteError,
  InvalidEngagementTransitionError,
  MilestonesIncompleteError,
} from './project-engagements';
import {
  projectDeliveryToEngagementStatus,
  EngagementTypeMismatchError,
} from './_shared/engagement-supertype';
import { EngagementTermsCoherenceError } from './proposal-coherence';
import { projectRequestsRepository, InvalidStatusTransitionError } from './project-requests';
import { conversationsRepository } from './conversations';
// BAL-431 (Ruling 2) — award closure, asserted directly for the idempotence property that a
// replayed kickoff cannot reach (the status guard rejects first).
import { markNotSelectedByAward } from './request-expert-relationships';

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

/** Live PARENT rows for a company — replaces the deleted `listByCompany` in rollback proofs. */
async function liveEngagementRowsForCompany(companyId: string) {
  return db
    .select()
    .from(engagements)
    .where(and(eq(engagements.companyId, companyId), isNull(engagements.deletedAt)));
}

/** Live CHILD rows for a company — the second half of every two-table rollback proof. */
async function liveProjectChildRowsForCompany(companyId: string) {
  return db
    .select({ engagementId: projectEngagements.engagementId })
    .from(projectEngagements)
    .innerJoin(engagements, eq(engagements.id, projectEngagements.engagementId))
    .where(and(eq(engagements.companyId, companyId), isNull(projectEngagements.deletedAt)));
}

/**
 * THE §1.6.1 PROJECTION INVARIANT, asserted after every transition:
 * `engagements.status === projectDeliveryToEngagementStatus(project_engagements.delivery_status)`.
 * The two columns drifting is R5, and this is the only thing that catches it.
 */
async function expectProjectionCoherent(engagementId: string): Promise<void> {
  const [parent] = await db
    .select({ status: engagements.status })
    .from(engagements)
    .where(eq(engagements.id, engagementId));
  const [child] = await db
    .select({ deliveryStatus: projectEngagements.deliveryStatus })
    .from(projectEngagements)
    .where(eq(projectEngagements.engagementId, engagementId));
  if (child === undefined) throw new Error('expected a project child row');
  expect(parent?.status).toBe(projectDeliveryToEngagementStatus(child.deliveryStatus));
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

describe('projectEngagementsRepository.create — the seam proof', () => {
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
    // baloFeeBps falls through to the column default when the factory omits it.
    expect(engagement.baloFeeBps).toBe(2500); // default
    expect(engagement.billingModel).toBe('proposal'); // default
    expect(engagement.approvalModel).toBe('admin_invoice'); // default
    expect(engagement.status).toBe('active'); // default
    expect(engagement.activatedAt).toBeInstanceOf(Date);

    // BAL-417: BOTH rows exist and the parent carries the discriminator.
    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.engagementType).toBe('project');
    const [child] = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagement.id));
    expect(child?.engagementType).toBe('project');
    expect(child?.deliveryStatus).toBe('active');
    await expectProjectionCoherent(engagement.id);
  });

  /**
   * BAL-424 — the seam writer must PROVISION THE DELIVERY THREAD, exactly as
   * `caseEngagementsRepository.create()` does. Without it, an engagement created this way is
   * PERMANENTLY thread-less: the `engagement` arm of the conversation gate resolves the
   * thread with a READ (a gate must not mint rows) and there is no heal path anywhere —
   * `attachContext` runs only on the kickoff CARRY-OVER, which this writer never reaches.
   */
  it('BAL-424: create() provisions an engagement-anchored conversation, with no relationship context', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 400_000,
      baloFeeBps: 2500,
    });

    const conversation = await conversationsRepository.findByContext({
      contextType: 'engagement',
      contextId: engagement.id,
    });
    expect(conversation).toBeDefined();

    // ONE context, and it is the engagement — this engagement has no relationship at all.
    const contexts = await conversationsRepository.listContexts(conversation!.id);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.contextType).toBe('engagement');
    expect(contexts[0]?.contextId).toBe(engagement.id);
  });

  /**
   * BAL-424 / NEW-4 — `create()` accepts an OPTIONAL originating relationship and writes it as
   * provenance, so when one is supplied its pre-sales thread must be CARRIED OVER, not
   * shadowed by a second empty one. Unreachable from a live caller today (this seam has none),
   * which is precisely why it is pinned: the retainer / embedded product will take it up.
   */
  it('BAL-424: create() CARRIES OVER the relationship thread when a relationshipId is supplied', async () => {
    const companyId = await seedCompanyId();
    const { relationship, conversationId, expertProfileId } =
      await requestExpertRelationshipFactory();
    const conversationsBefore = await db.select({ id: conversations.id }).from(conversations);

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId,
      relationshipId: relationship.id,
      pricingMethod: 'fixed',
      priceCents: 400_000,
      baloFeeBps: 2500,
    });

    // SAME conversation, reachable from BOTH anchors — no second thread minted.
    const byEngagement = await conversationsRepository.findByContext({
      contextType: 'engagement',
      contextId: engagement.id,
    });
    expect(byEngagement?.id).toBe(conversationId);
    const byRelationship = await conversationsRepository.findByContext({
      contextType: 'relationship',
      contextId: relationship.id,
    });
    expect(byRelationship?.id).toBe(conversationId);

    const conversationsAfter = await db.select({ id: conversations.id }).from(conversations);
    expect(conversationsAfter).toHaveLength(conversationsBefore.length);

    // Two LIVE contexts on one thread; the relationship one is NOT removed.
    const contexts = await conversationsRepository.listContexts(conversationId);
    expect(contexts.map((c) => c.contextType).sort()).toEqual(['engagement', 'relationship']);
  });

  it('creates WITHOUT a proposal (the retainer seam): only company + expert + terms → row created', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'tm',
      priceCents: 250_000,
      baloFeeBps: 3000, // NON-default → proves create() snapshots the passed value
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
    expect(engagement.baloFeeBps).toBe(3000); // snapshotted, not the default
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
    // The provenance now lives on the CHILD row.
    const [survivorChild] = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagement.id));
    expect(survivorChild?.sourceProposalId).toBeNull();
  });
});

describe('engagement_balo_fee_bps_case_null — the NULLABLE-FOR-CASES invariant (project side)', () => {
  // The CASE half of the truth table lives in `case-engagements.integration.test.ts`.
  // These are the PROJECT rows of it, plus the raw-write backstop that makes the
  // constraint STRICTLY STRONGER than the `NOT NULL` it replaced.

  it('(a) a project engagement created WITH a fee round-trips it (raw parent column, not just the fold)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 400_000,
      baloFeeBps: 3000,
    });

    expect(engagement.baloFeeBps).toBe(3000);
    const [parent] = await db
      .select({ baloFeeBps: engagements.baloFeeBps })
      .from(engagements)
      .where(eq(engagements.id, engagement.id));
    expect(parent?.baloFeeBps).toBe(3000);

    // The hydrated workspace graph narrows `number | null` → `number` in
    // `foldWorkspaceRow`; prove the value survives that guard rather than being
    // replaced by it.
    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.baloFeeBps).toBe(3000);
  });

  it('(d) a project engagement created WITHOUT a fee still works via the column DEFAULT', async () => {
    // The seam writer types `baloFeeBps` OPTIONAL for the retainer/embedded product,
    // which has no proposal to snapshot from. Keeping the DEFAULT (rather than dropping
    // it alongside NOT NULL) is what keeps that path working.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 100_000,
    });

    expect(engagement.baloFeeBps).toBe(2500);
    const [parent] = await db
      .select({ baloFeeBps: engagements.baloFeeBps })
      .from(engagements)
      .where(eq(engagements.id, engagement.id));
    expect(parent?.baloFeeBps).toBe(2500);
  });

  it('a raw NON-case INSERT with a NULL fee is REJECTED (23514) — NOT NULL semantics survive', async () => {
    // The direction that proves the biconditional is STRICTLY STRONGER than `NOT NULL`
    // rather than a relaxation of it: every non-case type still cannot store NULL.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    for (const type of ['project', 'package', 'retainer'] as const) {
      await expectCheckViolation(sql`
        INSERT INTO engagements (engagement_type, company_id, expert_profile_id, balo_fee_bps)
        VALUES (${type}, ${companyId}::uuid, ${expert.id}::uuid, NULL)
      `);
    }

    // …and a raw UPDATE nulling a LIVE project's fee is rejected too.
    const { engagement } = await engagementFactory();
    await expectCheckViolation(sql`
      UPDATE engagements SET balo_fee_bps = NULL WHERE id = ${engagement.id}::uuid
    `);
  });

  it('engagement_balo_fee_bps_range still bites on a NON-NULL out-of-range fee', async () => {
    // The range CHECK evaluates to NULL on a case row (Postgres treats that as
    // satisfied) — the BENIGN direction, and the only reason a case insert is possible.
    // It must still constrain a value that DOES exist; a `COALESCE` / `IS NOT DISTINCT
    // FROM` "fix" would break every case insert, and deleting the CHECK would let an
    // out-of-range project fee through. Both regressions are caught here.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    for (const bps of [-1, 10_001]) {
      await expectCheckViolation(sql`
        INSERT INTO engagements (engagement_type, company_id, expert_profile_id, balo_fee_bps)
        VALUES ('project', ${companyId}::uuid, ${expert.id}::uuid, ${bps})
      `);
    }
  });
});

describe('engagement.created audit — the project creation paths (BAL-417 post-review)', () => {
  it('the seam writer emits exactly one engagement.created with engagement_type=project', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 100_000,
    });

    const createdEvents = (await auditEventsForEntity(engagement.id)).filter(
      (e) => e.action === 'engagement.created'
    );
    expect(createdEvents).toHaveLength(1);
    const [createdEvent] = createdEvents;
    expect(createdEvent?.entityType).toBe('engagement');
    expect(createdEvent?.entityId).toBe(engagement.id);
    // The DISCRIMINATOR — `engagement.created` is deliberately type-agnostic, so this is
    // the only thing separating a Project creation from a Case creation downstream.
    expect(createdEvent?.metadata).toMatchObject({
      engagement_type: 'project',
      engagementId: engagement.id,
    });
    // ADR-1030 system-actor exemption: this seam writer has no live caller and no human
    // actor to name, so the row is UNATTRIBUTED rather than fabricated.
    expect(createdEvent?.actorUserId).toBeNull();
  });

  it('the seam writer attributes engagement.created when an actor is supplied', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const actor = await userFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 100_000,
      actorUserId: actor.id,
    });

    const [createdEvent] = (await auditEventsForEntity(engagement.id)).filter(
      (e) => e.action === 'engagement.created'
    );
    expect(createdEvent?.actorUserId).toBe(actor.id);
  });

  it('materializeFromKickoff emits exactly one engagement.created, attributed to the approving admin, BEFORE the snapshot', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({
      bothGates: true,
      milestoneCount: 2,
    });

    const { engagement } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 300_000,
      baloFeeBps: 2500,
    });

    const events = await auditEventsForEntity(engagement.id);
    const createdEvents = events.filter((e) => e.action === 'engagement.created');
    expect(createdEvents).toHaveLength(1);
    const [createdEvent] = createdEvents;
    expect(createdEvent?.entityType).toBe('engagement');
    // This path HAS a human actor (the admin approving kickoff), so no ADR-1030
    // exemption is taken — the row is attributed.
    expect(createdEvent?.actorUserId).toBe(adminId);
    expect(createdEvent?.metadata).toMatchObject({
      engagement_type: 'project',
      engagementId: engagement.id,
    });

    // Both audit rows are written, and BOTH are attributed to this engagement.
    //
    // ⚠ DO NOT assert their relative ORDER. It is not recoverable from `audit_events`:
    // `created_at` is `defaultNow()`, which in Postgres is TRANSACTION START time, so
    // two rows written in one transaction carry an IDENTICAL timestamp — and the
    // tiebreaker `id` is `defaultRandom()`, not a sequence. `(created_at, id)` order is
    // therefore a coin flip per run, not insertion order. An earlier revision of this
    // test asserted creation-before-snapshot and passed locally purely by luck before
    // failing in CI. Ordering the delivery trail would need a monotonic column on
    // `audit_events` (BAL-344's table, shared by every feature) — out of scope here.
    const actions = events.map((e) => e.action);
    expect(actions).toContain('engagement.created');
    expect(actions).toContain('engagement.milestones_snapshotted');
  });
});

describe('projectEngagementsRepository.create — FK / CHECK constraints', () => {
  it('throws (FK 23503) for an unknown companyId', async () => {
    const expert = await expertDraftFactory();
    await expect(
      projectEngagementsRepository.create({
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
      projectEngagementsRepository.create({
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
      projectEngagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'fixed',
        priceCents: -1,
      })
    ).rejects.toThrow();

    await expect(
      projectEngagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 1000,
        depositCents: -1,
      })
    ).rejects.toThrow();

    await expect(
      projectEngagementsRepository.create({
        companyId,
        expertProfileId: expert.id,
        pricingMethod: 'tm',
        priceCents: 1000,
        rateCents: -1,
      })
    ).rejects.toThrow();
  });
});

describe('engagements balo_fee_bps CHECK constraint (engagement_balo_fee_bps_range)', () => {
  it('rejects a fee below the range (-1) with a 23514', async () => {
    await expect(engagementFactory({ values: { baloFeeBps: -1 } })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rejects a fee above the range (10001) with a 23514', async () => {
    await expect(engagementFactory({ values: { baloFeeBps: 10_001 } })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('accepts the lower bound (0)', async () => {
    const { engagement } = await engagementFactory({ values: { baloFeeBps: 0 } });
    expect(engagement.baloFeeBps).toBe(0);
  });

  it('accepts the upper bound (10000)', async () => {
    const { engagement } = await engagementFactory({ values: { baloFeeBps: 10_000 } });
    expect(engagement.baloFeeBps).toBe(10_000);
  });
});

describe('project_engagement_request_unique_idx — at most one live engagement per request', () => {
  it('rejects a SECOND live engagement for the same project_request_id (partial unique 23505)', async () => {
    const { engagement, companyId, expertProfileId } = await engagementFactory({
      withSourceProposal: true,
    });
    const requestId = engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');

    await expect(
      projectEngagementsRepository.create({
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

    await softDeleteEngagementFixture(engagement.id);

    // The unique index ignores the soft-deleted row → re-creation succeeds.
    const replacement = await projectEngagementsRepository.create({
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

    const r1 = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expertA.id,
      pricingMethod: 'tm',
      priceCents: 1000,
      rateCents: 18_000,
      cadence: 'monthly',
    });
    const r2 = await projectEngagementsRepository.create({
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

describe('engagementsRepository.findById — the SUPERTYPE point read', () => {
  it('returns a live engagement and excludes soft-deleted', async () => {
    const { engagement } = await engagementFactory();

    expect((await engagementsRepository.findById(engagement.id))?.id).toBe(engagement.id);

    await softDeleteEngagementFixture(engagement.id);
    expect(await engagementsRepository.findById(engagement.id)).toBeUndefined();
  });

  it('returns the small type-agnostic row — no commercial terms, no delivery lifecycle', async () => {
    const { engagement } = await engagementFactory();
    const row = await engagementsRepository.findById(engagement.id);
    expect(row?.engagementType).toBe('project');
    expect(row).not.toHaveProperty('pricingMethod');
    expect(row).not.toHaveProperty('priceCents');
    expect(row).not.toHaveProperty('completionRequestedAt');
    expect(row).not.toHaveProperty('projectRequestId');
  });
});

describe('projectEngagementsRepository.findIdByProjectRequestId (BAL-331 deep-link)', () => {
  it('returns the live engagement id for a request that has one', async () => {
    const { engagement } = await engagementFactory({ withSourceProposal: true });
    const requestId = engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');

    expect(await projectEngagementsRepository.findIdByProjectRequestId(requestId)).toBe(
      engagement.id
    );
  });

  it('returns undefined for a request with no engagement (and for an unknown request id)', async () => {
    const request = await projectRequestFactory();
    expect(await projectEngagementsRepository.findIdByProjectRequestId(request.id)).toBeUndefined();
    expect(
      await projectEngagementsRepository.findIdByProjectRequestId(randomUUID())
    ).toBeUndefined();
  });

  it('returns undefined when the only engagement for the request is soft-deleted', async () => {
    const { engagement } = await engagementFactory({ withSourceProposal: true });
    const requestId = engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');

    await softDeleteEngagementFixture(engagement.id);

    expect(await projectEngagementsRepository.findIdByProjectRequestId(requestId)).toBeUndefined();
  });

  it('returns the LIVE id when a soft-deleted engagement co-exists for the same request', async () => {
    const { engagement, companyId, expertProfileId } = await engagementFactory({
      withSourceProposal: true,
    });
    const requestId = engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');

    // Soft-delete the original, then re-create a live one for the same request
    // (the partial unique index permits this).
    await softDeleteEngagementFixture(engagement.id);
    const replacement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId,
      projectRequestId: requestId,
      pricingMethod: 'fixed',
      priceCents: 2000,
    });

    const found = await projectEngagementsRepository.findIdByProjectRequestId(requestId);
    expect(found).toBe(replacement.id);
    expect(found).not.toBe(engagement.id);
  });
});

describe('projectEngagementsRepository.materializeFromKickoff — accept→approve writer', () => {
  it('happy path: advances the request to kickoff_approved AND materialises the engagement with snapshotted terms', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const { engagement, request } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'tm',
      priceCents: 250_000,
      baloFeeBps: 3000, // NON-default → proves the fee is snapshotted, not defaulted
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
    expect(engagement.baloFeeBps).toBe(3000); // snapshotted from the passed value
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

  it('BAL-424 carry-over: the relationship thread gains an engagement context, keeps the relationship one, and no second conversation is minted', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const before = await conversationsRepository.findByContext({
      contextType: 'relationship',
      contextId: source.relationshipId,
    });
    if (before === undefined) throw new Error('expected the relationship to have a thread');
    const conversationsBefore = await db.select({ id: conversations.id }).from(conversations);

    const { engagement } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 500_000,
      baloFeeBps: 2500,
    });

    // SAME conversation, reachable from BOTH anchors.
    const byEngagement = await conversationsRepository.findByContext({
      contextType: 'engagement',
      contextId: engagement.id,
    });
    expect(byEngagement?.id).toBe(before.id);
    const byRelationship = await conversationsRepository.findByContext({
      contextType: 'relationship',
      contextId: source.relationshipId,
    });
    expect(byRelationship?.id).toBe(before.id);

    // Two LIVE contexts on one thread — the relationship one is NOT removed.
    const contexts = await conversationsRepository.listContexts(before.id);
    expect(contexts.map((c) => c.contextType).sort()).toEqual(['engagement', 'relationship']);

    // No second, empty thread was minted.
    const conversationsAfter = await db.select({ id: conversations.id }).from(conversations);
    expect(conversationsAfter).toHaveLength(conversationsBefore.length);
  });

  it('BAL-424 defensive arm: a relationship with NO conversation still kicks off, minting one for the engagement', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    // Simulate a pre-BAL-424 row: hard-remove the relationship's thread entirely.
    const orphaned = await conversationsRepository.findByContext({
      contextType: 'relationship',
      contextId: source.relationshipId,
    });
    if (orphaned === undefined) throw new Error('expected the relationship to have a thread');
    await db.delete(conversations).where(eq(conversations.id, orphaned.id));

    const { engagement } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 500_000,
      baloFeeBps: 2500,
    });

    const minted = await conversationsRepository.findByContext({
      contextType: 'engagement',
      contextId: engagement.id,
    });
    expect(minted).toBeDefined();
    if (minted === undefined) throw new Error('expected a fresh thread for the engagement');
    const contexts = await conversationsRepository.listContexts(minted.id);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.contextType).toBe('engagement');
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
      baloFeeBps: 2500,
    };

    await projectEngagementsRepository.materializeFromKickoff(args);

    // Second call — the request is now `kickoff_approved`, not `accepted`.
    await expect(projectEngagementsRepository.materializeFromKickoff(args)).rejects.toBeInstanceOf(
      InvalidStatusTransitionError
    );

    // Exactly one engagement was created for this request.
    const rows = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.projectRequestId, source.projectRequestId));
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
      projectEngagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId: request.companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: admin.id,
        pricingMethod: 'fixed',
        priceCents: 500_000,
        baloFeeBps: 2500,
      })
    ).rejects.toBeInstanceOf(KickoffGatesIncompleteError);

    // Request untouched, no engagement.
    const reloaded = await projectRequestsRepository.findById(source.projectRequestId);
    expect(reloaded?.status).toBe('accepted');
    const rows = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.projectRequestId, source.projectRequestId));
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
      projectEngagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId: request.companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: admin.id,
        pricingMethod: 'fixed',
        priceCents: 500_000,
        baloFeeBps: 2500,
      })
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);

    const rows = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.projectRequestId, source.projectRequestId));
    expect(rows).toHaveLength(0);
  });
});

// ── BAL-293: engagement-terms coherence guard (rollback proofs) ──────────────

describe('projectEngagementsRepository.create — coherence guard (BAL-293)', () => {
  it('rejects tm terms missing a rate (tm_missing_rate) and persists nothing', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const err = await projectEngagementsRepository
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

    // NEITHER table holds a row for the company (two-table atomicity).
    expect(await liveEngagementRowsForCompany(companyId)).toHaveLength(0);
    expect(await liveProjectChildRowsForCompany(companyId)).toHaveLength(0);
  });

  it('rejects a negative deposit (deposit_negative) and persists nothing', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const err = await projectEngagementsRepository
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

    expect(await liveEngagementRowsForCompany(companyId)).toHaveLength(0);
    expect(await liveProjectChildRowsForCompany(companyId)).toHaveLength(0);
  });

  it('accepts coherent fixed terms (no installment requirement at the engagement seam)', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();

    const engagement = await projectEngagementsRepository.create({
      companyId,
      expertProfileId: expert.id,
      pricingMethod: 'fixed',
      priceCents: 500_000,
    });
    expect(engagement.pricingMethod).toBe('fixed');
    expect(engagement.priceCents).toBe(500_000);
  });
});

describe('projectEngagementsRepository.materializeFromKickoff — coherence guard (BAL-293)', () => {
  it('rejects incoherent tm terms (missing rate), leaving the request accepted and no engagement', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const err = await projectEngagementsRepository
      .materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: adminId,
        pricingMethod: 'tm',
        priceCents: 250_000,
        baloFeeBps: 2500,
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
      .from(projectEngagements)
      .where(eq(projectEngagements.projectRequestId, source.projectRequestId));
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
 * Seed a `pending_acceptance` project DIRECTLY (bypassing requestCompletion, so the
 * audit trail starts empty) with the completion-request stamps populated.
 *
 * Goes through `engagementFactory({ projectValues: { deliveryStatus } })` so the PARENT
 * status is DERIVED from the child, never hand-set — a fixture must not be able to seed
 * the impossible state the projection invariant forbids.
 */
async function seedPendingAcceptanceEngagement(overrides?: {
  completionRequestedAt?: Date;
}): Promise<{ engagementId: string; userId: string; requesterId: string }> {
  const requester = await userFactory();
  const actor = await userFactory();
  const { engagement } = await engagementFactory({
    projectValues: {
      deliveryStatus: 'pending_acceptance',
      completionRequestedByUserId: requester.id,
      completionRequestedAt: overrides?.completionRequestedAt ?? new Date(),
    },
  });
  return { engagementId: engagement.id, userId: actor.id, requesterId: requester.id };
}

describe('projectEngagementsRepository.materializeFromKickoff — milestone snapshot (BAL-330)', () => {
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

    const { engagement } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 300_000,
      baloFeeBps: 2500,
    });

    const snapshot = await projectEngagementsRepository.listMilestones(engagement.id);
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

    const { engagement } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 300_000,
      baloFeeBps: 2500,
    });

    expect(await projectEngagementsRepository.listMilestones(engagement.id)).toHaveLength(0);
    const events = await auditEventsForEntity(engagement.id);
    const snapshotEvent = events.find((e) => e.action === 'engagement.milestones_snapshotted');
    expect(snapshotEvent?.metadata).toMatchObject({ milestone_count: 0 });
  });
});

describe('projectEngagementsRepository.requestCompletion', () => {
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

    const advanced = await projectEngagementsRepository.requestCompletion({ engagementId, userId });
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
    const advanced = await projectEngagementsRepository.requestCompletion({ engagementId, userId });
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
      projectEngagementsRepository.requestCompletion({ engagementId, userId })
    ).rejects.toBeInstanceOf(MilestonesIncompleteError);

    const reloaded = await projectEngagementsRepository.findWithMilestones(engagementId);
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

    const advanced = await projectEngagementsRepository.requestCompletion({ engagementId, userId });
    expect(advanced.status).toBe('pending_acceptance');
  });

  it('throws InvalidEngagementTransitionError when the engagement is not active', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();
    await expect(
      projectEngagementsRepository.requestCompletion({ engagementId, userId })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('projectEngagementsRepository.withdrawCompletionRequest', () => {
  it('pending_acceptance → active, clears completion stamps + audit', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await projectEngagementsRepository.withdrawCompletionRequest({
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
      projectEngagementsRepository.withdrawCompletionRequest({ engagementId, userId })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('projectEngagementsRepository.acceptCompletion', () => {
  it('client path: → completed, accepted_by=user, acceptance_method=client, actor=user audit', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await projectEngagementsRepository.acceptCompletion({
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

    const advanced = await projectEngagementsRepository.acceptCompletion({
      engagementId,
      method: 'auto',
    });
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
      projectEngagementsRepository.acceptCompletion({ engagementId, method: 'client', userId })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('projectEngagementsRepository.requestChanges', () => {
  it('pending_acceptance → active, stores note + attribution, clears completion stamps, audit {note}', async () => {
    const { engagementId, userId } = await seedPendingAcceptanceEngagement();

    const advanced = await projectEngagementsRepository.requestChanges({
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
      projectEngagementsRepository.requestChanges({ engagementId, userId, note: 'x' })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('projectEngagementsRepository.cancelEngagement', () => {
  it('from ACTIVE → cancelled + reason/attribution + audit', async () => {
    const { engagementId, userId } = await seedActiveEngagement();

    const advanced = await projectEngagementsRepository.cancelEngagement({
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

    const advanced = await projectEngagementsRepository.cancelEngagement({
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
    const { engagement } = await engagementFactory({
      projectValues: { deliveryStatus: 'completed' },
    });
    const user = await userFactory();
    await expect(
      projectEngagementsRepository.cancelEngagement({
        engagementId: engagement.id,
        userId: user.id,
        reason: 'nope',
      })
    ).rejects.toBeInstanceOf(InvalidEngagementTransitionError);
  });
});

describe('engagement transitions — missing engagement (advanceProjectDelivery not-found branch)', () => {
  it('withdrawCompletionRequest on a non-existent engagement throws Error(not found)', async () => {
    const user = await userFactory();
    await expect(
      projectEngagementsRepository.withdrawCompletionRequest({
        engagementId: randomUUID(),
        userId: user.id,
      })
    ).rejects.toThrow(/Engagement not found/);
  });

  it('acceptCompletion (auto) on a non-existent engagement throws Error(not found)', async () => {
    await expect(
      projectEngagementsRepository.acceptCompletion({ engagementId: randomUUID(), method: 'auto' })
    ).rejects.toThrow(/Engagement not found/);
  });

  it('requestChanges on a non-existent engagement throws Error(not found)', async () => {
    const user = await userFactory();
    await expect(
      projectEngagementsRepository.requestChanges({
        engagementId: randomUUID(),
        userId: user.id,
        note: 'x',
      })
    ).rejects.toThrow(/Engagement not found/);
  });
});

describe('projectEngagementsRepository.findWithMilestones', () => {
  it('returns live milestones ordered (soft-deleted excluded) + freelancer agency=null', async () => {
    const { engagementId } = await seedActiveEngagement();
    await engagementMilestoneFactory({ engagementId, values: { title: 'B', sortOrder: 1 } });
    await engagementMilestoneFactory({ engagementId, values: { title: 'A', sortOrder: 0 } });
    await engagementMilestoneFactory({
      engagementId,
      values: { title: 'Gone', sortOrder: 2, deletedAt: new Date() },
    });

    const hydrated = await projectEngagementsRepository.findWithMilestones(engagementId);
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
    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
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
    await softDeleteEngagementFixture(engagement.id);
    expect(await projectEngagementsRepository.findWithMilestones(engagement.id)).toBeUndefined();
    expect(await projectEngagementsRepository.findWithMilestones(randomUUID())).toBeUndefined();
  });
});

describe('projectEngagementsRepository.findWithMilestones — BAL-331 additive projections', () => {
  it('hydrates the client company name and the source request title (PII-safe projections)', async () => {
    const [company] = await db
      .insert(companies)
      .values({ name: 'Northwind Industrial', isPersonal: false })
      .returning();
    if (company === undefined) throw new Error('company insert failed');
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ title: 'Salesforce CPQ rollout' });

    const engagement = await projectEngagementsRepository.create({
      companyId: company.id,
      expertProfileId: expert.id,
      projectRequestId: request.id,
      pricingMethod: 'fixed',
      priceCents: 300_000,
    });

    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.company.name).toBe('Northwind Industrial');
    expect(hydrated?.projectRequest?.title).toBe('Salesforce CPQ rollout');

    // SECURITY: company is projected to {id, name} only — never the client's
    // billing secrets/PII (stripe_customer_id, credit_balance, domain, …).
    expect(hydrated?.company).not.toHaveProperty('stripeCustomerId');
    expect(hydrated?.company).not.toHaveProperty('creditBalance');
    expect(Object.keys(hydrated?.company ?? {}).sort()).toEqual(['id', 'name']);
    // projectRequest carries only {id, title} — not description/budget/timeline.
    expect(hydrated?.projectRequest).not.toHaveProperty('description');
    expect(hydrated?.projectRequest).not.toHaveProperty('budgetMinCents');
    expect(Object.keys(hydrated?.projectRequest ?? {}).sort()).toEqual(['id', 'title']);
  });

  it('projectRequest is null for a retainer-shaped engagement (no project_request_id)', async () => {
    // The default engagementFactory seeds NO origination provenance (the retainer seam).
    const { engagement } = await engagementFactory();
    expect(engagement.projectRequestId).toBeNull();

    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.projectRequest).toBeNull();
  });

  it('acceptedBy / changeRequestedBy are null when unset', async () => {
    const { engagement } = await engagementFactory();
    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.acceptedBy).toBeNull();
    expect(hydrated?.changeRequestedBy).toBeNull();
  });

  it('hydrates acceptedBy / changeRequestedBy client-person names when set (PII-safe)', async () => {
    // D1 ships no write repo for these transitions in the read path, so set the
    // attribution columns directly in the arrange step.
    const acceptor = await userFactory({ firstName: 'Dana', lastName: 'Client' });
    const changeRequester = await userFactory({ firstName: 'Riley', lastName: 'Buyer' });
    const { engagement } = await engagementFactory({
      projectValues: {
        acceptedByUserId: acceptor.id,
        changeRequestedByUserId: changeRequester.id,
      },
    });

    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.acceptedBy?.firstName).toBe('Dana');
    expect(hydrated?.acceptedBy?.lastName).toBe('Client');
    expect(hydrated?.changeRequestedBy?.firstName).toBe('Riley');
    expect(hydrated?.changeRequestedBy?.lastName).toBe('Buyer');

    // SECURITY: each attributed client person is projected to {id, firstName,
    // lastName} only — no workos_id / email / phone leak.
    for (const person of [hydrated?.acceptedBy, hydrated?.changeRequestedBy]) {
      expect(person).not.toHaveProperty('workosId');
      expect(person).not.toHaveProperty('email');
      expect(person).not.toHaveProperty('phone');
      expect(Object.keys(person ?? {}).sort()).toEqual(['firstName', 'id', 'lastName']);
    }
  });
});

describe('projectEngagementsRepository.listPortfolio', () => {
  it('returns ALL four non-deleted statuses for one company', async () => {
    const companyId = await seedCompanyId();
    const statuses = ['active', 'pending_acceptance', 'completed', 'cancelled'] as const;
    for (const deliveryStatus of statuses) {
      await engagementFactory({ companyId, projectValues: { deliveryStatus } });
    }

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
    // The 4-VALUE delivery union must survive the fold — a `{...child, ...parent}`
    // spread would silently pin every in-review project to the coarse 'active'.
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(statuses));
  });

  it('excludes soft-deleted engagements', async () => {
    const companyId = await seedCompanyId();
    const live = await engagementFactory({ companyId });
    const gone = await engagementFactory({ companyId, values: { deletedAt: new Date() } });

    const ids = (await projectEngagementsRepository.listPortfolio({ companyId })).map((r) => r.id);
    expect(ids).toContain(live.engagement.id);
    expect(ids).not.toContain(gone.engagement.id);
  });

  it('scopes by company (company A rows never appear for company B)', async () => {
    const companyA = await seedCompanyId();
    const companyB = await seedCompanyId();
    const a = await engagementFactory({ companyId: companyA });
    const b = await engagementFactory({ companyId: companyB });

    const ids = (await projectEngagementsRepository.listPortfolio({ companyId: companyB })).map(
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

    const rows = await projectEngagementsRepository.listPortfolio({
      expertProfileId: expertA.id,
    });
    expect(rows.map((r) => r.id)).toEqual([mine.engagement.id]);
  });

  it('platform scope returns engagements spanning ≥2 companies', async () => {
    const companyA = await seedCompanyId();
    const companyB = await seedCompanyId();
    const a = await engagementFactory({ companyId: companyA });
    const b = await engagementFactory({ companyId: companyB });

    const rows = await projectEngagementsRepository.listPortfolio({ platform: true });
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

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
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

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.totalMilestones).toBe(0);
    expect(row?.lastActivityAt?.getTime()).toBe(activatedAt.getTime());
  });

  it('hydrates a freelancer counterpart (agency null, person + company names present)', async () => {
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId });

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
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

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.expertProfile.agency?.name).toBe('Cloud Consulting Co');
  });

  it('hydrates the projectRequest title (source proposal) and null for a retainer', async () => {
    const withRequest = await engagementFactory({ withSourceProposal: true });
    const retainer = await engagementFactory({ companyId: withRequest.companyId });

    const rows = await projectEngagementsRepository.listPortfolio({
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

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
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

    const rows = await projectEngagementsRepository.listPortfolio({ companyId });
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(newer.engagement.id)).toBeLessThan(ids.indexOf(older.engagement.id));
  });
});

describe('projectEngagementsRepository.listPendingAutoAccept', () => {
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
    await softDeleteEngagementFixture(deleted.engagementId);

    const rows = await projectEngagementsRepository.listPendingAutoAccept(now);
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

describe('projectEngagementsRepository.listAllWithProgress', () => {
  it('returns engagements of ALL statuses; the { statuses } filter narrows correctly', async () => {
    const companyId = await seedCompanyId();
    const { engagement: active } = await engagementFactory({
      companyId,
      projectValues: { deliveryStatus: 'active' },
    });
    const { engagement: pending } = await engagementFactory({
      companyId,
      projectValues: { deliveryStatus: 'pending_acceptance' },
    });
    const { engagement: completed } = await engagementFactory({
      companyId,
      projectValues: { deliveryStatus: 'completed' },
    });
    const { engagement: cancelled } = await engagementFactory({
      companyId,
      projectValues: { deliveryStatus: 'cancelled' },
    });

    const all = await projectEngagementsRepository.listAllWithProgress();
    const allIds = all.map((r) => r.id);
    expect(allIds).toContain(active.id);
    expect(allIds).toContain(pending.id);
    expect(allIds).toContain(completed.id);
    expect(allIds).toContain(cancelled.id);
    expect(all).toHaveLength(4); // every status, no scoping

    // { statuses } narrows to exactly the requested statuses.
    const completedOnly = await projectEngagementsRepository.listAllWithProgress({
      statuses: ['completed'],
    });
    expect(completedOnly.map((r) => r.id)).toEqual([completed.id]);

    const inFlight = await projectEngagementsRepository.listAllWithProgress({
      statuses: ['active', 'pending_acceptance'],
    });
    const inFlightIds = inFlight.map((r) => r.id);
    expect(inFlightIds).toContain(active.id);
    expect(inFlightIds).toContain(pending.id);
    expect(inFlightIds).not.toContain(completed.id);
    expect(inFlightIds).not.toContain(cancelled.id);
    expect(inFlight).toHaveLength(2);
  });

  it('hydrates parties (company + expert person + agency-or-null) and NEVER leaks secrets/PII', async () => {
    // Independent (freelancer) expert → agency is null; company + user hydrated.
    const [freelanceCo] = await db
      .insert(companies)
      .values({ name: 'Freelance Client Co', isPersonal: true })
      .returning();
    if (freelanceCo === undefined) throw new Error('company insert failed');
    const freelancer = await expertDraftFactory(); // freelancer default
    const { engagement: soloEngagement } = await engagementFactory({
      companyId: freelanceCo.id,
      expertProfileId: freelancer.id,
    });

    // Agency expert → agency object hydrated.
    const [agency] = await db.insert(agencies).values({ name: 'Cloud Consulting Co' }).returning();
    if (agency === undefined) throw new Error('agency insert failed');
    const agencyExpert = await expertDraftFactory({ type: 'agency' });
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, agencyExpert.id));
    const { engagement: agencyEngagement } = await engagementFactory({
      expertProfileId: agencyExpert.id,
    });

    const rows = await projectEngagementsRepository.listAllWithProgress();
    const solo = rows.find((r) => r.id === soloEngagement.id);
    const withAgency = rows.find((r) => r.id === agencyEngagement.id);

    // Company + expert person display fields are hydrated.
    expect(solo?.company.name).toBe('Freelance Client Co');
    expect(solo?.expertProfile.user?.firstName).toBe('Test');
    // Independent expert → agency is null (the caller falls back to the person).
    expect(solo?.expertProfile.agency).toBeNull();
    // Agency expert → agency object present (name + projected logoUrl key).
    expect(withAgency?.expertProfile.agency?.name).toBe('Cloud Consulting Co');
    expect(withAgency?.expertProfile.agency).toHaveProperty('logoUrl');

    // SECURITY (mirrors findEngagementWithMilestones): the projected shape must NOT
    // leak secrets/PII.
    expect(withAgency?.expertProfile).not.toHaveProperty('stripeConnectId');
    expect(withAgency?.expertProfile.agency).not.toHaveProperty('stripeConnectId');
    expect(withAgency?.expertProfile.user).not.toHaveProperty('workosId');
    expect(withAgency?.expertProfile.user).not.toHaveProperty('email');
    expect(withAgency?.expertProfile.user).not.toHaveProperty('phone');
    // The person display name IS present (party-aware copy needs it).
    expect(withAgency?.expertProfile.user).toHaveProperty('firstName');
  });

  it('counts live milestones (soft-deleted excluded); soft-deleted engagements excluded', async () => {
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId });

    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: {
        status: 'completed',
        sortOrder: 0,
        completedAt: new Date('2026-03-03T00:00:00.000Z'),
      },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: {
        status: 'in_progress',
        sortOrder: 1,
        startedAt: new Date('2026-02-02T00:00:00.000Z'),
      },
    });
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'pending', sortOrder: 2 },
    });
    // Soft-deleted milestone must NOT count.
    await engagementMilestoneFactory({
      engagementId: engagement.id,
      values: { status: 'completed', sortOrder: 3, completedAt: new Date(), deletedAt: new Date() },
    });

    // A soft-deleted engagement must be excluded entirely.
    const { engagement: deleted } = await engagementFactory({
      companyId,
      values: { deletedAt: new Date() },
    });

    const rows = await projectEngagementsRepository.listAllWithProgress();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(engagement.id);
    expect(ids).not.toContain(deleted.id);

    const row = rows.find((r) => r.id === engagement.id);
    expect(row?.totalMilestones).toBe(3); // soft-deleted milestone excluded
    expect(row?.completedMilestones).toBe(1);
    expect(row?.inProgressMilestones).toBe(1);
  });

  it('lastActivityAt = MAX(GREATEST(started, completed)) over live milestones, else activated_at', async () => {
    const companyId = await seedCompanyId();

    // Engagement WITH milestone activity → lastActivityAt = max activity (NOT activated_at).
    const activatedEarly = new Date('2026-01-01T00:00:00.000Z');
    const started = new Date('2026-02-02T00:00:00.000Z');
    const completed = new Date('2026-03-03T00:00:00.000Z');
    const { engagement: withActivity } = await engagementFactory({
      companyId,
      values: { activatedAt: activatedEarly },
    });
    await engagementMilestoneFactory({
      engagementId: withActivity.id,
      values: { status: 'in_progress', sortOrder: 0, startedAt: started },
    });
    await engagementMilestoneFactory({
      engagementId: withActivity.id,
      values: { status: 'completed', sortOrder: 1, completedAt: completed },
    });

    // Engagement with NO milestone activity → falls back to activated_at.
    const activatedAt = new Date('2026-04-04T00:00:00.000Z');
    const { engagement: noActivity } = await engagementFactory({
      companyId,
      values: { activatedAt },
    });

    const rows = await projectEngagementsRepository.listAllWithProgress();
    const a = rows.find((r) => r.id === withActivity.id);
    const b = rows.find((r) => r.id === noActivity.id);

    expect(a?.lastActivityAt?.getTime()).toBe(completed.getTime());
    expect(b?.lastActivityAt?.getTime()).toBe(activatedAt.getTime());
  });

  it('orders by lastActivityAt desc', async () => {
    const companyId = await seedCompanyId();
    const { engagement: oldest } = await engagementFactory({
      companyId,
      values: { activatedAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const { engagement: middle } = await engagementFactory({
      companyId,
      values: { activatedAt: new Date('2026-02-01T00:00:00.000Z') },
    });
    const { engagement: newest } = await engagementFactory({
      companyId,
      values: { activatedAt: new Date('2026-03-01T00:00:00.000Z') },
    });

    const ids = (await projectEngagementsRepository.listAllWithProgress()).map((r) => r.id);
    expect(ids.indexOf(newest.id)).toBeLessThan(ids.indexOf(middle.id));
    expect(ids.indexOf(middle.id)).toBeLessThan(ids.indexOf(oldest.id));
  });

  it('hydrates accepted-by / cancelled-by actor NAMES (PII-safe); null on the auto path', async () => {
    const companyId = await seedCompanyId();
    const accepter = await userFactory({ firstName: 'Alice' });
    const canceller = await userFactory({ firstName: 'Bob' });

    // Client-accepted completed engagement → acceptedBy hydrated, method 'client'.
    const { engagement: clientAccepted } = await engagementFactory({
      companyId,
      projectValues: {
        deliveryStatus: 'completed',
        acceptanceMethod: 'client',
        acceptedByUserId: accepter.id,
        acceptedAt: new Date('2026-06-03T00:00:00.000Z'),
      },
    });
    // Auto-accepted completed engagement → acceptedBy is null (no actor).
    const { engagement: autoAccepted } = await engagementFactory({
      companyId,
      projectValues: {
        deliveryStatus: 'completed',
        acceptanceMethod: 'auto',
        acceptedAt: new Date('2026-06-04T00:00:00.000Z'),
      },
    });
    // Cancelled engagement → cancelledBy hydrated.
    const { engagement: cancelled } = await engagementFactory({
      companyId,
      projectValues: {
        deliveryStatus: 'cancelled',
        cancelledByUserId: canceller.id,
        cancelledAt: new Date('2026-05-28T00:00:00.000Z'),
        cancellationReason: 'Scope void.',
      },
    });

    const rows = await projectEngagementsRepository.listAllWithProgress();
    const accepted = rows.find((r) => r.id === clientAccepted.id);
    const auto = rows.find((r) => r.id === autoAccepted.id);
    const cancelledRow = rows.find((r) => r.id === cancelled.id);

    // Client-accepted: actor name + method + role present.
    expect(accepted?.acceptanceMethod).toBe('client');
    expect(accepted?.acceptedBy?.firstName).toBe('Alice');
    // Auto-accepted: no actor.
    expect(auto?.acceptedBy).toBeNull();
    // Cancelled: actor name present.
    expect(cancelledRow?.cancelledBy?.firstName).toBe('Bob');

    // Allow-list: actor rows carry name + platformRole (role is NOT PII — it drives
    // the web attribution rule) and NOTHING else — no email / workosId / phone.
    expect(accepted?.acceptedBy).toHaveProperty('platformRole');
    expect(cancelledRow?.cancelledBy).toHaveProperty('platformRole');
    expect(accepted?.acceptedBy).not.toHaveProperty('email');
    expect(accepted?.acceptedBy).not.toHaveProperty('workosId');
    expect(accepted?.acceptedBy).not.toHaveProperty('phone');
    expect(cancelledRow?.cancelledBy).not.toHaveProperty('email');
    expect(cancelledRow?.cancelledBy).not.toHaveProperty('workosId');
    expect(cancelledRow?.cancelledBy).not.toHaveProperty('phone');
  });
});

// ── BAL-417: the supertype split's NEW acceptance criteria ───────────────────

describe('BAL-417 — the two-table write contract', () => {
  it('materializeFromKickoff writes BOTH rows and the parent carries engagement_type=project', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    const { engagement } = await projectEngagementsRepository.materializeFromKickoff({
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 300_000,
      baloFeeBps: 2500,
    });

    const [parent] = await db.select().from(engagements).where(eq(engagements.id, engagement.id));
    expect(parent?.engagementType).toBe('project');
    expect(parent?.status).toBe('active');
    const [child] = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagement.id));
    expect(child?.deliveryStatus).toBe('active');
    expect(child?.projectRequestId).toBe(source.projectRequestId);
    await expectProjectionCoherent(engagement.id);
  });

  it('a coherence failure in materializeFromKickoff leaves ZERO rows in BOTH tables', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });

    await expect(
      projectEngagementsRepository.materializeFromKickoff({
        requestId: source.projectRequestId,
        companyId,
        expertProfileId: source.expertProfileId,
        sourceProposalId: source.proposal.id,
        relationshipId: source.relationshipId,
        approvingAdminUserId: adminId,
        pricingMethod: 'tm',
        priceCents: 250_000,
        baloFeeBps: 2500,
        // rateCents / cadence omitted → incoherent tm.
      })
    ).rejects.toBeInstanceOf(EngagementTermsCoherenceError);

    expect(await liveEngagementRowsForCompany(companyId)).toHaveLength(0);
    expect(await liveProjectChildRowsForCompany(companyId)).toHaveLength(0);
  });
});

describe('BAL-417 — the status projection invariant (R5)', () => {
  it('holds after every one of the five transitions', async () => {
    // 1. requestCompletion: active → pending_acceptance (parent STAYS active).
    const a = await seedActiveEngagement();
    const requested = await projectEngagementsRepository.requestCompletion({
      engagementId: a.engagementId,
      userId: a.userId,
    });
    expect(requested.status).toBe('pending_acceptance');
    await expectProjectionCoherent(a.engagementId);
    const [afterRequest] = await db
      .select({ status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, a.engagementId));
    // The coarse projection is genuinely coarse — the parent did NOT move.
    expect(afterRequest?.status).toBe('active');

    // 2. withdrawCompletionRequest: pending_acceptance → active.
    const b = await seedPendingAcceptanceEngagement();
    await projectEngagementsRepository.withdrawCompletionRequest({
      engagementId: b.engagementId,
      userId: b.userId,
    });
    await expectProjectionCoherent(b.engagementId);

    // 3. acceptCompletion: pending_acceptance → completed.
    const c = await seedPendingAcceptanceEngagement();
    await projectEngagementsRepository.acceptCompletion({
      engagementId: c.engagementId,
      method: 'client',
      userId: c.userId,
    });
    await expectProjectionCoherent(c.engagementId);

    // 4. requestChanges: pending_acceptance → active.
    const d = await seedPendingAcceptanceEngagement();
    await projectEngagementsRepository.requestChanges({
      engagementId: d.engagementId,
      userId: d.userId,
      note: 'revise',
    });
    await expectProjectionCoherent(d.engagementId);

    // 5. cancelEngagement: active → cancelled.
    const e = await seedActiveEngagement();
    await projectEngagementsRepository.cancelEngagement({
      engagementId: e.engagementId,
      userId: e.userId,
      reason: 'void',
    });
    await expectProjectionCoherent(e.engagementId);
  });

  it('a pending_acceptance project surfaces status=pending_acceptance through ALL THREE read paths', async () => {
    // ⚠ THE SPREAD-ORDER GUARD (R6). `{...child, ...parent}` typechecks perfectly and
    // silently pins every in-review project to the coarse 'active'. Only a runtime
    // assertion catches it — this is that assertion.
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const { engagement } = await engagementFactory({
      companyId,
      expertProfileId: expert.id,
      projectValues: { deliveryStatus: 'pending_acceptance', completionRequestedAt: new Date() },
    });

    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.status).toBe('pending_acceptance');

    for (const scope of [
      { companyId },
      { expertProfileId: expert.id },
      { platform: true } as const,
    ]) {
      const rows = await projectEngagementsRepository.listPortfolio(scope);
      expect(rows.find((r) => r.id === engagement.id)?.status).toBe('pending_acceptance');
    }

    const admin = await projectEngagementsRepository.listAllWithProgress();
    expect(admin.find((r) => r.id === engagement.id)?.status).toBe('pending_acceptance');
  });
});

describe('BAL-417 — D5: the list graphs are type-scoped to projects', () => {
  it('listPortfolio (all three lenses) EXCLUDES a case engagement', async () => {
    const companyId = await seedCompanyId();
    const expert = await expertDraftFactory();
    const { engagement: project } = await engagementFactory({
      companyId,
      expertProfileId: expert.id,
    });
    const { engagement: kase } = await caseEngagementFactory({
      companyId,
      expertProfileId: expert.id,
    });

    for (const scope of [
      { companyId },
      { expertProfileId: expert.id },
      { platform: true } as const,
    ]) {
      const ids = (await projectEngagementsRepository.listPortfolio(scope)).map((r) => r.id);
      expect(ids).toContain(project.id);
      expect(ids).not.toContain(kase.id);
    }
  });

  it('listAllWithProgress EXCLUDES a case engagement', async () => {
    const companyId = await seedCompanyId();
    const { engagement: project } = await engagementFactory({ companyId });
    const { engagement: kase } = await caseEngagementFactory({ companyId });

    const ids = (await projectEngagementsRepository.listAllWithProgress()).map((r) => r.id);
    expect(ids).toContain(project.id);
    expect(ids).not.toContain(kase.id);
  });

  it('listPendingAutoAccept EXCLUDES a case engagement even when its parent is active', async () => {
    const pending = await seedPendingAcceptanceEngagement({
      completionRequestedAt: new Date(Date.now() - 10 * 86_400_000),
    });
    const { engagement: kase } = await caseEngagementFactory();

    const ids = (await projectEngagementsRepository.listPendingAutoAccept(new Date())).map(
      (r) => r.id
    );
    expect(ids).toContain(pending.engagementId);
    expect(ids).not.toContain(kase.id);
  });

  it('findWithMilestones(caseId) returns undefined — the project workspace cannot half-hydrate a case', async () => {
    const { engagement: kase } = await caseEngagementFactory();
    expect(await projectEngagementsRepository.findWithMilestones(kase.id)).toBeUndefined();
  });

  it('requestCompletion(caseId) throws EngagementTypeMismatchError', async () => {
    const { engagement: kase } = await caseEngagementFactory();
    const user = await userFactory();
    await expect(
      projectEngagementsRepository.requestCompletion({ engagementId: kase.id, userId: user.id })
    ).rejects.toBeInstanceOf(EngagementTypeMismatchError);
  });
});

describe('BAL-417 — the consumer-facing ROOT allow-lists are PINNED', () => {
  // ⚠ AN ADDITION TO AN ALLOW-LIST IS COMPILE-INVISIBLE. Both graphs below use explicit
  // `columns:` projections precisely so a Server Action can hand the shape to a client
  // component; widening one (adding `baloFeeBps`, `deletedAt`, `workosId`, an email)
  // changes only an inferred type, so nothing fails — and `not.toHaveProperty('x')`
  // does not catch a leak of some OTHER field. So assert the EXACT root key set.
  //
  // These are the shapes as built today — this PINS them, it does not change them. A
  // future ticket that legitimately needs a new root key updates the list DELIBERATELY,
  // having re-checked the key is safe to ship to a browser.

  it('listPortfolio rows carry exactly the A7 inbox keys — no currency, no baloFeeBps, no deletedAt', async () => {
    const companyId = await seedCompanyId();
    await engagementFactory({ companyId });

    const [row] = await projectEngagementsRepository.listPortfolio({ companyId });
    if (row === undefined) throw new Error('expected a portfolio row');

    expect(Object.keys(row).sort()).toEqual(
      [
        'acceptanceMethod',
        'acceptedAt',
        'activatedAt',
        'changeRequestNote',
        'changeRequestedAt',
        'company',
        'companyId',
        'completedMilestones',
        'completionRequestedAt',
        'createdAt',
        'expertProfile',
        'expertProfileId',
        'id',
        'inProgressMilestones',
        'lastActivityAt',
        'projectRequest',
        'projectRequestId',
        'status',
        'totalMilestones',
        'updatedAt',
      ].sort()
    );
    expect(Object.keys(row.company).sort()).toEqual(['id', 'name'].sort());
    expect(Object.keys(row.expertProfile).sort()).toEqual(
      ['agency', 'agencyId', 'id', 'type', 'user'].sort()
    );
    expect(Object.keys(row.expertProfile.user).sort()).toEqual(
      ['avatarUrl', 'firstName', 'id', 'lastName'].sort()
    );
  });

  it('listAllWithProgress rows carry exactly the admin oversight keys — currency YES, baloFeeBps NO', async () => {
    // The admin row DOES carry `currency` (the oversight pill formats money) but must
    // NOT carry `baloFeeBps` — the oversight row never grosses up.
    const companyId = await seedCompanyId();
    await engagementFactory({ companyId });

    const [row] = await projectEngagementsRepository.listAllWithProgress();
    if (row === undefined) throw new Error('expected an admin oversight row');

    expect(Object.keys(row).sort()).toEqual(
      [
        'acceptanceMethod',
        'acceptedAt',
        'acceptedBy',
        'activatedAt',
        'cancellationReason',
        'cancelledAt',
        'cancelledBy',
        'company',
        'companyId',
        'completedMilestones',
        'completionRequestedAt',
        'createdAt',
        'currency',
        'expertProfile',
        'expertProfileId',
        'id',
        'inProgressMilestones',
        'lastActivityAt',
        'priceCents',
        'pricingMethod',
        'projectRequest',
        'projectRequestId',
        'rateCents',
        'status',
        'totalMilestones',
        'updatedAt',
      ].sort()
    );
    expect(row).not.toHaveProperty('baloFeeBps');
    expect(Object.keys(row.expertProfile).sort()).toEqual(
      ['agency', 'agencyId', 'headline', 'id', 'type', 'user'].sort()
    );
    expect(Object.keys(row.expertProfile.user).sort()).toEqual(
      ['avatarUrl', 'firstName', 'id', 'lastName'].sort()
    );
  });
});

describe('BAL-417 — the flatten guard: a project parent with no child row', () => {
  it('throws "Project engagement child row missing" from findWithMilestones and both list folds', async () => {
    const companyId = await seedCompanyId();
    const { engagement } = await engagementFactory({ companyId });
    // Hard-delete the child OUT OF BAND (only reachable by bypassing the repository).
    await db.delete(projectEngagements).where(eq(projectEngagements.engagementId, engagement.id));

    await expect(projectEngagementsRepository.findWithMilestones(engagement.id)).rejects.toThrow(
      /Project engagement child row missing/
    );
    await expect(projectEngagementsRepository.listPortfolio({ companyId })).rejects.toThrow(
      /Project engagement child row missing/
    );
    await expect(projectEngagementsRepository.listAllWithProgress()).rejects.toThrow(
      /Project engagement child row missing/
    );
  });
});

describe('BAL-417 — the soft-delete MIRROR rule (R3)', () => {
  it('softDeleteEngagementFixture → re-materialising for the same project_request_id SUCCEEDS', async () => {
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
      baloFeeBps: 2500,
    };

    const first = await projectEngagementsRepository.materializeFromKickoff(args);
    // Both flags stamped in one transaction.
    await softDeleteEngagementFixture(first.engagement.id);
    const [parent] = await db
      .select()
      .from(engagements)
      .where(eq(engagements.id, first.engagement.id));
    const [child] = await db
      .select()
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, first.engagement.id));
    expect(parent?.deletedAt).toBeInstanceOf(Date);
    expect(child?.deletedAt?.getTime()).toBe(parent?.deletedAt?.getTime());

    // Rewind the request so a second materialise is legal, then re-create.
    await db
      .update(projectRequests)
      .set({ status: 'accepted' })
      .where(eq(projectRequests.id, source.projectRequestId));

    const second = await projectEngagementsRepository.materializeFromKickoff(args);
    expect(second.engagement.id).not.toBe(first.engagement.id);
    expect(second.engagement.projectRequestId).toBe(source.projectRequestId);
  });

  it('stamping ONLY engagements.deleted_at → re-materialising fails 23505 (the rule is NOT optional)', async () => {
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
      baloFeeBps: 2500,
    };

    const first = await projectEngagementsRepository.materializeFromKickoff(args);
    // THE WRONG WAY — parent only. The child keeps occupying the partial unique index.
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, first.engagement.id));

    await db
      .update(projectRequests)
      .set({ status: 'accepted' })
      .where(eq(projectRequests.id, source.projectRequestId));

    await expect(projectEngagementsRepository.materializeFromKickoff(args)).rejects.toMatchObject({
      code: '23505',
    });
  });
});

describe('BAL-417 — the workspace root allow-list', () => {
  it('the flattened row does NOT expose deletedAt or engagementType', async () => {
    const { engagement } = await engagementFactory();
    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated).toBeDefined();
    expect(hydrated).not.toHaveProperty('deletedAt');
    expect(hydrated).not.toHaveProperty('engagementType');
    // …but the fields the workspace genuinely grosses up with ARE present.
    expect(hydrated).toHaveProperty('baloFeeBps');
    expect(hydrated).toHaveProperty('currency');
    expect(hydrated).toHaveProperty('priceCents');
  });
});

// ── BAL-390: the PROJECT rating-nudge candidate scan ─────────────────────────

describe('projectEngagementsRepository.listAcceptedBetween', () => {
  const ANCHOR = new Date('2026-08-01T12:00:00.000Z');
  /** The one-hour band whose INCLUSIVE upper edge is exactly `ANCHOR`. */
  const AFTER = new Date(ANCHOR.getTime() - 3_600_000);

  /** Seed an accepted project whose `accepted_at` is exactly `acceptedAt`. */
  async function seedAccepted(acceptedAt: Date) {
    return engagementFactory({
      projectValues: {
        deliveryStatus: 'completed',
        acceptedAt,
        acceptanceMethod: 'auto',
      },
    });
  }

  /** Candidate engagement ids for the canonical band. */
  async function candidateIds(after = AFTER, until = ANCHOR): Promise<string[]> {
    const rows = await projectEngagementsRepository.listAcceptedBetween(after, until);
    return rows.map((row) => row.engagementId);
  }

  it('returns the RatingNudgeCandidate shape for a project accepted inside the band', async () => {
    const seeded = await seedAccepted(ANCHOR);

    const candidates = await projectEngagementsRepository.listAcceptedBetween(AFTER, ANCHOR);
    const found = candidates.find((c) => c.engagementId === seeded.engagement.id);
    if (found === undefined) throw new Error('expected the accepted project to be a candidate');

    expect(found.engagementKind).toBe('project');
    expect(found.companyId).toBe(seeded.companyId);
    expect(found.expertProfileId).toBe(seeded.expertProfileId);
    expect(found.anchorAt.toISOString()).toBe(ANCHOR.toISOString());
    expect(Object.keys(found).sort()).toEqual([
      'anchorAt',
      'companyId',
      'engagementId',
      'engagementKind',
      'expertProfileId',
      'title',
    ]);
    // `closeReason` is the CASE arm's field alone — a project has no close reason, and
    // inventing one would put a specific claim in the +7d nudge on no evidence.
    expect(found.closeReason).toBeUndefined();
  });

  it('is HALF-OPEN: an anchor exactly at `until` is INCLUDED, one exactly at `after` is EXCLUDED', async () => {
    // The invariant that lets two consecutive hourly ticks partition the timeline with
    // neither a duplicate nudge nor a missed one.
    const atUntil = await seedAccepted(ANCHOR);
    const atAfter = await seedAccepted(AFTER);

    const ids = await candidateIds();
    expect(ids).toContain(atUntil.engagement.id);
    expect(ids).not.toContain(atAfter.engagement.id);
  });

  it('excludes an anchor one millisecond past the upper edge and one below the lower edge', async () => {
    const tooNew = await seedAccepted(new Date(ANCHOR.getTime() + 1));
    const tooOld = await seedAccepted(new Date(AFTER.getTime() - 1));

    const ids = await candidateIds();
    expect(ids).not.toContain(tooNew.engagement.id);
    expect(ids).not.toContain(tooOld.engagement.id);
  });

  it('excludes a project that was never accepted (accepted_at IS NULL)', async () => {
    const never = await engagementFactory();
    const ids = await candidateIds(new Date(0), new Date(Date.now() + 86_400_000));
    expect(ids).not.toContain(never.engagement.id);
  });

  it('excludes a SOFT-DELETED engagement (parent and child both stamped)', async () => {
    const seeded = await seedAccepted(ANCHOR);
    await softDeleteEngagementFixture(seeded.engagement.id);

    expect(await candidateIds()).not.toContain(seeded.engagement.id);
  });

  it('excludes a row whose PARENT alone is soft-deleted, and one whose CHILD alone is', async () => {
    // Both guards are asserted separately: one combined check would pass vacuously
    // whenever the fixture happens to stamp both.
    const parentOnly = await seedAccepted(ANCHOR);
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, parentOnly.engagement.id));

    const childOnly = await seedAccepted(ANCHOR);
    await db
      .update(projectEngagements)
      .set({ deletedAt: new Date() })
      .where(eq(projectEngagements.engagementId, childOnly.engagement.id));

    const ids = await candidateIds();
    expect(ids).not.toContain(parentOnly.engagement.id);
    expect(ids).not.toContain(childOnly.engagement.id);
  });

  /**
   * ⚠ THIS PINS CROSS-PERSON SUPPRESSION, RATIFIED 2026-08-06 — read it that way.
   * `reviewFactory` mints its OWN reviewer (a fresh `member`, not the company owner), so
   * this asserts that a review by ANY ONE PERSON removes the engagement for EVERYONE.
   * That is intended: a rating is signal about the expert, and one is enough to have it.
   * If this test ever fails because someone added a `reviewer_user_id` predicate to the
   * candidate query, that is a product re-decision — see `review-nudge-sweep.ts`'s header
   * for the worked Dana/Sam example and the correct way to make the change.
   */
  it('EXCLUDES an engagement rated by ANY member — suppression is engagement-level, not per-reviewer', async () => {
    const seeded = await seedAccepted(ANCHOR);
    // Note: NOT the company owner — a different member entirely.
    await reviewFactory({ engagement: seeded });

    expect(await candidateIds()).not.toContain(seeded.engagement.id);
  });

  it('still returns an engagement whose only review is SOFT-DELETED', async () => {
    const seeded = await seedAccepted(ANCHOR);
    await reviewFactory({ engagement: seeded, values: { deletedAt: new Date() } });

    expect(await candidateIds()).toContain(seeded.engagement.id);
  });

  it('takes the title from the source project request, and falls back when there is none', async () => {
    const withoutRequest = await seedAccepted(ANCHOR);
    const withRequest = await engagementFactory({
      withSourceProposal: true,
      projectValues: {
        deliveryStatus: 'completed',
        acceptedAt: ANCHOR,
        acceptanceMethod: 'auto',
      },
    });
    const requestId = withRequest.engagement.projectRequestId;
    if (requestId === null) throw new Error('expected a seeded projectRequestId');
    const [request] = await db
      .select({ title: projectRequests.title })
      .from(projectRequests)
      .where(eq(projectRequests.id, requestId));

    const candidates = await projectEngagementsRepository.listAcceptedBetween(AFTER, ANCHOR);
    expect(candidates.find((c) => c.engagementId === withoutRequest.engagement.id)?.title).toBe(
      'your project'
    );
    expect(candidates.find((c) => c.engagementId === withRequest.engagement.id)?.title).toBe(
      request?.title
    );
  });

  it('NEVER returns a case engagement — the scan is child-rooted, so it is type-scoped for free', async () => {
    const kase = await caseEngagementFactory({
      caseValues: { closedAt: ANCHOR, closeReason: 'auto_inactive' },
      values: { status: 'completed' },
    });

    expect(await candidateIds()).not.toContain(kase.engagement.id);
  });

  it('orders oldest anchor first and returns [] for an empty band', async () => {
    const older = await seedAccepted(new Date(ANCHOR.getTime() - 1_800_000));
    const newer = await seedAccepted(ANCHOR);

    const ordered = (await candidateIds()).filter(
      (id) => id === older.engagement.id || id === newer.engagement.id
    );
    expect(ordered).toEqual([older.engagement.id, newer.engagement.id]);

    const empty = new Date('2020-01-01T00:00:00.000Z');
    await expect(
      projectEngagementsRepository.listAcceptedBetween(new Date(empty.getTime() - 3_600_000), empty)
    ).resolves.toEqual([]);
  });
});

/**
 * BAL-431 / ADR-1048 §5 (Ruling 2) — AWARD CLOSURE. Closure and lineage fire from ONE hook,
 * `materializeFromKickoff`, inside its existing transaction: a rolled-back kickoff closes
 * nobody. NOT `proposalsRepository.accept` — that path creates no engagement, and a second
 * write site is exactly the "two mechanisms" Ruling 2 forbids.
 */
describe('projectEngagementsRepository.materializeFromKickoff — award closure (BAL-431)', () => {
  /** Add `count` extra LIVE `invited` tracks to an existing request. */
  async function addSiblingTracks(projectRequestId: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const expert = await expertDraftFactory();
      const sibling = await requestExpertRelationshipFactory({
        projectRequestId,
        expertProfileId: expert.id,
      });
      ids.push(sibling.relationship.id);
    }
    return ids;
  }

  async function notSelectedAtFor(relationshipId: string): Promise<Date | null> {
    const [row] = await db
      .select({ notSelectedAt: requestExpertRelationships.notSelectedAt })
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationshipId));
    return row?.notSelectedAt ?? null;
  }

  function kickoffArgs(
    source: ProposalFactoryResult,
    companyId: string,
    adminId: string
  ): Parameters<typeof projectEngagementsRepository.materializeFromKickoff>[0] {
    return {
      requestId: source.projectRequestId,
      companyId,
      expertProfileId: source.expertProfileId,
      sourceProposalId: source.proposal.id,
      relationshipId: source.relationshipId,
      approvingAdminUserId: adminId,
      pricingMethod: 'fixed',
      priceCents: 250_000,
      baloFeeBps: 2500,
    };
  }

  it('stamps not_selected_at on every live non-winner and NEVER on the winner', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });
    const losers = await addSiblingTracks(source.projectRequestId, 2);

    const { closedRelationshipIds } = await projectEngagementsRepository.materializeFromKickoff(
      kickoffArgs(source, companyId, adminId)
    );

    expect(closedRelationshipIds.sort()).toEqual([...losers].sort());
    for (const loser of losers) {
      expect(await notSelectedAtFor(loser)).toBeInstanceOf(Date);
    }
    // ⚠ THE WINNER IS NEVER STAMPED — it is the track the engagement was materialised for.
    expect(await notSelectedAtFor(source.relationshipId)).toBeNull();
  });

  it('closes NOBODY when the kickoff transaction rolls back', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });
    const losers = await addSiblingTracks(source.projectRequestId, 2);

    await expect(
      projectEngagementsRepository.materializeFromKickoff({
        ...kickoffArgs(source, companyId, adminId),
        // Incoherent `tm` terms (no rate) → the coherence guard throws, rolling the whole
        // transaction back. Closure must roll back WITH the lineage it is paired with.
        pricingMethod: 'tm',
      })
    ).rejects.toBeInstanceOf(EngagementTermsCoherenceError);

    for (const loser of losers) {
      expect(await notSelectedAtFor(loser)).toBeNull();
    }
  });

  it('leaves an ALREADY-DECLINED track unstamped, keeping "earliest instant" honest', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });
    const [declined, live] = await addSiblingTracks(source.projectRequestId, 2);
    if (declined === undefined || live === undefined) throw new Error('seed too small');

    await db
      .update(requestExpertRelationships)
      .set({ status: 'declined', declinedAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(requestExpertRelationships.id, declined));

    const { closedRelationshipIds } = await projectEngagementsRepository.materializeFromKickoff(
      kickoffArgs(source, companyId, adminId)
    );

    expect(closedRelationshipIds).toEqual([live]);
    expect(await notSelectedAtFor(declined)).toBeNull();
  });

  it('leaves a WITHDRAWN (soft-deleted) track unstamped', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });
    const [withdrawn] = await addSiblingTracks(source.projectRequestId, 1);
    if (withdrawn === undefined) throw new Error('seed too small');

    await db
      .update(requestExpertRelationships)
      .set({ deletedAt: new Date() })
      .where(eq(requestExpertRelationships.id, withdrawn));

    const { closedRelationshipIds } = await projectEngagementsRepository.materializeFromKickoff(
      kickoffArgs(source, companyId, adminId)
    );

    expect(closedRelationshipIds).toEqual([]);
    expect(await notSelectedAtFor(withdrawn)).toBeNull();
  });

  it('does not touch tracks on ANOTHER request', async () => {
    const { source, companyId, adminId } = await seedAcceptedKickoff({ bothGates: true });
    await addSiblingTracks(source.projectRequestId, 1);
    const foreign = await requestExpertRelationshipFactory();

    await projectEngagementsRepository.materializeFromKickoff(
      kickoffArgs(source, companyId, adminId)
    );

    expect(await notSelectedAtFor(foreign.relationship.id)).toBeNull();
  });

  /**
   * IDEMPOTENCE is asserted on the helper directly: a REPLAYED kickoff cannot reach it (the
   * request is already `kickoff_approved`, so the status guard rejects first). The property
   * that matters is that a second stamp never overwrites the first with a LATER instant —
   * historical-read is an inequality against that instant, so re-stamping would silently
   * WIDEN access.
   */
  it('markNotSelectedByAward is idempotent — a second run never re-stamps a later instant', async () => {
    const { source } = await seedAcceptedKickoff({ bothGates: true });
    const [loser] = await addSiblingTracks(source.projectRequestId, 1);
    if (loser === undefined) throw new Error('seed too small');

    const first = new Date('2026-05-01T00:00:00.000Z');
    const firstRun = await markNotSelectedByAward(db, {
      projectRequestId: source.projectRequestId,
      winningRelationshipId: source.relationshipId,
      at: first,
    });
    expect(firstRun).toEqual([loser]);

    const secondRun = await markNotSelectedByAward(db, {
      projectRequestId: source.projectRequestId,
      winningRelationshipId: source.relationshipId,
      at: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(secondRun).toEqual([]);
    expect(await notSelectedAtFor(loser)).toEqual(first);
  });
});
