import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, projectChangeRequests } from '../schema';
import { engagementFactory, userFactory } from '../test/factories';
import { projectEngagementsRepository } from './project-engagements';

/**
 * Migration 0114's legacy backfill: every `engagement.changes_requested` audit row written
 * before `project_change_requests` existed becomes one untagged round. The harness migrates
 * an empty database, so the statement is lifted from the migration file and run against
 * seeded audit rows here.
 */
const MIGRATION = readFileSync(
  new URL('../../drizzle/0114_bal621_project_change_requests.sql', import.meta.url),
  'utf8'
);

const BACKFILL = MIGRATION.split('--> statement-breakpoint').find((statement) =>
  statement.includes('INSERT INTO "project_change_requests"')
);

async function runBackfill(): Promise<void> {
  if (BACKFILL === undefined) throw new Error('0114 has no backfill statement');
  await db.execute(sql.raw(BACKFILL));
}

async function seedAudit(input: {
  engagementId: string;
  actorUserId: string | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
  action?: string;
}): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: input.actorUserId,
    action: input.action ?? 'engagement.changes_requested',
    entityType: 'engagement',
    entityId: input.engagementId,
    metadata: input.metadata,
    createdAt: input.createdAt,
  });
}

function roundsFor(engagementId: string) {
  return db
    .select({
      note: projectChangeRequests.note,
      requestedByUserId: projectChangeRequests.requestedByUserId,
      requestedAt: projectChangeRequests.requestedAt,
    })
    .from(projectChangeRequests)
    .where(eq(projectChangeRequests.engagementId, engagementId))
    .orderBy(asc(projectChangeRequests.requestedAt));
}

describe('migration 0114 — legacy change-request backfill (BAL-621)', () => {
  it('turns each legacy audit row into an untagged round, at the time and by the person it records', async () => {
    const { engagement } = await engagementFactory();
    const client = await userFactory({ firstName: 'Dana', lastName: 'Client' });
    const first = new Date('2026-07-01T09:00:00.000Z');
    const second = new Date('2026-07-09T15:30:00.000Z');
    await seedAudit({
      engagementId: engagement.id,
      actorUserId: client.id,
      createdAt: second,
      metadata: { from: 'pending_acceptance', to: 'active', note: 'Round two.' },
    });
    await seedAudit({
      engagementId: engagement.id,
      actorUserId: client.id,
      createdAt: first,
      metadata: { from: 'pending_acceptance', to: 'active', note: 'Round one.' },
    });

    await runBackfill();

    expect(await roundsFor(engagement.id)).toEqual([
      { note: 'Round one.', requestedByUserId: client.id, requestedAt: first },
      { note: 'Round two.', requestedByUserId: client.id, requestedAt: second },
    ]);
    const hydrated = await projectEngagementsRepository.findWithMilestones(engagement.id);
    expect(hydrated?.changeRequestRoundCount).toBe(2);
    expect(hydrated?.latestChangeRequest?.note).toBe('Round two.');
    expect(hydrated?.latestChangeRequest?.taggedMilestoneIds).toEqual([]);
  });

  it('skips rows already backed by a round, rows with no actor or note, and other actions', async () => {
    const { engagement } = await engagementFactory();
    const client = await userFactory();
    const at = new Date('2026-07-01T09:00:00.000Z');
    await seedAudit({
      engagementId: engagement.id,
      actorUserId: client.id,
      createdAt: at,
      metadata: { note: 'Already a round.', change_request_id: randomUUID() },
    });
    await seedAudit({
      engagementId: engagement.id,
      actorUserId: null,
      createdAt: at,
      metadata: { note: 'No actor.' },
    });
    await seedAudit({
      engagementId: engagement.id,
      actorUserId: client.id,
      createdAt: at,
      metadata: { from: 'pending_acceptance', to: 'active' },
    });
    await seedAudit({
      engagementId: engagement.id,
      actorUserId: client.id,
      createdAt: at,
      metadata: { note: 'Not a change request.' },
      action: 'engagement.completion_requested',
    });

    await runBackfill();

    expect(await roundsFor(engagement.id)).toEqual([]);
  });
});
