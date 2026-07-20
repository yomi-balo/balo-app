import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { actionItems, auditEvents, type AuditEvent } from '../schema';
import type { EngagementStatus } from './engagements';
import { engagementFactory, actionItemFactory, userFactory } from '../test/factories';
import { actionItemsRepository, InvalidActionItemTransitionError } from './action-items';
import { EngagementNotActiveError } from './engagement-milestones';

/**
 * Read action-item audit rows for one polymorphic entity from main's generic
 * `audit_events` table (BAL-344). That table has NO `engagement_id` column — the
 * engagement id is FOLDED into `metadata.engagementId` by the audit helper — and is
 * keyed by (`entity_type`, `entity_id`). Ordered createdAt asc, ties by id.
 */
async function auditEventsForEntity(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
}

/** Seed an active engagement + an acting user (the common create fixture). */
async function seedEngagementAndUser(): Promise<{ engagementId: string; userId: string }> {
  const { engagement } = await engagementFactory();
  const user = await userFactory();
  return { engagementId: engagement.id, userId: user.id };
}

async function statusOf(actionItemId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: actionItems.status })
    .from(actionItems)
    .where(eq(actionItems.id, actionItemId));
  return row?.status;
}

describe('actionItemsRepository.createManual', () => {
  it('inserts source=manual, status=open, created_by=userId; writes a created audit row in the same tx', async () => {
    const { engagementId, userId } = await seedEngagementAndUser();

    const created = await actionItemsRepository.createManual({
      engagementId,
      userId,
      body: 'Draft the migration checklist',
    });
    expect(created.source).toBe('manual');
    expect(created.status).toBe('open');
    expect(created.createdByUserId).toBe(userId);
    expect(created.assigneeParty).toBeNull();
    expect(created.assignedByUserId).toBeNull();
    expect(created.assignedAt).toBeNull();
    expect(created.dueAt).toBeNull();

    const events = await auditEventsForEntity(created.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('action_item.created');
    expect(events[0]?.entityType).toBe('action_item');
    expect(events[0]?.entityId).toBe(created.id);
    expect(events[0]?.actorUserId).toBe(userId);
    expect(events[0]?.metadata).toMatchObject({
      source: 'manual',
      assignee_party: null,
      has_due: false,
      engagementId,
    });
  });

  it('create-with-assignee stamps assigned_by/assigned_at and records has_due when a due date is set', async () => {
    const { engagementId, userId } = await seedEngagementAndUser();
    const dueAt = new Date('2026-09-01T00:00:00.000Z');

    const created = await actionItemsRepository.createManual({
      engagementId,
      userId,
      body: 'Send the SOW to the client',
      assigneeParty: 'client',
      dueAt,
      meetingId: null,
    });
    expect(created.assigneeParty).toBe('client');
    expect(created.assignedByUserId).toBe(userId);
    expect(created.assignedAt).toBeInstanceOf(Date);
    expect(created.dueAt?.getTime()).toBe(dueAt.getTime());

    const events = await auditEventsForEntity(created.id);
    expect(events[0]?.metadata).toMatchObject({
      source: 'manual',
      assignee_party: 'client',
      has_due: true,
    });
  });
});

describe('actionItemsRepository.createFromExtraction', () => {
  it('bulk-inserts N ai_extracted items with a null actor and one created audit per row', async () => {
    const { engagement } = await engagementFactory();
    const meetingId = randomUUID();

    const inserted = await actionItemsRepository.createFromExtraction({
      engagementId: engagement.id,
      meetingId,
      actorUserId: null,
      items: [
        { body: 'Confirm the go-live date' },
        { body: 'Assign a QA owner', assigneeParty: 'expert' },
      ],
    });
    expect(inserted).toHaveLength(2);
    inserted.forEach((row) => {
      expect(row.source).toBe('ai_extracted');
      expect(row.status).toBe('open');
      expect(row.createdByUserId).toBeNull(); // no human actor on the ai path
      expect(row.meetingId).toBe(meetingId);
    });

    for (const row of inserted) {
      const events = await auditEventsForEntity(row.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe('action_item.created');
      expect(events[0]?.actorUserId).toBeNull();
      expect(events[0]?.metadata).toMatchObject({
        source: 'ai_extracted',
        engagementId: engagement.id,
      });
    }

    const live = await actionItemsRepository.listByEngagement(engagement.id);
    expect(live).toHaveLength(2);
    const byMeeting = await actionItemsRepository.listByMeeting(meetingId);
    expect(byMeeting.map((r) => r.id).sort()).toEqual(inserted.map((r) => r.id).sort());
  });

  it('empty items → [] (no lock, no rows, no audit)', async () => {
    const { engagement } = await engagementFactory();
    const inserted = await actionItemsRepository.createFromExtraction({
      engagementId: engagement.id,
      items: [],
    });
    expect(inserted).toEqual([]);
    expect(await actionItemsRepository.listByEngagement(engagement.id)).toHaveLength(0);
  });
});

describe('actionItemsRepository.assign', () => {
  it('assigns an unassigned item to a side, stamping assigned_by/assigned_at + { from: null, to } audit', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({ engagementId: engagement.id });
    const user = await userFactory();

    const updated = await actionItemsRepository.assign({
      actionItemId: actionItem.id,
      userId: user.id,
      assigneeParty: 'expert',
    });
    expect(updated.assigneeParty).toBe('expert');
    expect(updated.assignedByUserId).toBe(user.id);
    expect(updated.assignedAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.action).toBe('action_item.assigned');
    expect(events[0]?.metadata).toMatchObject({
      from: null,
      to: 'expert',
      engagementId: engagement.id,
    });
  });

  it('reassigns from one side to the other with { from, to } audit metadata', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { assigneeParty: 'expert' },
    });
    const user = await userFactory();

    const updated = await actionItemsRepository.assign({
      actionItemId: actionItem.id,
      userId: user.id,
      assigneeParty: 'client',
    });
    expect(updated.assigneeParty).toBe('client');

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.metadata).toMatchObject({ from: 'expert', to: 'client' });
  });

  it('clears an assignment (null) → CLEARS assigned_by/assigned_at, { from, to: null } audit', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { assigneeParty: 'client', assignedAt: new Date() },
    });
    const user = await userFactory();

    const updated = await actionItemsRepository.assign({
      actionItemId: actionItem.id,
      userId: user.id,
      assigneeParty: null,
    });
    expect(updated.assigneeParty).toBeNull();
    expect(updated.assignedByUserId).toBeNull();
    expect(updated.assignedAt).toBeNull();

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.metadata).toMatchObject({ from: 'client', to: null });
  });
});

describe('actionItemsRepository.complete / reopen', () => {
  it('open → done stamps completed_by/completed_at + completed audit', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({ engagementId: engagement.id });
    const user = await userFactory();

    const done = await actionItemsRepository.complete({
      actionItemId: actionItem.id,
      userId: user.id,
    });
    expect(done.status).toBe('done');
    expect(done.completedByUserId).toBe(user.id);
    expect(done.completedAt).toBeInstanceOf(Date);

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.action).toBe('action_item.completed');
    expect(events[0]?.metadata).toMatchObject({
      from: 'open',
      to: 'done',
      engagementId: engagement.id,
    });
  });

  it('done → open CLEARS completed_by/completed_at + reopened audit', async () => {
    const { engagement } = await engagementFactory();
    const priorUser = await userFactory();
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { status: 'done', completedByUserId: priorUser.id, completedAt: new Date() },
    });
    const user = await userFactory();

    const reopened = await actionItemsRepository.reopen({
      actionItemId: actionItem.id,
      userId: user.id,
    });
    expect(reopened.status).toBe('open');
    expect(reopened.completedByUserId).toBeNull();
    expect(reopened.completedAt).toBeNull();

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.action).toBe('action_item.reopened');
    expect(events[0]?.metadata).toMatchObject({ from: 'done', to: 'open' });
  });

  it('double-complete (done → done) throws InvalidActionItemTransitionError and mutates nothing', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { status: 'done' },
    });
    const user = await userFactory();
    await expect(
      actionItemsRepository.complete({ actionItemId: actionItem.id, userId: user.id })
    ).rejects.toBeInstanceOf(InvalidActionItemTransitionError);
    expect(await statusOf(actionItem.id)).toBe('done');
  });

  it('double-reopen (open → open) throws InvalidActionItemTransitionError and mutates nothing', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({ engagementId: engagement.id });
    const user = await userFactory();
    await expect(
      actionItemsRepository.reopen({ actionItemId: actionItem.id, userId: user.id })
    ).rejects.toBeInstanceOf(InvalidActionItemTransitionError);
    expect(await statusOf(actionItem.id)).toBe('open');
  });
});

describe('actionItemsRepository.edit', () => {
  it('partial edit writes only provided keys and audits { fields }', async () => {
    const { engagement } = await engagementFactory();
    const dueAt = new Date('2026-08-01T00:00:00.000Z');
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { body: 'Old body', dueAt },
    });
    const user = await userFactory();

    const updated = await actionItemsRepository.edit({
      actionItemId: actionItem.id,
      userId: user.id,
      body: 'New body',
    });
    expect(updated.body).toBe('New body');
    // dueAt not provided → unchanged.
    expect(updated.dueAt?.getTime()).toBe(dueAt.getTime());
    expect(updated.status).toBe('open'); // no status change

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.action).toBe('action_item.edited');
    expect(events[0]?.metadata).toMatchObject({ fields: ['body'], engagementId: engagement.id });
  });

  it('explicit null dueAt clears the due date; fields records both changed keys', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { body: 'Body', dueAt: new Date('2026-08-01T00:00:00.000Z') },
    });
    const user = await userFactory();

    const updated = await actionItemsRepository.edit({
      actionItemId: actionItem.id,
      userId: user.id,
      body: 'Body v2',
      dueAt: null,
    });
    expect(updated.dueAt).toBeNull();

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.metadata).toMatchObject({ fields: ['body', 'dueAt'] });
  });
});

describe('actionItemsRepository.softRemove', () => {
  it('sets deleted_at, hides from listByEngagement, audits removed', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({ engagementId: engagement.id });
    const user = await userFactory();

    const removed = await actionItemsRepository.softRemove({
      actionItemId: actionItem.id,
      userId: user.id,
    });
    expect(removed.deletedAt).toBeInstanceOf(Date);

    const live = await actionItemsRepository.listByEngagement(engagement.id);
    expect(live.map((r) => r.id)).not.toContain(actionItem.id);

    const events = await auditEventsForEntity(actionItem.id);
    expect(events[0]?.action).toBe('action_item.removed');
    expect(events[0]?.metadata).toMatchObject({ engagementId: engagement.id });
  });
});

describe('actionItemsRepository.listByEngagement', () => {
  it('returns live items only, ordered created_at asc then id asc', async () => {
    const { engagement } = await engagementFactory();
    const t0 = new Date('2026-01-01T00:00:00.000Z');
    await actionItemFactory({
      engagementId: engagement.id,
      values: { body: 'First', createdAt: t0 },
    });
    await actionItemFactory({
      engagementId: engagement.id,
      values: { body: 'Second', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    });
    await actionItemFactory({
      engagementId: engagement.id,
      values: {
        body: 'Deleted',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
        deletedAt: new Date(),
      },
    });

    const list = await actionItemsRepository.listByEngagement(engagement.id);
    expect(list.map((r) => r.body)).toEqual(['First', 'Second']);
  });
});

describe('actionItemsRepository.findById (IDOR discovery gate)', () => {
  it('returns a live item so the caller can discover + verify its engagementId', async () => {
    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({ engagementId: engagement.id });

    const found = await actionItemsRepository.findById(actionItem.id);
    expect(found?.id).toBe(actionItem.id);
    expect(found?.engagementId).toBe(engagement.id);
  });

  it('returns undefined for a missing id and for a soft-removed item', async () => {
    expect(await actionItemsRepository.findById(randomUUID())).toBeUndefined();

    const { engagement } = await engagementFactory();
    const { actionItem } = await actionItemFactory({
      engagementId: engagement.id,
      values: { deletedAt: new Date() },
    });
    expect(await actionItemsRepository.findById(actionItem.id)).toBeUndefined();
  });

  it('throws "Action item not found" when a mutation targets a missing item', async () => {
    const user = await userFactory();
    await expect(
      actionItemsRepository.complete({ actionItemId: randomUUID(), userId: user.id })
    ).rejects.toThrow(/Action item not found/);
  });
});

describe('actionItemsRepository — engagement-active guard (EngagementNotActiveError)', () => {
  const nonActiveStatuses: EngagementStatus[] = ['pending_acceptance', 'completed', 'cancelled'];

  for (const status of nonActiveStatuses) {
    it(`every mutating op throws EngagementNotActiveError when the engagement is ${status}`, async () => {
      const { engagement } = await engagementFactory({ values: { status } });
      const { actionItem } = await actionItemFactory({ engagementId: engagement.id });
      const user = await userFactory();
      const actionItemId = actionItem.id;
      const userId = user.id;

      await expect(
        actionItemsRepository.createManual({ engagementId: engagement.id, userId, body: 'x' })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        actionItemsRepository.createFromExtraction({
          engagementId: engagement.id,
          actorUserId: userId,
          items: [{ body: 'y' }],
        })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        actionItemsRepository.assign({ actionItemId, userId, assigneeParty: 'client' })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(actionItemsRepository.complete({ actionItemId, userId })).rejects.toBeInstanceOf(
        EngagementNotActiveError
      );
      await expect(actionItemsRepository.reopen({ actionItemId, userId })).rejects.toBeInstanceOf(
        EngagementNotActiveError
      );
      await expect(
        actionItemsRepository.edit({ actionItemId, userId, body: 'z' })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
      await expect(
        actionItemsRepository.softRemove({ actionItemId, userId })
      ).rejects.toBeInstanceOf(EngagementNotActiveError);
    });
  }
});

describe('action_items body CHECK constraint', () => {
  it('rejects a blank/whitespace-only body at the DB layer', async () => {
    const { engagementId, userId } = await seedEngagementAndUser();
    await expect(
      actionItemsRepository.createManual({ engagementId, userId, body: '   ' })
    ).rejects.toThrow();
  });
});
