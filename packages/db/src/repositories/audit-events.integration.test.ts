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

describe('auditEventsRepository.countByActorAndActionSince', () => {
  /** Append one `engagement.created` row for `actor`, stamped at `createdAt`. */
  async function seedCreated(actorUserId: string, createdAt: Date): Promise<void> {
    const row = await auditEventsRepository.record(
      {
        actorUserId,
        action: 'engagement.created',
        entityType: 'engagement',
        entityId: randomUUID(),
        metadata: { engagement_type: 'case' },
      },
      db
    );
    await db.update(auditEvents).set({ createdAt }).where(eq(auditEvents.id, row.id));
  }

  it('counts one actor’s rows for one action inside the window (BAL-400 S6)', async () => {
    const actor = await userFactory();
    const other = await userFactory();
    const now = Date.now();
    const since = new Date(now - 3_600_000);

    await seedCreated(actor.id, new Date(now - 60_000));
    await seedCreated(actor.id, new Date(now - 120_000));

    // Negatives that must NOT be counted:
    //  - the same action, same actor, but OUTSIDE the window,
    await seedCreated(actor.id, new Date(now - 7_200_000));
    //  - the same action inside the window, but a DIFFERENT actor,
    await seedCreated(other.id, new Date(now - 60_000));
    //  - a different action by the same actor inside the window.
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.accepted',
        entityType: 'engagement',
        entityId: randomUUID(),
      },
      db
    );

    const count = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: actor.id,
      action: 'engagement.created',
      since,
    });
    expect(count).toBe(2);
  });

  it('is inclusive at the boundary instant', async () => {
    const actor = await userFactory();
    const boundary = new Date('2026-01-01T00:00:00.000Z');
    await seedCreated(actor.id, boundary);

    await expect(
      auditEventsRepository.countByActorAndActionSince({
        actorUserId: actor.id,
        action: 'engagement.created',
        since: boundary,
      })
    ).resolves.toBe(1);
    await expect(
      auditEventsRepository.countByActorAndActionSince({
        actorUserId: actor.id,
        action: 'engagement.created',
        since: new Date(boundary.getTime() + 1),
      })
    ).resolves.toBe(0);
  });

  it('returns 0 for an actor with no rows at all', async () => {
    const actor = await userFactory();
    await expect(
      auditEventsRepository.countByActorAndActionSince({
        actorUserId: actor.id,
        action: 'engagement.created',
        since: new Date(0),
      })
    ).resolves.toBe(0);
  });

  it('N2 — engagementType: "case" excludes project kickoffs from the count, even though both emit the SAME action', async () => {
    // `engagement.created` is deliberately type-agnostic (BAL-417): a case create and a
    // project kickoff both write it, distinguished only by `metadata.engagement_type`. The
    // hop-1 booking budget (BAL-400 S6) must count ONLY case creates, or a burst of approved
    // project kickoffs would exhaust a client's case-booking budget with no case involved.
    const actor = await userFactory();
    const now = Date.now();
    const since = new Date(now - 3_600_000);

    await seedCreated(actor.id, new Date(now - 60_000)); // case, in window
    const projectRow = await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'engagement.created',
        entityType: 'engagement',
        entityId: randomUUID(),
        metadata: { engagement_type: 'project' },
      },
      db
    );
    await db
      .update(auditEvents)
      .set({ createdAt: new Date(now - 60_000) })
      .where(eq(auditEvents.id, projectRow.id));

    const caseOnlyCount = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: actor.id,
      action: 'engagement.created',
      engagementType: 'case',
      since,
    });
    expect(caseOnlyCount).toBe(1);

    const unfilteredCount = await auditEventsRepository.countByActorAndActionSince({
      actorUserId: actor.id,
      action: 'engagement.created',
      since,
    });
    expect(unfilteredCount).toBe(2);
  });
});

describe('auditEventsRepository.findLatestByEntityAndAction', () => {
  it('returns the most-recent row by created_at for the entity + action', async () => {
    const older = await userFactory();
    const newer = await userFactory();
    const companyId = randomUUID();

    const first = await auditEventsRepository.record(
      {
        actorUserId: older.id,
        action: 'company.join_mode_changed',
        entityType: 'company',
        entityId: companyId,
        metadata: { from: 'auto', to: 'request' },
      },
      db
    );
    const second = await auditEventsRepository.record(
      {
        actorUserId: newer.id,
        action: 'company.join_mode_changed',
        entityType: 'company',
        entityId: companyId,
        metadata: { from: 'request', to: 'off' },
      },
      db
    );
    // Force a deterministic ordering (first older than second).
    await db
      .update(auditEvents)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(auditEvents.id, first.id));
    await db
      .update(auditEvents)
      .set({ createdAt: new Date('2021-01-01T00:00:00Z') })
      .where(eq(auditEvents.id, second.id));

    // A different action on the same entity must NOT win.
    await auditEventsRepository.record(
      {
        actorUserId: older.id,
        action: 'company.renamed',
        entityType: 'company',
        entityId: companyId,
      },
      db
    );

    const latest = await auditEventsRepository.findLatestByEntityAndAction({
      entityType: 'company',
      entityId: companyId,
      action: 'company.join_mode_changed',
    });

    expect(latest?.actorUserId).toBe(newer.id);
    expect(latest?.createdAt).toBeInstanceOf(Date);
  });

  it('returns undefined when the action has never occurred for the entity', async () => {
    await expect(
      auditEventsRepository.findLatestByEntityAndAction({
        entityType: 'company',
        entityId: randomUUID(),
        action: 'company.join_mode_changed',
      })
    ).resolves.toBeUndefined();
  });
});
