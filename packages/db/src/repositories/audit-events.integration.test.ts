import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import { auditEvents } from '../schema';
import { userFactory } from '../test/factories';
import { auditEventsRepository } from './audit-events';

/**
 * Integration tests for the generic audit writer (BAL-344). Uses the in-harness
 * `db` (per-test transaction, auto-rolled-back). Covers a full-column insert with
 * jsonb round-trip, the nullable-actor path, and participation in a caller tx.
 */

describe('auditEventsRepository.record', () => {
  it('inserts a row with all columns and round-trips the metadata jsonb', async () => {
    const actor = await userFactory();
    const entityId = randomUUID();

    const row = await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'party_domain.captured',
        entityType: 'party_domain',
        entityId,
        metadata: { domain: 'acme.com', nested: { count: 2 }, flag: true },
      },
      db
    );

    expect(row.id).toBeDefined();
    expect(row.actorUserId).toBe(actor.id);
    expect(row.action).toBe('party_domain.captured');
    expect(row.entityType).toBe('party_domain');
    expect(row.entityId).toBe(entityId);
    expect(row.metadata).toEqual({ domain: 'acme.com', nested: { count: 2 }, flag: true });
    expect(row.createdAt).toBeInstanceOf(Date);

    const persisted = await db.select().from(auditEvents).where(eq(auditEvents.id, row.id));
    expect(persisted).toHaveLength(1);
  });

  it('supports a null actor (system/automated event) and defaults metadata to null', async () => {
    const entityId = randomUUID();

    const row = await auditEventsRepository.record(
      {
        actorUserId: null,
        action: 'system.reconciled',
        entityType: 'party_domain',
        entityId,
      },
      db
    );

    expect(row.actorUserId).toBeNull();
    expect(row.metadata).toBeNull();
  });

  it('participates in the caller transaction — the row is absent after a rollback', async () => {
    const actor = await userFactory();
    const entityId = randomUUID();

    await expect(
      db.transaction(async (tx) => {
        await auditEventsRepository.record(
          {
            actorUserId: actor.id,
            action: 'party_domain.captured',
            entityType: 'party_domain',
            entityId,
            metadata: { domain: 'rollback.com' },
          },
          tx
        );
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const persisted = await db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId));
    expect(persisted).toHaveLength(0);
  });
});

describe('auditEventsRepository.countByEntityAndAction', () => {
  it('counts only rows matching entityType + entityId + action (BAL-334 review_cycle)', async () => {
    const actor = await userFactory();
    const engagementId = randomUUID();
    const otherEngagementId = randomUUID();

    // Two completion-request rows for THIS engagement (a withdraw→re-request cycle).
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagementId,
        metadata: { from: 'active', to: 'pending_acceptance', engagementId },
      },
      db
    );
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: engagementId,
        metadata: { from: 'active', to: 'pending_acceptance', engagementId },
      },
      db
    );

    // Negatives that must NOT be counted:
    //  - a different action on the same engagement,
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_withdrawn',
        entityType: 'engagement',
        entityId: engagementId,
        metadata: { engagementId },
      },
      db
    );
    //  - the same action on a DIFFERENT engagement,
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement',
        entityId: otherEngagementId,
        metadata: { engagementId: otherEngagementId },
      },
      db
    );
    //  - the same action + id but a different entityType.
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.completion_requested',
        entityType: 'engagement_milestone',
        entityId: engagementId,
        metadata: { engagementId },
      },
      db
    );

    const count = await auditEventsRepository.countByEntityAndAction({
      entityType: 'engagement',
      entityId: engagementId,
      action: 'engagement.completion_requested',
    });
    expect(count).toBe(2);
  });

  it('returns 0 when no matching rows exist', async () => {
    const count = await auditEventsRepository.countByEntityAndAction({
      entityType: 'engagement',
      entityId: randomUUID(),
      action: 'engagement.completion_requested',
    });
    expect(count).toBe(0);
  });
});
