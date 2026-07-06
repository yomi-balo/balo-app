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
    expect(row.deletedAt).toBeNull();

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
