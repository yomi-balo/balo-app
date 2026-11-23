import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { engagements, projectEngagements, users } from '../schema';
import {
  caseEngagementFactory,
  engagementFactory,
  projectRequestFactory,
  scheduledNotificationFactory,
  userFactory,
} from '../test/factories';
import { reminderWaitsRepository } from './reminder-waits';

const DAY_MS = 86_400_000;
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');
const ANCHOR = '2026-11-02T01:00:00.000Z';

function seqKey(entityId: string, step: string, userId: string): string {
  return `seq:proposal_review:${entityId}:${step}:${userId}:${ANCHOR}`;
}

interface SeedInput {
  entityId: string;
  userId: string;
  step?: string;
  values?: Parameters<typeof scheduledNotificationFactory>[0] extends infer O
    ? O extends { values?: infer V }
      ? V
      : never
    : never;
}

function seed({ entityId, userId, step = 'day_2', values }: SeedInput) {
  return scheduledNotificationFactory({
    dedupeKey: seqKey(entityId, step, userId),
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
    expect(found?.entity).toEqual({ title: 'Lead routing rebuild', companyName: 'Acme Co' });
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
      dedupeKey: seqKey('not-a-uuid', 'day_5', user.id),
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
      dedupeKey: seqKey('bad-ids', 'day_2', user.id),
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
      dedupeKey: seqKey(request.id, 'day_2', user.id),
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
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: engagement.projectRequestId,
    });
  });

  it('returns a null request id for a project with no originating request', async () => {
    const { engagement } = await engagementFactory();
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: null,
    });
  });

  it('returns a null request id for a case', async () => {
    const { engagement } = await caseEngagementFactory();
    expect(await reminderWaitsRepository.findEngagementRequestId(engagement.id)).toEqual({
      projectRequestId: null,
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

describe('reminderWaitsRepository surface', () => {
  it('is read-only: its keys are exactly the two reads', () => {
    expect(Object.keys(reminderWaitsRepository).sort()).toEqual([
      'findEngagementRequestId',
      'listRows',
    ]);
  });
});
