import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  companies,
  companyMembers,
  conversationMessages,
  expressionsOfInterest,
  projectRequests,
} from '../schema';
import {
  userFactory,
  expertDraftFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
} from '../test/factories';
import { projectsInboxRepository } from './projects-inbox';

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

    const { relationship } = await requestExpertRelationshipFactory({
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
    await db.insert(conversationMessages).values([
      {
        relationshipId: relationship.id,
        senderUserId: sender.id,
        body: '<p>Old.</p>',
        createdAt: olderMsg,
      },
      {
        relationshipId: relationship.id,
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
