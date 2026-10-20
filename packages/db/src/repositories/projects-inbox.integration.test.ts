import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  companyMembers,
  conversationMessages,
  expressionsOfInterest,
  products,
  projectRequestProducts,
  projectRequestTags,
  projectRequests,
  proposalChangeRequests,
  proposalMilestones,
  proposals,
} from '../schema';
import {
  userFactory,
  expertDraftFactory,
  projectRequestFactory,
  projectTagFactory,
  proposalFactory,
  requestExpertRelationshipFactory,
} from '../test/factories';
import { projectsInboxRepository } from './projects-inbox';
import { referenceDataRepository } from './reference-data';

/**
 * Integration coverage for the A7 tri-lens aggregation reads (BAL-274). One real
 * Postgres per file via Testcontainers; each test runs inside a Drizzle
 * transaction that auto-rolls back (no manual cleanup). The whole suite asserts
 * the load-bearing invariants the web view-model relies on: soft-delete exclusion
 * at every leg, company/expert scoping, the declined + soft-deleted-parent
 * exclusions (the reason the expert lens uses a flat join), and the hydrated
 * recency-fold timestamps.
 */

/** Seeds a personal company; returns its id. */
async function seedCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }
  return company.id;
}

/**
 * Seeds a fresh company (with an owner member) + a creator user, returning the FK
 * ids a `project_requests` insert needs. Mirrors `seedActors` in
 * `project-requests.integration.test.ts`.
 */
async function seedCompanyWithCreator(): Promise<{ companyId: string; createdByUserId: string }> {
  const creator = await userFactory();
  const companyId = await seedCompanyId();
  await db.insert(companyMembers).values({ companyId, userId: creator.id, role: 'owner' });
  return { companyId, createdByUserId: creator.id };
}

/**
 * Inserts a `match`-mode request (no target expert) directly under a company.
 * `match` keeps `expertProfileId` null while satisfying the routing CHECK, so a
 * single company can own many requests without needing a distinct expert each.
 */
async function seedCompanyRequest(
  companyId: string,
  createdByUserId: string,
  overrides: { title?: string; status?: 'requested' | 'experts_invited'; deletedAt?: Date } = {}
): Promise<string> {
  const [row] = await db
    .insert(projectRequests)
    .values({
      companyId,
      createdByUserId,
      sendTo: 'match',
      title: overrides.title ?? 'Company request',
      description: '<p>Brief.</p>',
      status: overrides.status ?? 'requested',
      deletedAt: overrides.deletedAt,
    })
    .returning();
  if (row === undefined) {
    throw new Error('project request insert failed');
  }
  return row.id;
}

// ── listByCompany (client lens) ──────────────────────────────────────────

describe('projectsInboxRepository.listByCompany', () => {
  it('returns only the company live requests, excluding soft-deleted and other companies', async () => {
    const { companyId, createdByUserId } = await seedCompanyWithCreator();
    const liveA = await seedCompanyRequest(companyId, createdByUserId, { title: 'Live A' });
    const liveB = await seedCompanyRequest(companyId, createdByUserId, { title: 'Live B' });
    await seedCompanyRequest(companyId, createdByUserId, {
      title: 'Removed',
      deletedAt: new Date(),
    });

    // A different company's live request must not appear.
    const other = await seedCompanyWithCreator();
    const otherReq = await seedCompanyRequest(other.companyId, other.createdByUserId, {
      title: 'Other co request',
    });

    const rows = await projectsInboxRepository.listByCompany(companyId);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(liveA);
    expect(ids).toContain(liveB);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(otherReq);
  });

  it('hydrates company, relationships, and each relationship newest live EOI + message', async () => {
    // A direct request (its own target expert) so a relationship + EOI/message hang
    // off it. projectRequestFactory seeds a `direct` request with a non-null expert.
    const request = await projectRequestFactory({ title: 'Hydration', status: 'experts_invited' });
    if (request.expertProfileId === null) {
      throw new Error('expected a direct request with a target expert');
    }

    const { relationship, conversationId } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });

    const sender = await userFactory();
    const olderMsg = new Date('2026-01-01T00:00:00.000Z');
    const newerMsg = new Date('2026-02-01T00:00:00.000Z');
    const eoiAt = new Date('2026-01-15T00:00:00.000Z');

    await db.insert(expressionsOfInterest).values({
      relationshipId: relationship.id,
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
      message: '<p>The pitch.</p>',
      submittedAt: eoiAt,
    });
    // BAL-424: messages hang off the relationship's CONVERSATION; `queryPortfolioRequests`
    // grafts the newest one back into the same `{ id, createdAt }[]` shape.
    await db.insert(conversationMessages).values([
      {
        conversationId,
        senderUserId: sender.id,
        body: '<p>Old.</p>',
        createdAt: olderMsg,
      },
      {
        conversationId,
        senderUserId: sender.id,
        body: '<p>New.</p>',
        createdAt: newerMsg,
      },
    ]);

    const rows = await projectsInboxRepository.listByCompany(request.companyId);
    const found = rows.find((r) => r.id === request.id);
    expect(found).toBeDefined();
    if (found === undefined) throw new Error('expected the request to hydrate');

    // Top-level + company name.
    expect(found.title).toBe('Hydration');
    expect(found.status).toBe('experts_invited');
    expect(found.company.id).toBe(request.companyId);
    expect(found.company.name).toBeDefined();

    // Relationship + recency-fold timestamps.
    expect(found.relationships).toHaveLength(1);
    const [rel] = found.relationships;
    expect(rel?.id).toBe(relationship.id);
    expect(rel?.status).toBe('invited');
    expect(rel?.invitedAt).toBeInstanceOf(Date);
    expect(rel?.updatedAt).toBeInstanceOf(Date);

    // Newest live EOI (limit 1) + newest live message (limit 1, newest-first).
    expect(rel?.expressionsOfInterest).toHaveLength(1);
    expect(rel?.expressionsOfInterest[0]?.submittedAt.getTime()).toBe(eoiAt.getTime());
    expect(rel?.conversationMessages).toHaveLength(1);
    expect(rel?.conversationMessages[0]?.createdAt.getTime()).toBe(newerMsg.getTime());
  });

  it('excludes a soft-deleted relationship from the hydrated request', async () => {
    const request = await projectRequestFactory();
    if (request.expertProfileId === null) {
      throw new Error('expected a direct request with a target expert');
    }
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
      values: { deletedAt: new Date() },
    });

    const rows = await projectsInboxRepository.listByCompany(request.companyId);
    const found = rows.find((r) => r.id === request.id);
    expect(found?.relationships).toHaveLength(0);
  });

  it('returns [] for a company with no requests', async () => {
    const companyId = await seedCompanyId();
    expect(await projectsInboxRepository.listByCompany(companyId)).toEqual([]);
  });
});

// ── listInvitationsByExpert (expert lens — invitations) ───────────────────

describe('projectsInboxRepository.listInvitationsByExpert', () => {
  it('returns live non-declined relationships joined to live requests, hydrating title + company name', async () => {
    const expert = await expertDraftFactory();

    // Two requests, each with a live invited relationship for this expert.
    const reqA = await projectRequestFactory({ title: 'Project A', status: 'experts_invited' });
    const reqB = await projectRequestFactory({ title: 'Project B', status: 'experts_invited' });
    const { relationship: relA } = await requestExpertRelationshipFactory({
      projectRequestId: reqA.id,
      expertProfileId: expert.id,
    });
    await requestExpertRelationshipFactory({
      projectRequestId: reqB.id,
      expertProfileId: expert.id,
      values: { status: 'eoi_submitted' },
    });

    // A live EOI on reqA so newestEoiAt hydrates.
    const eoiAt = new Date('2026-03-01T00:00:00.000Z');
    await db.insert(expressionsOfInterest).values({
      relationshipId: relA.id,
      projectRequestId: reqA.id,
      expertProfileId: expert.id,
      message: '<p>Pitch.</p>',
      submittedAt: eoiAt,
    });

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    expect(rows).toHaveLength(2);

    const a = rows.find((r) => r.projectRequestId === reqA.id);
    const b = rows.find((r) => r.projectRequestId === reqB.id);
    expect(a?.title).toBe('Project A');
    expect(a?.companyId).toBe(reqA.companyId);
    expect(a?.companyName).toBeDefined();
    expect(a?.relationshipStatus).toBe('invited');
    expect(a?.requestStatus).toBe('experts_invited');
    expect(a?.invitedAt).toBeInstanceOf(Date);
    expect(a?.newestEoiAt?.getTime()).toBe(eoiAt.getTime());

    // reqB has no EOI → null.
    expect(b?.relationshipStatus).toBe('eoi_submitted');
    expect(b?.newestEoiAt).toBeNull();
  });

  it('excludes declined relationships', async () => {
    const expert = await expertDraftFactory();
    const reqLive = await projectRequestFactory({ status: 'experts_invited' });
    const reqDeclined = await projectRequestFactory({ status: 'experts_invited' });
    await requestExpertRelationshipFactory({
      projectRequestId: reqLive.id,
      expertProfileId: expert.id,
    });
    await requestExpertRelationshipFactory({
      projectRequestId: reqDeclined.id,
      expertProfileId: expert.id,
      values: { status: 'declined', declinedAt: new Date() },
    });

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    const requestIds = rows.map((r) => r.projectRequestId);
    expect(requestIds).toContain(reqLive.id);
    expect(requestIds).not.toContain(reqDeclined.id);
  });

  it('excludes a relationship whose parent request is soft-deleted (the reason for the flat join)', async () => {
    const expert = await expertDraftFactory();
    const liveReq = await projectRequestFactory({ status: 'experts_invited' });
    const deletedReq = await projectRequestFactory({ status: 'experts_invited' });

    // A LIVE relationship on each — but one request is soft-deleted.
    await requestExpertRelationshipFactory({
      projectRequestId: liveReq.id,
      expertProfileId: expert.id,
    });
    await requestExpertRelationshipFactory({
      projectRequestId: deletedReq.id,
      expertProfileId: expert.id,
    });
    await db
      .update(projectRequests)
      .set({ deletedAt: new Date() })
      .where(eq(projectRequests.id, deletedReq.id));

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    const requestIds = rows.map((r) => r.projectRequestId);
    expect(requestIds).toContain(liveReq.id);
    // The relationship is live, but its parent request is soft-deleted → excluded.
    expect(requestIds).not.toContain(deletedReq.id);
  });

  it('excludes a soft-deleted relationship', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
      values: { deletedAt: new Date() },
    });

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    expect(rows.map((r) => r.projectRequestId)).not.toContain(request.id);
  });

  it('excludes a soft-deleted EOI from newestEoiAt (falls back to null)', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
    });
    await db.insert(expressionsOfInterest).values({
      relationshipId: relationship.id,
      projectRequestId: request.id,
      expertProfileId: expert.id,
      message: '<p>Removed pitch.</p>',
      submittedAt: new Date('2026-03-01T00:00:00.000Z'),
      deletedAt: new Date(),
    });

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    const row = rows.find((r) => r.projectRequestId === request.id);
    expect(row).toBeDefined();
    expect(row?.newestEoiAt).toBeNull();
  });

  it('returns [] for an expert with no invitations', async () => {
    const expert = await expertDraftFactory();
    expect(await projectsInboxRepository.listInvitationsByExpert(expert.id)).toEqual([]);
  });

  it('marks only the direct request’s chosen expert as onDirectLeg, and carries availabilitySharedAt', async () => {
    const chosen = await expertDraftFactory();
    const alongside = await expertDraftFactory();
    const direct = await projectRequestFactory({
      status: 'eoi_submitted',
      sendTo: 'direct',
      expertProfileId: chosen.id,
    });
    const match = await projectRequestFactory({
      status: 'eoi_submitted',
      sendTo: 'match',
      expertProfileId: null,
    });
    const sharedAt = new Date('2026-03-02T00:00:00.000Z');
    await requestExpertRelationshipFactory({
      projectRequestId: direct.id,
      expertProfileId: chosen.id,
      values: { status: 'eoi_submitted', availabilitySharedAt: sharedAt },
    });
    await requestExpertRelationshipFactory({
      projectRequestId: direct.id,
      expertProfileId: alongside.id,
      values: { status: 'eoi_submitted' },
    });
    await requestExpertRelationshipFactory({
      projectRequestId: match.id,
      expertProfileId: chosen.id,
      values: { status: 'eoi_submitted' },
    });

    const chosenRows = await projectsInboxRepository.listInvitationsByExpert(chosen.id);
    const onDirect = chosenRows.find((r) => r.projectRequestId === direct.id);
    const onMatch = chosenRows.find((r) => r.projectRequestId === match.id);
    expect(onDirect?.onDirectLeg).toBe(true);
    expect(onDirect?.availabilitySharedAt?.getTime()).toBe(sharedAt.getTime());
    expect(onMatch?.onDirectLeg).toBe(false);
    expect(onMatch?.availabilitySharedAt).toBeNull();

    const [alongsideRow] = await projectsInboxRepository.listInvitationsByExpert(alongside.id);
    expect(alongsideRow?.projectRequestId).toBe(direct.id);
    expect(alongsideRow?.onDirectLeg).toBe(false);
  });
});

describe('projectsInboxRepository.listInvitationsByExpert — kickoff gates + current proposal', () => {
  it('passes the kickoff gate timestamps through and reports null status without a proposal', async () => {
    const expert = await expertDraftFactory();
    const billingAt = new Date('2026-05-01T00:00:00.000Z');
    const request = await projectRequestFactory({ status: 'accepted' });
    await db
      .update(projectRequests)
      .set({ clientBillingConfirmedAt: billingAt })
      .where(eq(projectRequests.id, request.id));
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
      values: { status: 'accepted' },
    });

    const [row] = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    expect(row?.clientBillingConfirmedAt?.getTime()).toBe(billingAt.getTime());
    expect(row?.expertTermsConfirmedAt).toBeNull();
    expect(row?.currentProposalStatus).toBeNull();
  });

  it('returns the current changes_requested status, ignoring superseded and soft-deleted versions, with no fan-out', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const relationship = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
      values: { status: 'proposal_submitted' },
    });
    await proposalFactory({
      relationship,
      values: { version: 1, isCurrent: false, status: 'submitted' },
    });
    await proposalFactory({
      relationship,
      values: { version: 2, isCurrent: true, status: 'changes_requested' },
    });

    const deletedRequest = await projectRequestFactory({ status: 'experts_invited' });
    const deletedRel = await requestExpertRelationshipFactory({
      projectRequestId: deletedRequest.id,
      expertProfileId: expert.id,
      values: { status: 'proposal_submitted' },
    });
    await proposalFactory({
      relationship: deletedRel,
      values: { version: 1, isCurrent: true, status: 'submitted', deletedAt: new Date() },
    });

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.projectRequestId === request.id)?.currentProposalStatus).toBe(
      'changes_requested'
    );
    expect(
      rows.find((r) => r.projectRequestId === deletedRequest.id)?.currentProposalStatus
    ).toBeNull();
  });
});

describe('projectsInboxRepository.listExpertMoveDetails', () => {
  it('returns an empty Map for empty ids', async () => {
    const expert = await expertDraftFactory();
    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [],
    });
    expect(result.size).toBe(0);
  });

  it('returns brief, timeline, sorted live product and tag names, dropping soft-deleted junctions', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    await db
      .update(projectRequests)
      .set({ timeline: 'Within 6 weeks', description: '<p>Rebuild routing.</p>' })
      .where(eq(projectRequests.id, request.id));
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
    });

    const vertical = await referenceDataRepository.getSalesforceVertical();
    const [zebra, apple, gone] = await db
      .insert(products)
      .values([
        { verticalId: vertical.id, name: 'Zebra Cloud', slug: `zebra-${request.id}` },
        { verticalId: vertical.id, name: 'Apple Cloud', slug: `apple-${request.id}` },
        { verticalId: vertical.id, name: 'Gone Cloud', slug: `gone-${request.id}` },
      ])
      .returning();
    if (zebra === undefined || apple === undefined || gone === undefined) {
      throw new Error('product insert failed');
    }
    await db.insert(projectRequestProducts).values([
      { projectRequestId: request.id, productId: zebra.id },
      { projectRequestId: request.id, productId: apple.id },
      { projectRequestId: request.id, productId: gone.id, deletedAt: new Date() },
    ]);
    const tagB = await projectTagFactory({ name: 'B tag' });
    const tagA = await projectTagFactory({ name: 'A tag' });
    const tagGone = await projectTagFactory({ name: 'Gone tag' });
    await db.insert(projectRequestTags).values([
      { projectRequestId: request.id, projectTagId: tagB.id },
      { projectRequestId: request.id, projectTagId: tagA.id },
      { projectRequestId: request.id, projectTagId: tagGone.id, deletedAt: new Date() },
    ]);

    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    const detail = result.get(request.id);
    expect(detail?.descriptionHtml).toBe('<p>Rebuild routing.</p>');
    expect(detail?.timeline).toBe('Within 6 weeks');
    expect(detail?.productNames).toEqual(['Apple Cloud', 'Zebra Cloud']);
    expect(detail?.tagNames).toEqual(['A tag', 'B tag']);
    expect(detail?.currentProposal).toBeNull();
    expect(detail?.latestChangeRequest).toBeNull();
  });

  it('reports a draft proposal status and updatedAt', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const relationship = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
    });
    const { proposal } = await proposalFactory({
      relationship,
      values: { status: 'draft' },
    });

    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    expect(result.get(request.id)?.currentProposal).toEqual({
      id: proposal.id,
      status: 'draft',
      version: 1,
      updatedAt: proposal.updatedAt,
    });
  });

  it('returns only the newest change request raised against the CURRENT version', async () => {
    const expert = await expertDraftFactory();
    const client = await userFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const relationship = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
      values: { status: 'proposal_submitted' },
    });
    const { proposal: v1 } = await proposalFactory({
      relationship,
      values: { version: 1, isCurrent: false },
    });
    const { proposal: v2 } = await proposalFactory({
      relationship,
      values: { version: 2, isCurrent: true, status: 'changes_requested' },
    });
    await db.insert(proposalChangeRequests).values([
      {
        proposalId: v1.id,
        requestedByUserId: client.id,
        note: 'Old version note',
        proposalVersion: 1,
        createdAt: new Date('2026-06-03T00:00:00.000Z'),
      },
      {
        proposalId: v2.id,
        requestedByUserId: client.id,
        note: 'First v2 note',
        section: 'pricing',
        proposalVersion: 2,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      },
      {
        proposalId: v2.id,
        requestedByUserId: client.id,
        note: 'Newest v2 note',
        section: 'timeline',
        proposalVersion: 2,
        createdAt: new Date('2026-06-02T00:00:00.000Z'),
      },
      {
        proposalId: v2.id,
        requestedByUserId: client.id,
        note: 'Deleted note',
        proposalVersion: 2,
        createdAt: new Date('2026-06-04T00:00:00.000Z'),
        deletedAt: new Date(),
      },
    ]);

    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    const detail = result.get(request.id);
    expect(detail?.currentProposal?.version).toBe(2);
    expect(detail?.latestChangeRequest).toEqual({
      note: 'Newest v2 note',
      section: 'timeline',
      createdAt: new Date('2026-06-02T00:00:00.000Z'),
    });
  });

  it('omits a request the expert has no live relationship on', async () => {
    const expert = await expertDraftFactory();
    const other = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: other.id,
    });

    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    expect(result.has(request.id)).toBe(false);
  });

  it('omits a request whose relationship is declined, or soft-deleted, or whose request is soft-deleted', async () => {
    const expert = await expertDraftFactory();
    const declinedReq = await projectRequestFactory({ status: 'experts_invited' });
    const deletedRelReq = await projectRequestFactory({ status: 'experts_invited' });
    const deletedReq = await projectRequestFactory({ status: 'experts_invited' });
    await requestExpertRelationshipFactory({
      projectRequestId: declinedReq.id,
      expertProfileId: expert.id,
      values: { status: 'declined', declinedAt: new Date() },
    });
    await requestExpertRelationshipFactory({
      projectRequestId: deletedRelReq.id,
      expertProfileId: expert.id,
      values: { deletedAt: new Date() },
    });
    await requestExpertRelationshipFactory({
      projectRequestId: deletedReq.id,
      expertProfileId: expert.id,
    });
    await db
      .update(projectRequests)
      .set({ deletedAt: new Date() })
      .where(eq(projectRequests.id, deletedReq.id));

    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [declinedReq.id, deletedRelReq.id, deletedReq.id],
    });
    expect(result.size).toBe(0);
  });

  it('omits a declined relationship on a CLOSED request, which the inbox list still returns as history', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'closed' });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
      values: { status: 'declined', declinedAt: new Date() },
    });

    const details = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    expect(details.has(request.id)).toBe(false);

    const rows = await projectsInboxRepository.listInvitationsByExpert(expert.id);
    expect(rows.map((r) => r.projectRequestId)).toContain(request.id);
  });

  it('drops a soft-deleted project tag from tagNames', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
    });
    const live = await projectTagFactory({ name: 'Live tag' });
    const retired = await projectTagFactory({ name: 'Retired tag', deletedAt: new Date() });
    await db.insert(projectRequestTags).values([
      { projectRequestId: request.id, projectTagId: live.id },
      { projectRequestId: request.id, projectTagId: retired.id },
    ]);

    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    expect(result.get(request.id)?.tagNames).toEqual(['Live tag']);
  });

  it('pins the exact key set (no budget or price field)', async () => {
    const expert = await expertDraftFactory();
    const request = await projectRequestFactory({ status: 'experts_invited' });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: expert.id,
    });
    const result = await projectsInboxRepository.listExpertMoveDetails({
      expertProfileId: expert.id,
      projectRequestIds: [request.id],
    });
    expect(Object.keys(result.get(request.id) ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'clientBillingConfirmedAt',
      'currentProposal',
      'descriptionHtml',
      'expertTermsConfirmedAt',
      'latestChangeRequest',
      'productNames',
      'projectRequestId',
      'requestStatus',
      'tagNames',
      'timeline',
    ]);
  });
});

// ── listAll (admin lens) ──────────────────────────────────────────────────

describe('projectsInboxRepository.listAll', () => {
  it('returns platform-wide live requests spanning companies, excluding soft-deleted', async () => {
    const a = await seedCompanyWithCreator();
    const b = await seedCompanyWithCreator();
    const reqA = await seedCompanyRequest(a.companyId, a.createdByUserId, { title: 'A request' });
    const reqB = await seedCompanyRequest(b.companyId, b.createdByUserId, { title: 'B request' });
    const removed = await seedCompanyRequest(a.companyId, a.createdByUserId, {
      title: 'Removed',
      deletedAt: new Date(),
    });

    const rows = await projectsInboxRepository.listAll();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(reqA);
    expect(ids).toContain(reqB);
    expect(ids).not.toContain(removed);
    // Spans companies.
    const companyIds = new Set(rows.map((r) => r.companyId));
    expect(companyIds.has(a.companyId)).toBe(true);
    expect(companyIds.has(b.companyId)).toBe(true);
  });

  it('scopes to a single status when statusFilter is supplied', async () => {
    const { companyId, createdByUserId } = await seedCompanyWithCreator();
    const requested = await seedCompanyRequest(companyId, createdByUserId, {
      title: 'Requested',
      status: 'requested',
    });
    const invited = await seedCompanyRequest(companyId, createdByUserId, {
      title: 'Invited',
      status: 'experts_invited',
    });

    const rows = await projectsInboxRepository.listAll({ statusFilter: 'requested' });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(requested);
    expect(ids).not.toContain(invited);
    expect(rows.every((r) => r.status === 'requested')).toBe(true);
  });

  it('hydrates the same graph as listByCompany (company name + relationships)', async () => {
    const request = await projectRequestFactory({
      title: 'Admin hydration',
      status: 'experts_invited',
    });
    if (request.expertProfileId === null) {
      throw new Error('expected a direct request with a target expert');
    }
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });

    const rows = await projectsInboxRepository.listAll();
    const found = rows.find((r) => r.id === request.id);
    expect(found).toBeDefined();
    expect(found?.company.name).toBeDefined();
    expect(found?.relationships.map((rel) => rel.id)).toContain(relationship.id);
  });

  it('returns [] on an empty DB', async () => {
    // Each test runs inside its own rolled-back transaction (SAVEPOINT isolation),
    // so with nothing seeded here the platform-wide scan sees no live requests.
    const rows = await projectsInboxRepository.listAll();
    expect(rows).toEqual([]);
  });
});

// ── listByCompany: current proposal status (client rule) ─────────────────

describe('projectsInboxRepository.listByCompany — current proposal status', () => {
  it('returns only the LIVE current proposal status per relationship', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    if (request.expertProfileId === null) throw new Error('expected a direct request');
    const relationship = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
      values: { status: 'proposal_submitted' },
    });
    await proposalFactory({
      relationship,
      values: { version: 1, isCurrent: false, status: 'resubmitted' },
    });
    await proposalFactory({
      relationship,
      values: { version: 2, isCurrent: true, status: 'changes_requested' },
    });
    await proposalFactory({
      relationship,
      values: { version: 3, isCurrent: true, status: 'submitted', deletedAt: new Date() },
    });

    const rows = await projectsInboxRepository.listByCompany(request.companyId);
    const [rel] = rows.find((r) => r.id === request.id)?.relationships ?? [];
    expect(rel?.proposals).toEqual([{ status: 'changes_requested' }]);
  });

  it('returns an empty proposals array when the relationship has no proposal', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    if (request.expertProfileId === null) throw new Error('expected a direct request');
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });

    const rows = await projectsInboxRepository.listByCompany(request.companyId);
    const [rel] = rows.find((r) => r.id === request.id)?.relationships ?? [];
    expect(rel?.proposals).toEqual([]);
  });
});

describe('projectsInboxRepository.listClientMoveDetails', () => {
  it('returns an empty Map for empty ids', async () => {
    const result = await projectsInboxRepository.listClientMoveDetails({
      companyId: randomUUID(),
      projectRequestIds: [],
    });
    expect(result.size).toBe(0);
  });

  it('returns version, timeframe, live milestone count and submittedAt of the current proposal', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    if (request.expertProfileId === null) throw new Error('expected a direct request');
    const relationship = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
      values: { status: 'proposal_submitted' },
    });
    const submittedAt = new Date('2026-06-05T00:00:00.000Z');
    const { proposal: v1 } = await proposalFactory({
      relationship,
      values: { version: 1, isCurrent: false, status: 'resubmitted' },
    });
    const { proposal: v2 } = await proposalFactory({
      relationship,
      values: { version: 2, isCurrent: true, timeframeWeeks: 6, submittedAt },
    });
    await db.insert(proposalMilestones).values([
      { proposalId: v1.id, sortOrder: 0, title: 'Old' },
      { proposalId: v2.id, sortOrder: 0, title: 'One' },
      { proposalId: v2.id, sortOrder: 1, title: 'Two' },
      { proposalId: v2.id, sortOrder: 2, title: 'Gone', deletedAt: new Date() },
    ]);

    const result = await projectsInboxRepository.listClientMoveDetails({
      companyId: request.companyId,
      projectRequestIds: [request.id],
    });
    const detail = result.get(request.id);
    expect(detail?.expertTermsConfirmedAt).toBeNull();
    expect(detail?.relationships).toHaveLength(1);
    expect(detail?.relationships[0]).toEqual({
      relationshipId: relationship.relationship.id,
      expertProfileId: request.expertProfileId,
      status: 'proposal_submitted',
      currentProposal: {
        status: 'submitted',
        version: 2,
        timeframeWeeks: 6,
        milestoneCount: 2,
        submittedAt,
      },
    });
  });

  it('gives a null current proposal and null timeframe through, with a zero milestone count', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    if (request.expertProfileId === null) throw new Error('expected a direct request');
    const noProposal = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });
    const other = await expertDraftFactory();
    const withProposal = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: other.id,
      values: { status: 'proposal_submitted' },
    });
    await proposalFactory({ relationship: withProposal, values: { timeframeWeeks: null } });

    const result = await projectsInboxRepository.listClientMoveDetails({
      companyId: request.companyId,
      projectRequestIds: [request.id],
    });
    const rels = result.get(request.id)?.relationships ?? [];
    expect(rels).toHaveLength(2);
    expect(
      rels.find((r) => r.relationshipId === noProposal.relationship.id)?.currentProposal
    ).toBeNull();
    expect(
      rels.find((r) => r.relationshipId === withProposal.relationship.id)?.currentProposal
    ).toMatchObject({ timeframeWeeks: null, milestoneCount: 0 });
  });

  it('is company-scoped and excludes declined, soft-deleted relationships and requests', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    if (request.expertProfileId === null) throw new Error('expected a direct request');
    const declinedExpert = await expertDraftFactory();
    const deletedExpert = await expertDraftFactory();
    const live = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: declinedExpert.id,
      values: { status: 'declined', declinedAt: new Date() },
    });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: deletedExpert.id,
      values: { deletedAt: new Date() },
    });
    const deletedRequest = await projectRequestFactory({ companyId: request.companyId });
    await db
      .update(projectRequests)
      .set({ deletedAt: new Date() })
      .where(eq(projectRequests.id, deletedRequest.id));

    const result = await projectsInboxRepository.listClientMoveDetails({
      companyId: request.companyId,
      projectRequestIds: [request.id, deletedRequest.id],
    });
    expect(result.has(deletedRequest.id)).toBe(false);
    expect(result.get(request.id)?.relationships.map((r) => r.relationshipId)).toEqual([
      live.relationship.id,
    ]);

    const wrongCompany = await projectsInboxRepository.listClientMoveDetails({
      companyId: randomUUID(),
      projectRequestIds: [request.id],
    });
    expect(wrongCompany.size).toBe(0);
  });

  it('returns a request with no relationships as an empty list', async () => {
    const { companyId, createdByUserId } = await seedCompanyWithCreator();
    const requestId = await seedCompanyRequest(companyId, createdByUserId);

    const result = await projectsInboxRepository.listClientMoveDetails({
      companyId,
      projectRequestIds: [requestId],
    });
    expect(result.get(requestId)?.relationships).toEqual([]);
  });
});
