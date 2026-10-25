import { describe, it, expect } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  engagementChangeOrderLines,
  engagementChangeOrders,
  engagementMilestones,
  projectEngagements,
  type AuditEvent,
  type EngagementMilestone,
} from '../schema';
import {
  engagementChangeOrderFactory,
  engagementFactory,
  engagementMilestoneFactory,
  proposalPaymentInstallmentFactory,
  userFactory,
} from '../test/factories';
import {
  engagementChangeOrdersRepository as repo,
  ChangeOrderAlreadyOpenError,
  ChangeOrderNotFoundError,
  InvalidChangeOrderTransitionError,
  isAllowedChangeOrderTransition,
  type ChangeOrderLineInput,
} from './engagement-change-orders';
import { ChangeOrderCoherenceError } from './change-order-coherence';
import { EngagementNotActiveError } from './_shared/engagement-lock';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';

async function auditFor(entityId: string): Promise<AuditEvent[]> {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));
}

async function liveMilestones(engagementId: string): Promise<EngagementMilestone[]> {
  const rows = await db
    .select()
    .from(engagementMilestones)
    .where(eq(engagementMilestones.engagementId, engagementId))
    .orderBy(asc(engagementMilestones.sortOrder), asc(engagementMilestones.id));
  return rows.filter((m) => m.deletedAt === null);
}

/** An active fixed-price project at A$5,000 with two milestones and an acting user. */
async function seedProject(overrides: Parameters<typeof engagementFactory>[0] = {}): Promise<{
  engagementId: string;
  userId: string;
  first: EngagementMilestone;
  second: EngagementMilestone;
}> {
  const { engagement } = await engagementFactory(overrides);
  const { milestone: first } = await engagementMilestoneFactory({
    engagementId: engagement.id,
    values: {
      sortOrder: 0,
      title: 'Discovery',
      descriptionHtml: '<p>Map it</p>',
      valueCents: 200_000,
    },
  });
  const { milestone: second } = await engagementMilestoneFactory({
    engagementId: engagement.id,
    values: { sortOrder: 1, title: 'Build', status: 'completed', valueCents: 300_000 },
  });
  const user = await userFactory();
  return { engagementId: engagement.id, userId: user.id, first, second };
}

function line(
  overrides: Partial<ChangeOrderLineInput> & Pick<ChangeOrderLineInput, 'op'>
): ChangeOrderLineInput {
  return {
    engagementMilestoneId: null,
    title: 'Data migration',
    descriptionHtml: null,
    acceptanceCriteria: null,
    valueCents: null,
    estimatedMinutes: null,
    ...overrides,
  };
}

/** A sent fixed-price order: add one milestone, edit `first`, remove `second`, +A$1,500. */
async function seedSentOrder(): Promise<{
  engagementId: string;
  userId: string;
  orderId: string;
  first: EngagementMilestone;
  second: EngagementMilestone;
}> {
  const seeded = await seedProject();
  const draft = await repo.createDraft({
    engagementId: seeded.engagementId,
    userId: seeded.userId,
    note: 'Adds a migration and folds the build in.',
    newTotalCents: 650_000,
    lines: [
      line({ op: 'add', title: 'Data migration', descriptionHtml: '<p>Move it</p>' }),
      line({ op: 'edit', engagementMilestoneId: seeded.first.id, title: 'Discovery v2' }),
      line({ op: 'remove', engagementMilestoneId: seeded.second.id, title: 'Build' }),
    ],
  });
  await repo.send({ engagementId: seeded.engagementId, orderId: draft.id, userId: seeded.userId });
  return { ...seeded, orderId: draft.id };
}

describe('CHANGE_ORDER_TRANSITIONS', () => {
  it('allows the design moves and nothing out of a terminal state', () => {
    expect(isAllowedChangeOrderTransition('requested', 'draft')).toBe(true);
    expect(isAllowedChangeOrderTransition('draft', 'requested')).toBe(true);
    expect(isAllowedChangeOrderTransition('sent', 'approved')).toBe(true);
    expect(isAllowedChangeOrderTransition('requested', 'sent')).toBe(false);
    expect(isAllowedChangeOrderTransition('approved', 'withdrawn')).toBe(false);
  });
});

describe('engagementChangeOrdersRepository.requestByClient', () => {
  it('opens a requested order with the client note and actor stamps, and audits it', async () => {
    const { engagementId, userId } = await seedProject();

    const order = await repo.requestByClient({ engagementId, userId, note: 'Add a migration?' });

    expect(order.status).toBe('requested');
    expect(order.requestNote).toBe('Add a migration?');
    expect(order.requestedByUserId).toBe(userId);
    expect(order.requestedAt).toBeInstanceOf(Date);
    expect(order.createdByUserId).toBe(userId);
    expect(order.lines).toEqual([]);
    const events = await auditFor(order.id);
    expect(events.map((e) => e.action)).toEqual(['engagement.change_order_requested']);
    expect(events[0]?.entityType).toBe('engagement_change_order');
    expect(events[0]?.metadata).toMatchObject({ engagementId });
  });

  it('refuses a second open order on the same engagement', async () => {
    const { engagementId, userId } = await seedProject();
    await repo.requestByClient({ engagementId, userId, note: 'One' });

    await expect(
      repo.requestByClient({ engagementId, userId, note: 'Two' })
    ).rejects.toBeInstanceOf(ChangeOrderAlreadyOpenError);
    await expect(
      repo.createDraft({ engagementId, userId, note: null, newTotalCents: null, lines: [] })
    ).rejects.toBeInstanceOf(ChangeOrderAlreadyOpenError);
  });

  it('allows a new order once the open one is decided or withdrawn', async () => {
    const { engagementId, userId } = await seedProject();
    await engagementChangeOrderFactory({ engagementId, status: 'declined' });
    await engagementChangeOrderFactory({ engagementId, status: 'withdrawn' });

    const order = await repo.requestByClient({ engagementId, userId, note: 'Again' });
    expect(order.status).toBe('requested');
  });
});

describe('engagementChangeOrdersRepository on a project that is not active', () => {
  it('refuses every write with EngagementNotActiveError', async () => {
    const { engagement } = await engagementFactory({
      projectValues: { deliveryStatus: 'pending_acceptance' },
    });
    const engagementId = engagement.id;
    const { id: userId } = await userFactory();
    const { order: draft } = await engagementChangeOrderFactory({ engagementId, status: 'draft' });
    const ids = { engagementId, orderId: draft.id, userId };
    const empty = { note: null, newTotalCents: null, lines: [] };

    // Sequential thunks: the test harness runs on one connection, so the writes must not interleave.
    const attempts: (() => Promise<unknown>)[] = [
      () => repo.requestByClient({ engagementId, userId, note: 'x' }),
      () => repo.createDraft({ engagementId, userId, ...empty }),
      () => repo.createDraft({ engagementId, userId, fromOrderId: draft.id, ...empty }),
      () => repo.replaceLines({ ...ids, ...empty }),
      () => repo.send(ids),
      () => repo.withdraw({ ...ids, expectedFrom: 'draft' }),
      () => repo.returnDraftToRequest(ids),
      () => repo.decline({ ...ids, reason: 'x', expectedFrom: 'sent' }),
      () => repo.approve(ids),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(EngagementNotActiveError);
    }
  });
});

describe('engagementChangeOrdersRepository order-keyed guard', () => {
  it('treats an order on another engagement as not found', async () => {
    const mine = await seedProject();
    const other = await seedProject();
    const { order } = await engagementChangeOrderFactory({
      engagementId: other.engagementId,
      status: 'draft',
    });

    await expect(
      repo.withdraw({
        engagementId: mine.engagementId,
        orderId: order.id,
        userId: mine.userId,
        expectedFrom: 'draft',
      })
    ).rejects.toBeInstanceOf(ChangeOrderNotFoundError);
  });
});

describe('engagementChangeOrdersRepository.createDraft', () => {
  it('opens a fresh draft with its lines in order, without a coherence check', async () => {
    const { engagementId, userId, first } = await seedProject();

    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: null,
      newTotalCents: null,
      lines: [
        line({ op: 'add' }),
        line({ op: 'edit', engagementMilestoneId: first.id, title: 'D2' }),
      ],
    });

    expect(draft.status).toBe('draft');
    expect(draft.requestedAt).toBeNull();
    expect(draft.lines.map((l) => [l.op, l.sortOrder])).toEqual([
      ['add', 0],
      ['edit', 1],
    ]);
    expect((await auditFor(draft.id)).map((e) => e.action)).toEqual([
      'engagement.change_order_drafted',
    ]);
  });

  it('turns an open request into a draft that keeps the request stamps', async () => {
    const { engagementId, userId } = await seedProject();
    const requested = await repo.requestByClient({ engagementId, userId, note: 'Please' });

    const draft = await repo.createDraft({
      engagementId,
      userId,
      fromOrderId: requested.id,
      note: 'Sure',
      newTotalCents: 510_000,
      lines: [line({ op: 'add' })],
    });

    expect(draft.id).toBe(requested.id);
    expect(draft.status).toBe('draft');
    expect(draft.requestedAt).toEqual(requested.requestedAt);
    expect(draft.priceDeltaCents).toBe(10_000);
    expect(draft.lines).toHaveLength(1);
  });

  it('refuses fromOrderId on an order that is not requested', async () => {
    const { engagementId, userId } = await seedProject();
    const { order } = await engagementChangeOrderFactory({ engagementId, status: 'draft' });

    await expect(
      repo.createDraft({
        engagementId,
        userId,
        fromOrderId: order.id,
        note: null,
        newTotalCents: null,
        lines: [],
      })
    ).rejects.toBeInstanceOf(InvalidChangeOrderTransitionError);
  });
});

describe('engagementChangeOrdersRepository.replaceLines', () => {
  it('soft-deletes the old lines and writes the new ones on a draft', async () => {
    const { engagementId, userId } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'v1',
      newTotalCents: null,
      lines: [line({ op: 'add', title: 'Old' })],
    });

    const replaced = await repo.replaceLines({
      engagementId,
      orderId: draft.id,
      userId,
      note: 'v2',
      newTotalCents: 505_000,
      lines: [line({ op: 'add', title: 'New A' }), line({ op: 'add', title: 'New B' })],
    });

    expect(replaced.note).toBe('v2');
    expect(replaced.priceDeltaCents).toBe(5_000);
    expect(replaced.lines.map((l) => l.title)).toEqual(['New A', 'New B']);
    const all = await db
      .select()
      .from(engagementChangeOrderLines)
      .where(eq(engagementChangeOrderLines.changeOrderId, draft.id));
    expect(all.filter((l) => l.deletedAt !== null).map((l) => l.title)).toEqual(['Old']);
  });

  it('refuses a sent order', async () => {
    const { engagementId, orderId, userId } = await seedSentOrder();
    await expect(
      repo.replaceLines({
        engagementId,
        orderId,
        userId,
        note: 'x',
        newTotalCents: null,
        lines: [],
      })
    ).rejects.toBeInstanceOf(InvalidChangeOrderTransitionError);
  });
});

describe('engagementChangeOrdersRepository.send', () => {
  it('stamps before_* on edit/remove lines and moves the draft to sent', async () => {
    const { engagementId, orderId, userId, first, second } = await seedSentOrder();

    const [order] = await db
      .select()
      .from(engagementChangeOrders)
      .where(eq(engagementChangeOrders.id, orderId));
    expect(order?.status).toBe('sent');
    expect(order?.sentByUserId).toBe(userId);
    expect(order?.sentAt).toBeInstanceOf(Date);

    const lines = await db
      .select()
      .from(engagementChangeOrderLines)
      .where(eq(engagementChangeOrderLines.changeOrderId, orderId))
      .orderBy(asc(engagementChangeOrderLines.sortOrder));
    expect(lines.map((l) => [l.op, l.beforeTitle, l.beforeDescriptionHtml])).toEqual([
      ['add', null, null],
      ['edit', first.title, first.descriptionHtml],
      ['remove', second.title, null],
    ]);
    const events = await auditFor(orderId);
    expect(events.map((e) => e.action)).toEqual([
      'engagement.change_order_drafted',
      'engagement.change_order_sent',
    ]);
    expect(events[1]?.metadata).toMatchObject({ engagementId, price_delta_cents: 150_000 });
  });

  it('refuses an incoherent draft and leaves it a draft with nothing stamped', async () => {
    const { engagementId, userId, first } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: '   ',
      newTotalCents: null,
      lines: [line({ op: 'edit', engagementMilestoneId: first.id, title: 'D2' })],
    });

    await expect(repo.send({ engagementId, orderId: draft.id, userId })).rejects.toMatchObject({
      rule: 'note_missing',
    });
    const [order] = await db
      .select()
      .from(engagementChangeOrders)
      .where(eq(engagementChangeOrders.id, draft.id));
    expect(order?.status).toBe('draft');
    const [stored] = await db
      .select()
      .from(engagementChangeOrderLines)
      .where(eq(engagementChangeOrderLines.changeOrderId, draft.id));
    expect(stored?.beforeTitle).toBeNull();
  });

  it('refuses a requested order (it must be drafted first)', async () => {
    const { engagementId, userId } = await seedProject();
    const requested = await repo.requestByClient({ engagementId, userId, note: 'x' });
    await expect(repo.send({ engagementId, orderId: requested.id, userId })).rejects.toBeInstanceOf(
      InvalidChangeOrderTransitionError
    );
  });
});

describe('engagementChangeOrdersRepository.withdraw / decline change nothing else', () => {
  it('withdrawing a sent order leaves the milestones and the effective price byte-equal', async () => {
    const { engagementId, orderId, userId } = await seedSentOrder();
    const before = await liveMilestones(engagementId);
    const priceBefore = await repo.effectivePriceCents(engagementId);

    await expect(
      repo.withdraw({ engagementId, orderId, userId, expectedFrom: 'draft' })
    ).rejects.toBeInstanceOf(InvalidChangeOrderTransitionError);
    const withdrawn = await repo.withdraw({ engagementId, orderId, userId, expectedFrom: 'sent' });

    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.withdrawnByUserId).toBe(userId);
    expect(await liveMilestones(engagementId)).toEqual(before);
    expect(await repo.effectivePriceCents(engagementId)).toBe(priceBefore);
  });

  it('declining a sent order records the reason and changes nothing else', async () => {
    const { engagementId, orderId, userId } = await seedSentOrder();
    const before = await liveMilestones(engagementId);

    const declined = await repo.decline({
      engagementId,
      orderId,
      userId,
      reason: 'Not now',
      expectedFrom: 'sent',
    });

    expect(declined.status).toBe('declined');
    expect(declined.declineReason).toBe('Not now');
    expect(declined.decidedByUserId).toBe(userId);
    expect(await liveMilestones(engagementId)).toEqual(before);
    expect(await repo.effectivePriceCents(engagementId)).toBe(500_000);
    const events = await auditFor(orderId);
    expect(events.at(-1)?.action).toBe('engagement.change_order_declined');
    expect(events.at(-1)?.metadata).toMatchObject({ from: 'sent' });
  });

  it('answers a request without a change order: declined, never sent', async () => {
    const { engagementId, userId } = await seedProject();
    const requested = await repo.requestByClient({ engagementId, userId, note: 'Can we?' });

    await expect(
      repo.decline({
        engagementId,
        orderId: requested.id,
        userId,
        reason: 'x',
        expectedFrom: 'sent',
      })
    ).rejects.toBeInstanceOf(InvalidChangeOrderTransitionError);
    const answered = await repo.decline({
      engagementId,
      orderId: requested.id,
      userId,
      reason: 'Already covered by milestone 2.',
      expectedFrom: 'requested',
    });

    expect(answered.status).toBe('declined');
    expect(answered.sentAt).toBeNull();
    expect(answered.declineReason).toBe('Already covered by milestone 2.');
  });
});

describe('engagementChangeOrdersRepository.returnDraftToRequest', () => {
  it('returns a request-origin draft to requested with its lines cleared', async () => {
    const { engagementId, userId } = await seedProject();
    const requested = await repo.requestByClient({ engagementId, userId, note: 'Please' });
    await repo.createDraft({
      engagementId,
      userId,
      fromOrderId: requested.id,
      note: 'Draft note',
      newTotalCents: 501_000,
      lines: [line({ op: 'add' })],
    });

    const returned = await repo.returnDraftToRequest({
      engagementId,
      orderId: requested.id,
      userId,
    });

    expect(returned.status).toBe('requested');
    expect(returned.note).toBeNull();
    expect(returned.priceDeltaCents).toBeNull();
    expect(returned.requestNote).toBe('Please');
    expect(returned.lines).toEqual([]);
    expect((await auditFor(requested.id)).at(-1)?.action).toBe(
      'engagement.change_order_draft_discarded'
    );
  });

  it('refuses a fresh draft (it has no request to return to)', async () => {
    const { engagementId, userId } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: null,
      newTotalCents: null,
      lines: [],
    });
    await expect(
      repo.returnDraftToRequest({ engagementId, orderId: draft.id, userId })
    ).rejects.toBeInstanceOf(InvalidChangeOrderTransitionError);
  });
});

describe('engagementChangeOrdersRepository.approve', () => {
  it('applies add, edit and remove in one transaction and moves the effective price', async () => {
    const { engagementId, orderId, userId, first, second } = await seedSentOrder();
    const approver = await userFactory();

    const result = await repo.approve({ engagementId, orderId, userId: approver.id });

    expect(result.order.status).toBe('approved');
    expect(result.order.decidedByUserId).toBe(approver.id);
    expect(result.previousEffectivePriceCents).toBe(500_000);
    expect(result.effectivePriceCents).toBe(650_000);
    expect(await repo.effectivePriceCents(engagementId)).toBe(650_000);

    const live = await liveMilestones(engagementId);
    expect(live.map((m) => m.title)).toEqual(['Discovery v2', 'Data migration']);
    const added = live.find((m) => m.title === 'Data migration');
    expect(added?.status).toBe('pending');
    expect(added?.createdByUserId).toBe(userId);
    expect(added?.sourceProposalMilestoneId).toBeNull();
    expect(added?.sortOrder).toBe(2);
    expect(live.find((m) => m.id === first.id)?.valueCents).toBe(200_000);
    expect(live.some((m) => m.id === second.id)).toBe(false);

    const addLine = result.order.lines.find((l) => l.op === 'add');
    expect(addLine?.engagementMilestoneId).toBe(added?.id);
    expect(result.appliedMilestoneIds).toEqual([added?.id, first.id, second.id]);

    const [child] = await db
      .select({ priceCents: projectEngagements.priceCents })
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagementId));
    expect(child?.priceCents).toBe(500_000);

    const milestoneAudit = await auditFor(first.id);
    expect(milestoneAudit.at(-1)?.action).toBe('engagement_milestone.edited');
    expect(milestoneAudit.at(-1)?.metadata).toMatchObject({ changeOrderId: orderId });
    expect((await auditFor(orderId)).at(-1)?.metadata).toMatchObject({
      price_delta_cents: 150_000,
    });
  });

  it('writes value_cents on an edit only when the line carries one', async () => {
    const { engagementId, userId, first } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'Re-price discovery',
      newTotalCents: 550_000,
      lines: [
        line({ op: 'edit', engagementMilestoneId: first.id, title: 'D', valueCents: 250_000 }),
      ],
    });
    await repo.send({ engagementId, orderId: draft.id, userId });

    await repo.approve({ engagementId, orderId: draft.id, userId });

    const [edited] = await db
      .select()
      .from(engagementMilestones)
      .where(eq(engagementMilestones.id, first.id));
    expect(edited?.valueCents).toBe(250_000);
  });

  it('writes the estimate on a T&M edit and leaves the price alone', async () => {
    const { engagementId, userId, first } = await seedProject({
      projectValues: { pricingMethod: 'tm', priceCents: 0, rateCents: 20_000, cadence: 'monthly' },
    });
    await db
      .update(engagementMilestones)
      .set({ valueCents: null, estimatedMinutes: 600 })
      .where(eq(engagementMilestones.engagementId, engagementId));
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'More discovery time',
      newTotalCents: null,
      lines: [
        line({ op: 'edit', engagementMilestoneId: first.id, title: 'D', estimatedMinutes: 900 }),
      ],
    });
    await repo.send({ engagementId, orderId: draft.id, userId });

    const result = await repo.approve({ engagementId, orderId: draft.id, userId });

    expect(result.effectivePriceCents).toBe(0);
    const [edited] = await db
      .select()
      .from(engagementMilestones)
      .where(eq(engagementMilestones.id, first.id));
    expect(edited?.estimatedMinutes).toBe(900);
    const [stored] = result.order.lines;
    expect(stored?.beforeEstimatedMinutes).toBe(600);
  });

  it('refuses before any write when a line target is no longer live', async () => {
    const { engagementId, orderId, userId, second } = await seedSentOrder();
    await db
      .update(engagementMilestones)
      .set({ deletedAt: new Date() })
      .where(eq(engagementMilestones.id, second.id));
    const before = await liveMilestones(engagementId);

    const attempt = repo.approve({ engagementId, orderId, userId });

    await expect(attempt).rejects.toBeInstanceOf(ChangeOrderCoherenceError);
    await expect(attempt).rejects.toMatchObject({ rule: 'line_target_not_live' });
    expect(await liveMilestones(engagementId)).toEqual(before);
    const [order] = await db
      .select()
      .from(engagementChangeOrders)
      .where(eq(engagementChangeOrders.id, orderId));
    expect(order?.status).toBe('sent');
    expect(await repo.effectivePriceCents(engagementId)).toBe(500_000);
  });

  it('rolls back an already-applied line when a later line fails in the database', async () => {
    const { engagementId, orderId, userId, first } = await seedSentOrder();
    const before = await liveMilestones(engagementId);
    // A trigger scoped to this test's rolled-back transaction fails the edit line. Its message
    // says whether the add line's milestone was already inserted when the edit failed.
    await db.execute(sql`
      CREATE FUNCTION bal622_fail_edit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM engagement_milestones
          WHERE engagement_id = NEW.engagement_id AND title = 'Data migration'
        ) THEN
          RAISE EXCEPTION 'forced failure after the add line applied';
        END IF;
        RAISE EXCEPTION 'forced failure before the add line applied';
      END;
      $$
    `);
    await db.execute(sql`
      CREATE TRIGGER bal622_fail_edit BEFORE UPDATE ON engagement_milestones
      FOR EACH ROW WHEN (NEW.title = 'Discovery v2') EXECUTE FUNCTION bal622_fail_edit()
    `);

    await expect(repo.approve({ engagementId, orderId, userId })).rejects.toThrow(
      'forced failure after the add line applied'
    );

    const all = await db
      .select()
      .from(engagementMilestones)
      .where(eq(engagementMilestones.engagementId, engagementId));
    expect(all.some((m) => m.title === 'Data migration')).toBe(false);
    expect(await liveMilestones(engagementId)).toEqual(before);
    const lines = await db
      .select()
      .from(engagementChangeOrderLines)
      .where(eq(engagementChangeOrderLines.changeOrderId, orderId));
    expect(lines.find((l) => l.op === 'add')?.engagementMilestoneId).toBeNull();
    const [order] = await db
      .select()
      .from(engagementChangeOrders)
      .where(eq(engagementChangeOrders.id, orderId));
    expect(order?.status).toBe('sent');
    expect(order?.decidedAt).toBeNull();
    expect(await repo.effectivePriceCents(engagementId)).toBe(500_000);
    expect((await auditFor(first.id)).some((e) => e.action === 'engagement_milestone.edited')).toBe(
      false
    );
  });

  it('refuses a draft', async () => {
    const { engagementId, userId } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'x',
      newTotalCents: 500_001,
      lines: [],
    });
    await expect(repo.approve({ engagementId, orderId: draft.id, userId })).rejects.toBeInstanceOf(
      InvalidChangeOrderTransitionError
    );
  });
});

describe('engagementChangeOrdersRepository — the delta is derived from newTotalCents under the lock', () => {
  it('measures the delta against an effective price that moved after the caller read it', async () => {
    const { engagementId, orderId, userId } = await seedSentOrder();
    // The caller reads the effective price, then an approval lands before its write locks.
    const staleRead = await repo.effectivePriceCents(engagementId);
    await repo.approve({ engagementId, orderId, userId });
    expect(staleRead).toBe(500_000);

    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'Adds a hand-over session.',
      newTotalCents: 700_000,
      lines: [line({ op: 'add', title: 'Hand-over' })],
    });

    expect(draft.priceDeltaCents).toBe(50_000);
    await repo.send({ engagementId, orderId: draft.id, userId });
    const approved = await repo.approve({ engagementId, orderId: draft.id, userId });
    expect(approved.previousEffectivePriceCents).toBe(650_000);
    expect(approved.effectivePriceCents).toBe(700_000);
  });

  it('replaceLines re-derives the delta under its own lock', async () => {
    const { engagementId, userId } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'v1',
      newTotalCents: 520_000,
      lines: [],
    });
    expect(draft.priceDeltaCents).toBe(20_000);
    await engagementChangeOrderFactory({
      engagementId,
      status: 'approved',
      values: { priceDeltaCents: 10_000 },
    });

    const replaced = await repo.replaceLines({
      engagementId,
      orderId: draft.id,
      userId,
      note: 'v2',
      newTotalCents: 520_000,
      lines: [],
    });

    expect(replaced.priceDeltaCents).toBe(10_000);
  });

  it('stores a new total equal to the effective price as no price change', async () => {
    const { engagementId, userId } = await seedProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: null,
      newTotalCents: 500_000,
      lines: [],
    });
    expect(draft.priceDeltaCents).toBeNull();

    const replaced = await repo.replaceLines({
      engagementId,
      orderId: draft.id,
      userId,
      note: null,
      newTotalCents: 450_000,
      lines: [],
    });
    expect(replaced.priceDeltaCents).toBe(-50_000);
  });
});

describe('engagementChangeOrdersRepository — a T&M order moves the cap', () => {
  async function seedTmProject(): Promise<{
    engagementId: string;
    userId: string;
    first: EngagementMilestone;
  }> {
    const seeded = await seedProject({
      projectValues: {
        pricingMethod: 'tm',
        priceCents: 900_000,
        rateCents: 20_000,
        cadence: 'monthly',
      },
    });
    await db
      .update(engagementMilestones)
      .set({ valueCents: null, estimatedMinutes: 600 })
      .where(eq(engagementMilestones.engagementId, seeded.engagementId));
    return seeded;
  }

  it('applies an approved cap delta to the effective cap and leaves price_cents alone', async () => {
    const { engagementId, userId } = await seedTmProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'Adds a migration and raises the cap to fit it.',
      newTotalCents: 1_200_000,
      lines: [line({ op: 'add', title: 'Data migration', estimatedMinutes: 900 })],
    });
    expect(draft.priceDeltaCents).toBe(300_000);
    await repo.send({ engagementId, orderId: draft.id, userId });

    const result = await repo.approve({ engagementId, orderId: draft.id, userId });

    expect(result.previousEffectivePriceCents).toBe(900_000);
    expect(result.effectivePriceCents).toBe(1_200_000);
    expect(await repo.effectivePriceCents(engagementId)).toBe(1_200_000);
    const [child] = await db
      .select({ priceCents: projectEngagements.priceCents })
      .from(projectEngagements)
      .where(eq(projectEngagements.engagementId, engagementId));
    expect(child?.priceCents).toBe(900_000);
    const terms = await repo.settlementTermsFor(engagementId);
    expect(terms.approvedDeltas.map((d) => d.priceDeltaCents)).toEqual([300_000]);
  });

  it('refuses at send a cap below zero', async () => {
    const { engagementId, userId } = await seedTmProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'Lowers the cap.',
      newTotalCents: -1,
      lines: [],
    });

    await expect(repo.send({ engagementId, orderId: draft.id, userId })).rejects.toMatchObject({
      rule: 'effective_price_negative',
    });
  });

  it('still refuses a value on a T&M line', async () => {
    const { engagementId, userId } = await seedTmProject();
    const draft = await repo.createDraft({
      engagementId,
      userId,
      note: 'Adds a priced milestone.',
      newTotalCents: 1_000_000,
      lines: [line({ op: 'add', estimatedMinutes: 60, valueCents: 10_000 })],
    });

    await expect(repo.send({ engagementId, orderId: draft.id, userId })).rejects.toMatchObject({
      rule: 'tm_line_has_value',
    });
  });
});

describe('engagement_change_orders status ⇔ timestamp CHECKs', () => {
  /** Each probe runs in its own savepoint, so a refused insert leaves the test tx usable. */
  async function probe(
    constraint: string,
    values: Omit<typeof engagementChangeOrders.$inferInsert, 'engagementId'>
  ): Promise<void> {
    const { engagement } = await engagementFactory();
    await expectConstraintViolation(
      '23514',
      (tx) => tx.insert(engagementChangeOrders).values({ engagementId: engagement.id, ...values }),
      constraint
    );
  }

  it('accepts a row in every status when its stamps agree (positive control)', async () => {
    for (const status of [
      'requested',
      'draft',
      'sent',
      'approved',
      'declined',
      'withdrawn',
    ] as const) {
      const { order } = await engagementChangeOrderFactory({ status });
      expect(order.status).toBe(status);
    }
  });

  it('refuses approved / declined without a decision stamp', async () => {
    const { id: u } = await userFactory();
    const at = new Date();
    await probe('engagement_change_order_decided_stamped', {
      status: 'approved',
      sentAt: at,
      sentByUserId: u,
    });
    await probe('engagement_change_order_decided_stamped', { status: 'declined' });
  });

  it('refuses withdrawn without withdrawn_at', async () => {
    await probe('engagement_change_order_withdrawn_stamped', { status: 'withdrawn' });
  });

  it('refuses sent / approved without sent_at', async () => {
    const { id: u } = await userFactory();
    const at = new Date();
    await probe('engagement_change_order_sent_stamped', { status: 'sent' });
    await probe('engagement_change_order_sent_stamped', {
      status: 'approved',
      decidedAt: at,
      decidedByUserId: u,
    });
  });

  it('refuses requested / draft / sent carrying a decision or withdrawal stamp', async () => {
    const { id: u } = await userFactory();
    const at = new Date();
    const requested = { requestedAt: at, requestedByUserId: u };
    const sent = { sentAt: at, sentByUserId: u };
    await probe('engagement_change_order_open_unstamped', {
      status: 'requested',
      ...requested,
      decidedAt: at,
      decidedByUserId: u,
    });
    await probe('engagement_change_order_open_unstamped', {
      status: 'draft',
      withdrawnAt: at,
      withdrawnByUserId: u,
    });
    await probe('engagement_change_order_open_unstamped', {
      status: 'sent',
      ...sent,
      decidedAt: at,
      decidedByUserId: u,
    });
  });

  it('refuses requested without requested_at', async () => {
    await probe('engagement_change_order_requested_stamped', { status: 'requested' });
  });
});

describe('engagementChangeOrdersRepository.effectivePriceCents', () => {
  it('adds only approved, live deltas to price_cents', async () => {
    const { engagementId } = await seedProject();
    await engagementChangeOrderFactory({
      engagementId,
      status: 'approved',
      values: { priceDeltaCents: -100_000 },
    });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'approved',
      values: { priceDeltaCents: 40_000 },
    });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'approved',
      values: { priceDeltaCents: 999_000, deletedAt: new Date() },
    });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'declined',
      values: { priceDeltaCents: 777_000 },
    });

    expect(await repo.effectivePriceCents(engagementId)).toBe(440_000);
  });
});

describe('engagementChangeOrdersRepository.listForEngagement', () => {
  it('returns live orders oldest first with live lines and name-only actors', async () => {
    const { engagementId, first } = await seedProject();
    const actor = await userFactory({ firstName: 'Dana', lastName: 'Lee' });
    const { order: older } = await engagementChangeOrderFactory({
      engagementId,
      actorUserId: actor.id,
      status: 'approved',
      values: { createdAt: new Date('2026-01-01T00:00:00Z') },
      lines: [
        { op: 'edit', engagementMilestoneId: first.id, title: 'B', sortOrder: 1 },
        { op: 'add', title: 'A', sortOrder: 0 },
        { op: 'add', title: 'gone', sortOrder: 2, deletedAt: new Date() },
      ],
    });
    const { order: newer } = await engagementChangeOrderFactory({
      engagementId,
      status: 'requested',
      values: { createdAt: new Date('2026-02-01T00:00:00Z') },
    });
    await engagementChangeOrderFactory({
      engagementId,
      status: 'withdrawn',
      values: { deletedAt: new Date() },
    });

    const orders = await repo.listForEngagement(engagementId);

    expect(orders.map((o) => o.id)).toEqual([older.id, newer.id]);
    expect(orders[0]?.lines.map((l) => l.title)).toEqual(['A', 'B']);
    expect(orders[0]?.sentBy).toEqual({ id: actor.id, firstName: 'Dana', lastName: 'Lee' });
    expect(orders[0]?.withdrawnBy).toBeNull();
  });
});

describe('engagementChangeOrdersRepository.settlementTermsFor', () => {
  it('returns the accepted terms, the source installments and approved deltas by decision', async () => {
    const { engagement, sourceProposal } = await engagementFactory({
      withSourceProposal: true,
      values: { baloFeeBps: 2500 },
      projectValues: { priceCents: 1_250_000, depositCents: null },
    });
    if (sourceProposal === undefined) throw new Error('expected a source proposal');
    await proposalPaymentInstallmentFactory({
      proposal: sourceProposal,
      values: { pct: 40, sortOrder: 0 },
    });
    await proposalPaymentInstallmentFactory({
      proposal: sourceProposal,
      values: { pct: 60, sortOrder: 1, label: 'On delivery' },
    });
    const { order: later } = await engagementChangeOrderFactory({
      engagementId: engagement.id,
      status: 'approved',
      values: { priceDeltaCents: -900_000, decidedAt: new Date('2026-03-02T00:00:00Z') },
    });
    const { order: earlier } = await engagementChangeOrderFactory({
      engagementId: engagement.id,
      status: 'approved',
      values: { priceDeltaCents: null, decidedAt: new Date('2026-03-01T00:00:00Z') },
    });

    const terms = await repo.settlementTermsFor(engagement.id);

    expect(terms).toMatchObject({
      pricingMethod: 'fixed',
      acceptedPriceCents: 1_250_000,
      depositCents: null,
      baloFeeBps: 2500,
      installments: [{ pct: 40 }, { pct: 60 }],
    });
    expect(terms.approvedDeltas.map((d) => [d.orderId, d.priceDeltaCents])).toEqual([
      [earlier.id, 0],
      [later.id, -900_000],
    ]);
  });
});

describe('engagementChangeOrdersRepository.listStaleSentForAlerts', () => {
  it('lists open sent orders at or before the cutoff on active projects only', async () => {
    const cutoff = new Date('2026-05-08T00:00:00Z');
    const old = new Date('2026-05-01T00:00:00Z');
    const stale = await seedProject();
    const { order: staleOrder } = await engagementChangeOrderFactory({
      engagementId: stale.engagementId,
      status: 'sent',
      values: { sentAt: old },
    });
    const fresh = await seedProject();
    await engagementChangeOrderFactory({
      engagementId: fresh.engagementId,
      status: 'sent',
      values: { sentAt: new Date('2026-05-09T00:00:00Z') },
    });
    const decided = await seedProject();
    await engagementChangeOrderFactory({
      engagementId: decided.engagementId,
      status: 'approved',
      values: { sentAt: old },
    });
    const { engagement: cancelled } = await engagementFactory({
      projectValues: { deliveryStatus: 'cancelled' },
    });
    await engagementChangeOrderFactory({
      engagementId: cancelled.id,
      status: 'sent',
      values: { sentAt: old },
    });
    const mine = new Set([
      stale.engagementId,
      fresh.engagementId,
      decided.engagementId,
      cancelled.id,
    ]);

    const rows = (await repo.listStaleSentForAlerts(cutoff, 50)).filter((r) =>
      mine.has(r.engagementId)
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      engagementId: stale.engagementId,
      changeOrderId: staleOrder.id,
      sentAt: old,
      clientCompanyName: 'Acme Co',
      projectTitle: null,
      agencyName: null,
    });
  });
});
