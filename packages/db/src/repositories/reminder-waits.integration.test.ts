import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import {
  engagements,
  expertProfiles,
  notificationLog,
  projectEngagements,
  projectRequests,
  requestExpertRelationships,
  users,
  verticals,
} from '../schema';
import {
  agencyFactory,
  caseEngagementFactory,
  companyFactory,
  engagementFactory,
  expertDraftFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
  scheduledNotificationFactory,
  userFactory,
} from '../test/factories';
import {
  DELIVERY_OUTCOMES_LIMIT,
  REQUEST_RELATIONSHIP_IDS_LIMIT,
  reminderWaitsRepository,
} from './reminder-waits';

const DAY_MS = 86_400_000;
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');
const ANCHOR = '2026-11-02T01:00:00.000Z';

type SequenceId = 'proposal_review' | 'delivery_review' | 'invitation';

function seqKey(entityId: string, step: string, userId: string, sequence: SequenceId): string {
  return `seq:${sequence}:${entityId}:${step}:${userId}:${ANCHOR}`;
}

interface SeedInput {
  entityId: string;
  userId: string;
  step?: string;
  sequence?: SequenceId;
  values?: Parameters<typeof scheduledNotificationFactory>[0] extends infer O
    ? O extends { values?: infer V }
      ? V
      : never
    : never;
}

function seed({
  entityId,
  userId,
  step = 'day_2',
  sequence = 'proposal_review',
  values,
}: SeedInput) {
  return scheduledNotificationFactory({
    dedupeKey: seqKey(entityId, step, userId, sequence),
    values: {
      event: 'project.proposal_review_reminder',
      payload: { entityId, recipientUserId: userId, title: 'payload title' },
      ...values,
    },
  });
}

describe('reminderWaitsRepository.listRows', () => {
  it('matches only the entity whose prefix is given, and never a sibling through "_"', async () => {
    const user = await userFactory();
    const entityA = randomUUID();
    const entityB = randomUUID();
    const rowA = await seed({ entityId: entityA, userId: user.id });
    await seed({ entityId: entityB, userId: user.id });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityA}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual([rowA.id]);

    // `_` is a LIKE wildcard: the prefix `seq:proposal_review:` must not match `seqXproposalXreview:`.
    await scheduledNotificationFactory({ dedupeKey: `seqXproposalXreview:${entityA}:day_2` });
    const wildcard = await reminderWaitsRepository.listRows({
      keyPrefixes: ['seq:proposal_review:'],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(wildcard.every((r) => r.dedupeKey.startsWith('seq:proposal_review:'))).toBe(true);
  });

  it('matches any of several prefixes', async () => {
    const user = await userFactory();
    const entityA = randomUUID();
    const entityB = randomUUID();
    const rowA = await seed({ entityId: entityA, userId: user.id });
    const rowB = await seed({ entityId: entityB, userId: user.id });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityA}:`, `seq:proposal_review:${entityB}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(rows.map((r) => r.id).sort()).toEqual([rowA.id, rowB.id].sort());
  });

  it('filters by recipient when recipientUserId is given', async () => {
    const mine = await userFactory();
    const theirs = await userFactory();
    const entityId = randomUUID();
    const mineRow = await seed({ entityId, userId: mine.id });
    await seed({ entityId, userId: theirs.id });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityId}:`],
      recipientUserId: mine.id,
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual([mineRow.id]);
  });

  it('excludes soft-deleted rows and rows created before createdSince', async () => {
    const user = await userFactory();
    const entityId = randomUUID();
    const live = await seed({ entityId, userId: user.id, step: 'day_2' });
    await seed({ entityId, userId: user.id, step: 'day_5', values: { deletedAt: new Date() } });
    await seed({
      entityId,
      userId: user.id,
      step: 'day_9',
      values: { createdAt: new Date(Date.now() - 100 * DAY_MS) },
    });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityId}:`],
      createdSince: new Date(Date.now() - 90 * DAY_MS),
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });

  it('returns newest first and holds the limit', async () => {
    const user = await userFactory();
    const entityId = randomUUID();
    const oldest = await seed({
      entityId,
      userId: user.id,
      step: 'day_2',
      values: { createdAt: new Date('2026-11-03T00:00:00Z') },
    });
    const middle = await seed({
      entityId,
      userId: user.id,
      step: 'day_5',
      values: { createdAt: new Date('2026-11-04T00:00:00Z') },
    });
    const newest = await seed({
      entityId,
      userId: user.id,
      step: 'day_9',
      values: { createdAt: new Date('2026-11-05T00:00:00Z') },
    });

    const all = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityId}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(all.map((r) => r.id)).toEqual([newest.id, middle.id, oldest.id]);

    const limited = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityId}:`],
      createdSince: LONG_AGO,
      limit: 2,
    });
    expect(limited.map((r) => r.id)).toEqual([newest.id, middle.id]);
  });

  it('fills the recipient and entity from the joins', async () => {
    const request = await projectRequestFactory({ title: 'Lead routing rebuild' });
    const user = await userFactory({
      firstName: 'Dana',
      lastName: 'Cole',
      timezone: 'Pacific/Auckland',
    });
    const row = await seed({ entityId: request.id, userId: user.id });

    const [found] = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${request.id}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(found?.id).toBe(row.id);
    expect(found?.recipient).toEqual({
      firstName: 'Dana',
      lastName: 'Cole',
      timezone: 'Pacific/Auckland',
    });
    expect(found?.entity).toEqual({
      title: 'Lead routing rebuild',
      companyName: 'Acme Co',
      agencyName: null,
    });
    expect(found?.payload).toMatchObject({ entityId: request.id, recipientUserId: user.id });
    expect(found?.status).toBe('pending');
    expect(found?.attempts).toBe(0);
  });

  it('gives a null recipient for a missing or soft-deleted user', async () => {
    const request = await projectRequestFactory();
    const gone = await userFactory();
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, gone.id));
    await seed({ entityId: request.id, userId: gone.id, step: 'day_2' });
    await seed({ entityId: request.id, userId: randomUUID(), step: 'day_5' });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${request.id}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.recipient === null)).toBe(true);
  });

  it('gives a null entity for a non-request entity and for a malformed stored id', async () => {
    const user = await userFactory();
    const unknownEntity = randomUUID();
    await seed({ entityId: unknownEntity, userId: user.id, step: 'day_2' });
    await scheduledNotificationFactory({
      dedupeKey: seqKey('not-a-uuid', 'day_5', user.id, 'proposal_review'),
      values: { payload: { entityId: 'not-a-uuid', recipientUserId: 'also-not-a-uuid' } },
    });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${unknownEntity}:`, 'seq:proposal_review:not-a-uuid:'],
      createdSince: LONG_AGO,
      limit: 10,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.entity === null)).toBe(true);
  });

  it('gives a null recipient and entity for a malformed stored recipientUserId and entityId, without throwing', async () => {
    const user = await userFactory();
    await scheduledNotificationFactory({
      dedupeKey: seqKey('bad-ids', 'day_2', user.id, 'proposal_review'),
      values: { payload: { entityId: 'not-a-uuid', recipientUserId: 'also-not-a-uuid' } },
    });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: ['seq:proposal_review:bad-ids:'],
      createdSince: LONG_AGO,
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipient).toBeNull();
    expect(rows[0]?.entity).toBeNull();
  });

  it('joins an upper-case stored uuid to its request and recipient', async () => {
    const request = await projectRequestFactory({ title: 'Upper-case id' });
    const user = await userFactory({ firstName: 'Una' });
    await scheduledNotificationFactory({
      dedupeKey: seqKey(request.id, 'day_2', user.id, 'proposal_review'),
      values: {
        payload: {
          entityId: request.id.toUpperCase(),
          recipientUserId: user.id.toUpperCase(),
        },
      },
    });

    const [found] = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${request.id}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });

    expect(found?.recipient?.firstName).toBe('Una');
    expect(found?.entity?.title).toBe('Upper-case id');
  });

  it('returns no rows and runs no query for empty prefixes', async () => {
    const user = await userFactory();
    await seed({ entityId: randomUUID(), userId: user.id });
    expect(
      await reminderWaitsRepository.listRows({
        keyPrefixes: [],
        createdSince: LONG_AGO,
        limit: 10,
      })
    ).toEqual([]);
  });
});

describe('reminderWaitsRepository.findEngagementRequestId', () => {
  it("returns the originating request's id for a project engagement", async () => {
    const { engagement } = await engagementFactory({ withSourceProposal: true });
    expect(engagement.projectRequestId).not.toBeNull();
    const [request] = await db
      .select({ title: projectRequests.title })
      .from(projectRequests)
      .where(eq(projectRequests.id, engagement.projectRequestId ?? randomUUID()));
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: engagement.projectRequestId,
      requestTitle: request?.title,
    });
  });

  it('returns a null title when the originating request is soft-deleted', async () => {
    const { engagement } = await engagementFactory({ withSourceProposal: true });
    await db
      .update(projectRequests)
      .set({ deletedAt: new Date() })
      .where(eq(projectRequests.id, engagement.projectRequestId ?? randomUUID()));

    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: engagement.projectRequestId,
      requestTitle: null,
    });
  });

  it('returns a null request id for a project with no originating request', async () => {
    const { engagement } = await engagementFactory();
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: null,
      requestTitle: null,
    });
  });

  it('returns a null request id for a case', async () => {
    const { engagement } = await caseEngagementFactory();
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: null,
      requestTitle: null,
    });
  });

  it('returns a null request id when only the project engagement row is soft-deleted', async () => {
    const { engagement } = await engagementFactory({ withSourceProposal: true });
    // Isolates the join's own `deleted_at` filter: the parent engagement stays live.
    await db
      .update(projectEngagements)
      .set({ deletedAt: new Date() })
      .where(eq(projectEngagements.engagementId, engagement.id));

    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: null,
      requestTitle: null,
    });
  });

  it('returns undefined for an unknown or soft-deleted engagement', async () => {
    expect(await reminderWaitsRepository.findEngagementRequestId(randomUUID())).toBeUndefined();

    const { engagement } = await engagementFactory({ withSourceProposal: true });
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toBeUndefined();
  });
});

async function rowFor(sequence: SequenceId, entityId: string, step: string) {
  const user = await userFactory();
  await seed({ entityId, userId: user.id, step, sequence });
  const [row] = await reminderWaitsRepository.listRows({
    keyPrefixes: [`seq:${sequence}:${entityId}:`],
    createdSince: LONG_AGO,
    limit: 10,
  });
  return row;
}

async function softDeleteRequest(requestId: string): Promise<void> {
  await db
    .update(projectRequests)
    .set({ deletedAt: new Date() })
    .where(eq(projectRequests.id, requestId));
}

describe('reminderWaitsRepository.listRows entity per sequence', () => {
  it('resolves a delivery_review row to its engagement, originating request and company', async () => {
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const { engagement } = await engagementFactory({
      companyId: company.id,
      withSourceProposal: true,
    });
    const [request] = await db
      .select({ title: projectRequests.title })
      .from(projectRequests)
      .where(eq(projectRequests.id, engagement.projectRequestId ?? randomUUID()));

    const row = await rowFor('delivery_review', engagement.id, 'pre_auto_accept');

    expect(row?.entity).toEqual({
      title: request?.title,
      companyName: 'Northwind Industrial',
      agencyName: null,
    });
  });

  it('keeps the company and gives a null title when the engagement has no live request', async () => {
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const { engagement } = await engagementFactory({ companyId: company.id });
    const withoutRequest = await rowFor('delivery_review', engagement.id, 'pre_auto_accept');
    expect(withoutRequest?.entity).toEqual({
      title: null,
      companyName: 'Northwind Industrial',
      agencyName: null,
    });

    const sourced = await engagementFactory({ companyId: company.id, withSourceProposal: true });
    await softDeleteRequest(sourced.engagement.projectRequestId ?? randomUUID());
    const deletedRequest = await rowFor(
      'delivery_review',
      sourced.engagement.id,
      'pre_auto_accept'
    );
    expect(deletedRequest?.entity).toEqual({
      title: null,
      companyName: 'Northwind Industrial',
      agencyName: null,
    });
  });

  it('resolves an invitation row to its relationship, request, company and expert agency', async () => {
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const request = await projectRequestFactory({ title: 'Quote-to-cash rollout' });
    const { relationship, expertProfileId } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
    });
    await db
      .update(expertProfiles)
      .set({ agencyId: agency.id })
      .where(eq(expertProfiles.id, expertProfileId));

    const row = await rowFor('invitation', relationship.id, 'day_1');

    expect(row?.entity).toEqual({
      title: 'Quote-to-cash rollout',
      companyName: 'Acme Co',
      agencyName: 'CloudPeak',
    });
  });

  it('gives a null agency for an independent expert', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const row = await rowFor('invitation', relationship.id, 'day_1');
    expect(row?.entity?.agencyName).toBeNull();
    expect(row?.entity?.companyName).toBe('Acme Co');
  });

  it('takes the agency from the invited profile when the user has another profile', async () => {
    const invitedAgency = await agencyFactory({ name: 'Invited Agency' });
    const otherAgency = await agencyFactory({ name: 'Other Agency' });
    const user = await userFactory();
    const invitedProfile = await expertDraftFactory({ userId: user.id });
    const [vertical] = await db
      .insert(verticals)
      .values({ name: 'Second vertical', slug: `second-${randomUUID()}` })
      .returning();
    const otherProfile = await expertDraftFactory({ userId: user.id, verticalId: vertical?.id });
    await db
      .update(expertProfiles)
      .set({ agencyId: invitedAgency.id })
      .where(eq(expertProfiles.id, invitedProfile.id));
    await db
      .update(expertProfiles)
      .set({ agencyId: otherAgency.id })
      .where(eq(expertProfiles.id, otherProfile.id));
    const { relationship } = await requestExpertRelationshipFactory({
      expertProfileId: invitedProfile.id,
    });
    const reader = await userFactory();
    await seed({
      entityId: relationship.id,
      userId: reader.id,
      step: 'day_1',
      sequence: 'invitation',
    });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:invitation:${relationship.id}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity?.agencyName).toBe('Invited Agency');
  });

  it('never borrows another sequence’s join for a key', async () => {
    const request = await projectRequestFactory({ title: 'A request' });
    const { engagement } = await engagementFactory();
    const { relationship } = await requestExpertRelationshipFactory();

    expect((await rowFor('proposal_review', engagement.id, 'day_2'))?.entity).toBeNull();
    expect((await rowFor('proposal_review', relationship.id, 'day_2'))?.entity).toBeNull();
    expect((await rowFor('delivery_review', request.id, 'pre_auto_accept'))?.entity).toBeNull();
    expect(
      (await rowFor('delivery_review', relationship.id, 'pre_auto_accept'))?.entity
    ).toBeNull();
    expect((await rowFor('invitation', request.id, 'day_1'))?.entity).toBeNull();
    expect((await rowFor('invitation', engagement.id, 'day_1'))?.entity).toBeNull();
  });

  it('gives a null entity once its subject is soft-deleted', async () => {
    const request = await projectRequestFactory();
    await softDeleteRequest(request.id);
    expect((await rowFor('proposal_review', request.id, 'day_2'))?.entity).toBeNull();

    const { engagement } = await engagementFactory();
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, engagement.id));
    expect((await rowFor('delivery_review', engagement.id, 'pre_auto_accept'))?.entity).toBeNull();

    const { relationship } = await requestExpertRelationshipFactory();
    await db
      .update(requestExpertRelationships)
      .set({ deletedAt: new Date() })
      .where(eq(requestExpertRelationships.id, relationship.id));
    expect((await rowFor('invitation', relationship.id, 'day_1'))?.entity).toBeNull();
  });
});

describe('reminderWaitsRepository.listRequestRelationshipIds', () => {
  it('lists live relationships in any status, oldest invite first, then by id', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const declined = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: (await expertDraftFactory()).id,
      values: { status: 'declined', invitedAt: new Date('2026-11-02T00:00:00Z') },
    });
    const first = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: (await expertDraftFactory()).id,
      values: { invitedAt: new Date('2026-11-01T00:00:00Z') },
    });
    const last = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: (await expertDraftFactory()).id,
      values: { status: 'proposal_requested', invitedAt: new Date('2026-11-03T00:00:00Z') },
    });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: (await expertDraftFactory()).id,
      values: { deletedAt: new Date() },
    });

    expect(await reminderWaitsRepository.listRequestRelationshipIds(request.id)).toEqual([
      first.relationship.id,
      declined.relationship.id,
      last.relationship.id,
    ]);
  });

  it('is empty for an unknown request', async () => {
    expect(await reminderWaitsRepository.listRequestRelationshipIds(randomUUID())).toEqual([]);
  });

  it('returns at most REQUEST_RELATIONSHIP_IDS_LIMIT ids, the oldest invites first', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const base = new Date('2026-11-01T00:00:00Z').getTime();
    const created: string[] = [];
    for (let index = 0; index <= REQUEST_RELATIONSHIP_IDS_LIMIT; index++) {
      const { relationship } = await requestExpertRelationshipFactory({
        projectRequestId: request.id,
        expertProfileId: (await expertDraftFactory()).id,
        values: { invitedAt: new Date(base + index * 1000) },
      });
      created.push(relationship.id);
    }

    const ids = await reminderWaitsRepository.listRequestRelationshipIds(request.id);

    expect(created).toHaveLength(REQUEST_RELATIONSHIP_IDS_LIMIT + 1);
    expect(ids).toEqual(created.slice(0, REQUEST_RELATIONSHIP_IDS_LIMIT));
  });
});

describe('reminderWaitsRepository.listDeliveryReviewStates', () => {
  it('returns the folded delivery status and completion request of live projects', async () => {
    const requestedAt = new Date('2026-11-18T01:00:00.000Z');
    const pending = await engagementFactory({
      projectValues: { deliveryStatus: 'pending_acceptance', completionRequestedAt: requestedAt },
    });
    const active = await engagementFactory();

    const states = await reminderWaitsRepository.listDeliveryReviewStates([
      pending.engagement.id,
      active.engagement.id,
    ]);

    expect([...states].sort((a, b) => a.engagementId.localeCompare(b.engagementId))).toEqual(
      [
        {
          engagementId: pending.engagement.id,
          status: 'pending_acceptance',
          completionRequestedAt: requestedAt,
        },
        { engagementId: active.engagement.id, status: 'active', completionRequestedAt: null },
      ].sort((a, b) => a.engagementId.localeCompare(b.engagementId))
    );
  });

  it('has no row for a case, an unknown id or a soft-deleted engagement or project', async () => {
    const { engagement: caseEngagement } = await caseEngagementFactory();
    const deletedParent = await engagementFactory();
    await db
      .update(engagements)
      .set({ deletedAt: new Date() })
      .where(eq(engagements.id, deletedParent.engagement.id));
    const deletedChild = await engagementFactory();
    await db
      .update(projectEngagements)
      .set({ deletedAt: new Date() })
      .where(eq(projectEngagements.engagementId, deletedChild.engagement.id));

    expect(
      await reminderWaitsRepository.listDeliveryReviewStates([
        caseEngagement.id,
        randomUUID(),
        deletedParent.engagement.id,
        deletedChild.engagement.id,
      ])
    ).toEqual([]);
  });

  it('makes no query for empty or non-uuid ids', async () => {
    expect(await reminderWaitsRepository.listDeliveryReviewStates([])).toEqual([]);
    expect(await reminderWaitsRepository.listDeliveryReviewStates(['not-a-uuid'])).toEqual([]);
  });
});

describe('reminderWaitsRepository surface', () => {
  it('is read-only: its keys are exactly the five reads', () => {
    expect(Object.keys(reminderWaitsRepository).sort()).toEqual([
      'findEngagementRequestId',
      'listDeliveryOutcomes',
      'listDeliveryReviewStates',
      'listRequestRelationshipIds',
      'listRows',
    ]);
  });
});

describe('reminderWaitsRepository.listRows correlationId', () => {
  it('exposes the stored payload correlationId, and null when it is missing or blank', async () => {
    const user = await userFactory();
    const entityId = randomUUID();
    const withId = await seed({
      entityId,
      userId: user.id,
      step: 'day_2',
      values: {
        payload: { entityId, recipientUserId: user.id, correlationId: 'corr-1' },
      },
    });
    const blank = await seed({
      entityId,
      userId: user.id,
      step: 'day_5',
      values: { payload: { entityId, recipientUserId: user.id, correlationId: '' } },
    });
    const missing = await seed({ entityId, userId: user.id, step: 'day_7' });

    const rows = await reminderWaitsRepository.listRows({
      keyPrefixes: [`seq:proposal_review:${entityId}:`],
      createdSince: LONG_AGO,
      limit: 10,
    });
    const byId = new Map(rows.map((r) => [r.id, r.correlationId]));
    expect(byId.get(withId.id)).toBe('corr-1');
    expect(byId.get(blank.id)).toBeNull();
    expect(byId.get(missing.id)).toBeNull();
  });
});

describe('reminderWaitsRepository.listDeliveryOutcomes', () => {
  async function log(
    recipientId: string,
    correlationId: string,
    values: {
      channel?: string;
      status?: string;
      error?: string | null;
      createdAt?: Date;
      deletedAt?: Date | null;
    } = {}
  ): Promise<void> {
    await db.insert(notificationLog).values({
      event: 'project.proposal_review_reminder',
      correlationId,
      recipientId,
      channel: values.channel ?? 'email',
      template: 'proposal-review-reminder',
      status: values.status ?? 'sent',
      error: values.error ?? null,
      ...(values.createdAt === undefined ? {} : { createdAt: values.createdAt }),
      ...(values.deletedAt === undefined ? {} : { deletedAt: values.deletedAt }),
    });
  }

  it('returns each channel outcome of the given correlation ids, newest first', async () => {
    const user = await userFactory();
    const a = randomUUID();
    const b = randomUUID();
    const other = randomUUID();
    await log(user.id, a, {
      channel: 'in-app',
      status: 'sent',
      createdAt: new Date('2026-11-02T02:00:00.000Z'),
    });
    await log(user.id, a, {
      channel: 'email',
      status: 'failed',
      error: 'Mailbox full',
      createdAt: new Date('2026-11-02T01:00:00.000Z'),
    });
    await log(user.id, b, { channel: 'email', status: 'skipped', error: 'Unsubscribed' });
    await log(user.id, other);

    const outcomes = await reminderWaitsRepository.listDeliveryOutcomes({
      correlationIds: [a, b, a, ''],
    });
    expect(outcomes.map((o) => [o.correlationId, o.channel, o.status, o.error])).toEqual([
      [b, 'email', 'skipped', 'Unsubscribed'],
      [a, 'in-app', 'sent', null],
      [a, 'email', 'failed', 'Mailbox full'],
    ]);
    expect(outcomes[1]?.createdAt).toEqual(new Date('2026-11-02T02:00:00.000Z'));
  });

  it('excludes soft-deleted log rows', async () => {
    const user = await userFactory();
    const id = randomUUID();
    await log(user.id, id, { deletedAt: new Date() });
    expect(await reminderWaitsRepository.listDeliveryOutcomes({ correlationIds: [id] })).toEqual(
      []
    );
  });

  it('has no row for a correlation id that was never logged', async () => {
    expect(
      await reminderWaitsRepository.listDeliveryOutcomes({ correlationIds: [randomUUID()] })
    ).toEqual([]);
  });

  it('applies the cap and drops the oldest outcomes first', async () => {
    const user = await userFactory();
    const id = randomUUID();
    const base = new Date('2026-01-01T00:00:00.000Z').getTime();
    const total = DELIVERY_OUTCOMES_LIMIT + 1;
    await db.insert(notificationLog).values(
      Array.from({ length: total }, (_, index) => ({
        event: 'project.proposal_review_reminder',
        correlationId: id,
        recipientId: user.id,
        channel: 'email',
        template: 'proposal-review-reminder',
        status: 'sent',
        createdAt: new Date(base + index * 1000),
      }))
    );

    const outcomes = await reminderWaitsRepository.listDeliveryOutcomes({ correlationIds: [id] });
    expect(outcomes).toHaveLength(DELIVERY_OUTCOMES_LIMIT);
    expect(outcomes[0]?.createdAt).toEqual(new Date(base + DELIVERY_OUTCOMES_LIMIT * 1000));
    expect(outcomes.at(-1)?.createdAt).toEqual(new Date(base + 1000));
  });

  it('makes no query for empty or blank ids', async () => {
    expect(await reminderWaitsRepository.listDeliveryOutcomes({ correlationIds: [] })).toEqual([]);
    expect(await reminderWaitsRepository.listDeliveryOutcomes({ correlationIds: [''] })).toEqual(
      []
    );
  });
});
