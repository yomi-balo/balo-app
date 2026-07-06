import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, engagements, users, type AuditEvent } from '../schema';
import { engagementFactory, userFactory } from '../test/factories';
import { recordAuditEvent, auditEventsRepository } from './audit-events';

// Compile-time guard: `audit_events` is APPEND-ONLY and deliberately has NO
// soft-delete column (the one documented CLAUDE.md exception). If `deletedAt` were
// ever added to the schema, `_AuditHasNoDeletedAt` collapses to `never` and this
// assignment fails to compile.
type _AuditHasNoDeletedAt = 'deletedAt' extends keyof AuditEvent ? never : true;
const _auditAppendOnly: _AuditHasNoDeletedAt = true;
void _auditAppendOnly;

describe('recordAuditEvent', () => {
  it('inserts a row with the supplied action/entityType/entityId/engagementId/metadata/actor', async () => {
    const { engagement } = await engagementFactory();
    const actor = await userFactory();
    const occurredAt = new Date('2026-04-04T10:00:00.000Z');

    const row = await db.transaction((tx) =>
      recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
        metadata: { from: 'active', to: 'pending_acceptance' },
        occurredAt,
      })
    );

    expect(row.actorUserId).toBe(actor.id);
    expect(row.action).toBe('engagement.completion_requested');
    expect(row.entityType).toBe('engagement');
    expect(row.entityId).toBe(engagement.id);
    expect(row.engagementId).toBe(engagement.id);
    expect(row.metadata).toMatchObject({ from: 'active', to: 'pending_acceptance' });
    expect(row.occurredAt.getTime()).toBe(occurredAt.getTime());
  });

  it('applies occurredAt (now) and metadata ({}) defaults when omitted', async () => {
    const { engagement } = await engagementFactory();
    const actor = await userFactory();

    const row = await db.transaction((tx) =>
      recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement_milestone.added',
        entityType: 'engagement_milestone',
        entityId: engagement.id, // any uuid — entity_id has no FK
        engagementId: engagement.id,
      })
    );

    expect(row.occurredAt).toBeInstanceOf(Date);
    expect(row.metadata).toEqual({});
  });

  it('persists a system/auto event with actor_user_id = null', async () => {
    const { engagement } = await engagementFactory();

    const row = await db.transaction((tx) =>
      recordAuditEvent(tx, {
        actorUserId: null,
        action: 'engagement.accepted',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
        metadata: { acceptance_method: 'auto' },
      })
    );

    expect(row.actorUserId).toBeNull();
    expect(row.metadata).toMatchObject({ acceptance_method: 'auto' });
  });
});

describe('audit_events — relationship immutability', () => {
  it('RESTRICT: hard-deleting an actor user with audit history throws (FK 23503)', async () => {
    const { engagement } = await engagementFactory();
    const actor = await userFactory();
    await db.transaction((tx) =>
      recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.cancelled',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
      })
    );

    await expect(db.delete(users).where(eq(users.id, actor.id))).rejects.toThrow();
  });

  it('SET NULL: hard-deleting the engagement nulls engagement_id but the audit row survives', async () => {
    const { engagement } = await engagementFactory();
    const actor = await userFactory();
    const row = await db.transaction((tx) =>
      recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
      })
    );

    await db.delete(engagements).where(eq(engagements.id, engagement.id));

    const [survivor] = await db.select().from(auditEvents).where(eq(auditEvents.id, row.id));
    expect(survivor).toBeDefined();
    expect(survivor?.engagementId).toBeNull();
    expect(survivor?.action).toBe('engagement.completion_requested');
  });
});

describe('auditEventsRepository.listByEngagement / listByEntity', () => {
  it('listByEngagement returns rows oldest-first, scoped to the engagement', async () => {
    const { engagement } = await engagementFactory();
    const { engagement: other } = await engagementFactory();
    const actor = await userFactory();

    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-02T00:00:00.000Z');
    const t3 = new Date('2026-01-03T00:00:00.000Z');

    await db.transaction(async (tx) => {
      // Insert out of chronological order to prove the ORDER BY.
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.accepted',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
        occurredAt: t3,
      });
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
        occurredAt: t1,
      });
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.completion_withdrawn',
        entityType: 'engagement',
        entityId: engagement.id,
        engagementId: engagement.id,
        occurredAt: t2,
      });
      // A different engagement's event must not leak in.
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement.cancelled',
        entityType: 'engagement',
        entityId: other.id,
        engagementId: other.id,
        occurredAt: t1,
      });
    });

    const events = await auditEventsRepository.listByEngagement(engagement.id);
    expect(events.map((e) => e.action)).toEqual([
      'engagement.completion_requested',
      'engagement.completion_withdrawn',
      'engagement.accepted',
    ]);
  });

  it('listByEntity is scoped to one polymorphic (entityType, entityId), oldest-first', async () => {
    const { engagement } = await engagementFactory();
    const actor = await userFactory();
    const milestoneA = engagement.id; // stand-in uuids (entity_id has no FK)
    const milestoneB = actor.id;

    const t1 = new Date('2026-05-01T00:00:00.000Z');
    const t2 = new Date('2026-05-02T00:00:00.000Z');
    await db.transaction(async (tx) => {
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement_milestone.started',
        entityType: 'engagement_milestone',
        entityId: milestoneA,
        engagementId: engagement.id,
        occurredAt: t1,
      });
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement_milestone.completed',
        entityType: 'engagement_milestone',
        entityId: milestoneA,
        engagementId: engagement.id,
        occurredAt: t2,
      });
      await recordAuditEvent(tx, {
        actorUserId: actor.id,
        action: 'engagement_milestone.started',
        entityType: 'engagement_milestone',
        entityId: milestoneB,
        engagementId: engagement.id,
        occurredAt: t1,
      });
    });

    const forA = await auditEventsRepository.listByEntity('engagement_milestone', milestoneA);
    expect(forA).toHaveLength(2);
    expect(forA.every((e) => e.entityId === milestoneA)).toBe(true);
    expect(forA.map((e) => e.action)).toEqual([
      'engagement_milestone.started',
      'engagement_milestone.completed',
    ]);
  });
});
