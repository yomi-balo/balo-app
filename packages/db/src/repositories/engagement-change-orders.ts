import { and, asc, eq, isNull, lte, max, sum } from 'drizzle-orm';
import { DEFAULT_BALO_FEE_BPS } from '@balo/shared/pricing';
import { db } from '../client';
import {
  agencies,
  companies,
  engagementChangeOrderLines,
  engagementChangeOrders,
  engagementMilestones,
  engagements,
  expertProfiles,
  projectEngagements,
  projectRequests,
  users,
  type EngagementChangeOrder,
  type EngagementChangeOrderLine,
  type EngagementMilestone,
} from '../schema';
import { recordDeliveryAudit } from './_shared/delivery-audit';
import { lockActiveEngagement, type DbTx } from './_shared/engagement-lock';
import { openChangeOrderPredicate, readProjectTermsTx } from './_shared/change-order-guards';
import type { DbExecutor } from './_shared/db-executor';
import { assertChangeOrderCoherent, ChangeOrderCoherenceError } from './change-order-coherence';
import { isUniqueViolation } from './experts';
import { listByProposalTx as listInstallmentsTx } from './proposal-payment-installments';
import type { PricingMethod } from './proposal-types';

/**
 * The change-order repository (BAL-622): amendments to a live project's delivery plan
 * and price, which apply only when the client approves.
 *
 * LOCK DANCE (fenced by `change-order-writers-take-the-engagement-lock-first.test.ts`):
 * every transaction opens with `lockActiveEngagement` (the engagement-keyed writers) or
 * `lockChangeOrderTx` (the order-keyed ones), so all change-order writes serialise with
 * every other delivery write on the engagement. Lock order: engagement → project child →
 * order → lines / milestones.
 *
 * ACTIVE PROJECTS ONLY. `lockActiveEngagement` refuses unless delivery is `active`, so
 * once a project is marked ready, completed or cancelled no change order moves. An open
 * draft or sent order left on such a project stays inert — nothing cascades it.
 *
 * ROLE-FREE. The repository never decides which side may act; the web layer gates the
 * client acts on membership and the expert acts on the engagement axis.
 *
 * MONEY IS EXPERT-SIDE. `price_delta_cents` and every figure returned here is the
 * expert's; the client figure is derived through `applyBaloFee` by the read layer. The
 * project's `price_cents` (the price on fixed, the cap on T&M) is never rewritten — the
 * effective price is `price_cents` plus the approved deltas
 * ({@link engagementChangeOrdersRepository.effectivePriceCents}).
 *
 * THE DELTA IS DERIVED UNDER THE LOCK. Callers pass the intended new total
 * (`newTotalCents`); `createDraft` / `replaceLines` store `newTotalCents − effective`,
 * with the effective price read after the engagement lock is taken, so an approval that
 * lands between the caller's read and the lock cannot skew it. The stored delta then
 * stays exact through `send` and `approve` without recomputation: the effective price
 * only moves when an order is approved, and the one-open-order index means no other
 * order can be approved while this one is open.
 *
 * NEVER NOTIFIES — the caller publishes after commit (`repositories-never-notify.test.ts`).
 */

export type ChangeOrderStatus = EngagementChangeOrder['status'];
export type ChangeOrderLineOp = EngagementChangeOrderLine['op'];

/** One line as the caller proposes it. `descriptionHtml` is sanitised by the web caller. */
export interface ChangeOrderLineInput {
  op: ChangeOrderLineOp;
  /** The milestone an `edit` / `remove` line targets; `null` for `add`. */
  engagementMilestoneId: string | null;
  title: string;
  descriptionHtml: string | null;
  acceptanceCriteria: string | null;
  valueCents: number | null;
  estimatedMinutes: number | null;
}

/** An order with its live lines in `sort_order` (ties by id). */
export type ChangeOrderRecord = EngagementChangeOrder & { lines: EngagementChangeOrderLine[] };

/** A person named on an order — a name only, never the full user row. */
export interface ChangeOrderActor {
  id: string;
  firstName: string | null;
  lastName: string | null;
}

export type ChangeOrderWithLines = ChangeOrderRecord & {
  requestedBy: ChangeOrderActor | null;
  sentBy: ChangeOrderActor | null;
  decidedBy: ChangeOrderActor | null;
  withdrawnBy: ChangeOrderActor | null;
};

export interface ChangeOrderApproval {
  order: ChangeOrderRecord;
  /** Every milestone the approval added, edited or removed, in line order. */
  appliedMilestoneIds: string[];
  previousEffectivePriceCents: number;
  effectivePriceCents: number;
}

export interface ChangeOrderSettlementTerms {
  pricingMethod: PricingMethod;
  /** The expert-side `price_cents` the project was accepted at. */
  acceptedPriceCents: number;
  depositCents: number | null;
  baloFeeBps: number;
  currency: string;
  /** The source proposal's live installments, fixed price only (empty otherwise). */
  installments: { pct: number }[];
  /** Approved orders oldest decision first; a scope-only or T&M order carries 0. */
  approvedDeltas: { orderId: string; decidedAt: Date; priceDeltaCents: number }[];
}

/** One sent, undecided order on an active project, for the stale-order admin alert. */
export interface StaleChangeOrderAlertRow {
  engagementId: string;
  changeOrderId: string;
  sentAt: Date;
  projectTitle: string | null;
  clientCompanyName: string;
  expertFirstName: string | null;
  expertLastName: string | null;
  agencyName: string | null;
}

/**
 * Allowed change-order moves. `requested → declined` is the expert answering without a
 * change order; `draft → requested` discards a draft made from a client request.
 */
export const CHANGE_ORDER_TRANSITIONS: Record<ChangeOrderStatus, readonly ChangeOrderStatus[]> = {
  requested: ['draft', 'declined'],
  draft: ['sent', 'withdrawn', 'requested'],
  sent: ['approved', 'declined', 'withdrawn'],
  approved: [],
  declined: [],
  withdrawn: [],
};

export function isAllowedChangeOrderTransition(
  from: ChangeOrderStatus,
  to: ChangeOrderStatus
): boolean {
  return CHANGE_ORDER_TRANSITIONS[from].includes(to);
}

export class InvalidChangeOrderTransitionError extends Error {
  constructor(
    public readonly from: ChangeOrderStatus,
    public readonly to: ChangeOrderStatus
  ) {
    super(`Invalid change order transition: ${from} → ${to}`);
    this.name = 'InvalidChangeOrderTransitionError';
  }
}

/** The engagement already has an open order (decision pending, not withdrawn). */
export class ChangeOrderAlreadyOpenError extends Error {
  constructor(public readonly engagementId: string) {
    super(`Engagement ${engagementId} already has an open change order`);
    this.name = 'ChangeOrderAlreadyOpenError';
  }
}

/** No live order with this id on this engagement (also the cross-engagement guard). */
export class ChangeOrderNotFoundError extends Error {
  constructor(public readonly changeOrderId: string) {
    super(`Change order not found: ${changeOrderId}`);
    this.name = 'ChangeOrderNotFoundError';
  }
}

const ONE_OPEN_INDEX = 'engagement_change_order_one_open_idx';

/**
 * Lock dance for an order-keyed write: an unlocked read finds the order, the engagement
 * is locked and asserted active, then the order is re-read FOR UPDATE under that lock. An
 * order that is missing, soft-deleted or belongs to another engagement is
 * {@link ChangeOrderNotFoundError} — checked before the lock, so a foreign engagement is
 * never locked on a caller's behalf.
 */
async function lockChangeOrderTx(
  tx: DbTx,
  engagementId: string,
  orderId: string
): Promise<EngagementChangeOrder> {
  const [discovered] = await tx
    .select({ engagementId: engagementChangeOrders.engagementId })
    .from(engagementChangeOrders)
    .where(and(eq(engagementChangeOrders.id, orderId), isNull(engagementChangeOrders.deletedAt)));
  if (discovered === undefined || discovered.engagementId !== engagementId) {
    throw new ChangeOrderNotFoundError(orderId);
  }

  await lockActiveEngagement(tx, engagementId, { requireType: 'project' });

  const [order] = await tx
    .select()
    .from(engagementChangeOrders)
    .where(
      and(
        eq(engagementChangeOrders.id, orderId),
        eq(engagementChangeOrders.engagementId, engagementId),
        isNull(engagementChangeOrders.deletedAt)
      )
    )
    .for('update');
  if (order === undefined) {
    throw new ChangeOrderNotFoundError(orderId);
  }
  return order;
}

function assertTransition(order: EngagementChangeOrder, to: ChangeOrderStatus): void {
  if (!isAllowedChangeOrderTransition(order.status, to)) {
    throw new InvalidChangeOrderTransitionError(order.status, to);
  }
}

function assertFrom(
  order: EngagementChangeOrder,
  expectedFrom: ChangeOrderStatus,
  to: ChangeOrderStatus
): void {
  if (order.status !== expectedFrom) {
    throw new InvalidChangeOrderTransitionError(order.status, to);
  }
  assertTransition(order, to);
}

async function assertNoOpenOrderTx(tx: DbTx, engagementId: string): Promise<void> {
  const [open] = await tx
    .select({ id: engagementChangeOrders.id })
    .from(engagementChangeOrders)
    .where(and(eq(engagementChangeOrders.engagementId, engagementId), openChangeOrderPredicate()))
    .limit(1);
  if (open !== undefined) {
    throw new ChangeOrderAlreadyOpenError(engagementId);
  }
}

/** Insert a new open order. The partial unique index backs the pre-check. */
async function insertOpenOrderTx(
  tx: DbTx,
  values: typeof engagementChangeOrders.$inferInsert
): Promise<EngagementChangeOrder> {
  let inserted: EngagementChangeOrder | undefined;
  try {
    [inserted] = await tx.insert(engagementChangeOrders).values(values).returning();
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_INDEX)) {
      throw new ChangeOrderAlreadyOpenError(values.engagementId);
    }
    throw error;
  }
  if (inserted === undefined) {
    throw new Error(`Failed to insert change order on engagement: ${values.engagementId}`);
  }
  return inserted;
}

async function updateOrderTx(
  tx: DbTx,
  orderId: string,
  set: Partial<typeof engagementChangeOrders.$inferInsert>
): Promise<EngagementChangeOrder> {
  const [updated] = await tx
    .update(engagementChangeOrders)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(engagementChangeOrders.id, orderId))
    .returning();
  if (updated === undefined) {
    throw new Error(`Failed to update change order: ${orderId}`);
  }
  return updated;
}

async function liveLinesTx(
  exec: DbExecutor,
  orderId: string
): Promise<EngagementChangeOrderLine[]> {
  return exec
    .select()
    .from(engagementChangeOrderLines)
    .where(
      and(
        eq(engagementChangeOrderLines.changeOrderId, orderId),
        isNull(engagementChangeOrderLines.deletedAt)
      )
    )
    .orderBy(asc(engagementChangeOrderLines.sortOrder), asc(engagementChangeOrderLines.id));
}

async function insertLinesTx(
  tx: DbTx,
  orderId: string,
  lines: readonly ChangeOrderLineInput[]
): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(engagementChangeOrderLines).values(
    lines.map((line, index) => ({
      changeOrderId: orderId,
      op: line.op,
      engagementMilestoneId: line.engagementMilestoneId,
      title: line.title,
      descriptionHtml: line.descriptionHtml,
      acceptanceCriteria: line.acceptanceCriteria,
      valueCents: line.valueCents,
      estimatedMinutes: line.estimatedMinutes,
      sortOrder: index,
    }))
  );
}

async function softDeleteLinesTx(tx: DbTx, orderId: string): Promise<void> {
  const now = new Date();
  await tx
    .update(engagementChangeOrderLines)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(engagementChangeOrderLines.changeOrderId, orderId),
        isNull(engagementChangeOrderLines.deletedAt)
      )
    );
}

async function withLinesTx(tx: DbTx, order: EngagementChangeOrder): Promise<ChangeOrderRecord> {
  return { ...order, lines: await liveLinesTx(tx, order.id) };
}

async function effectivePriceCentsTx(exec: DbExecutor, engagementId: string): Promise<number> {
  const { priceCents } = await readProjectTermsTx(exec, engagementId);
  const [approved] = await exec
    .select({ total: sum(engagementChangeOrders.priceDeltaCents) })
    .from(engagementChangeOrders)
    .where(
      and(
        eq(engagementChangeOrders.engagementId, engagementId),
        eq(engagementChangeOrders.status, 'approved'),
        isNull(engagementChangeOrders.deletedAt)
      )
    );
  return priceCents + Number(approved?.total ?? 0);
}

/**
 * The delta that takes the current effective price to `newTotalCents`, read inside the
 * caller's locked transaction. `null` in, or a zero delta, stores `null` (no price change).
 */
async function priceDeltaForNewTotalTx(
  tx: DbTx,
  engagementId: string,
  newTotalCents: number | null
): Promise<number | null> {
  if (newTotalCents === null) return null;
  const delta = newTotalCents - (await effectivePriceCentsTx(tx, engagementId));
  return delta === 0 ? null : delta;
}

async function liveMilestonesTx(tx: DbTx, engagementId: string): Promise<EngagementMilestone[]> {
  return tx
    .select()
    .from(engagementMilestones)
    .where(
      and(
        eq(engagementMilestones.engagementId, engagementId),
        isNull(engagementMilestones.deletedAt)
      )
    )
    .orderBy(asc(engagementMilestones.sortOrder), asc(engagementMilestones.id))
    .for('update');
}

/** Assemble the coherence snapshot under the engagement lock and assert it. */
async function assertCoherentTx(
  tx: DbTx,
  order: EngagementChangeOrder,
  lines: readonly EngagementChangeOrderLine[],
  live: readonly EngagementMilestone[]
): Promise<{ pricingMethod: PricingMethod; currentEffectivePriceCents: number }> {
  const { pricingMethod } = await readProjectTermsTx(tx, order.engagementId);
  const currentEffectivePriceCents = await effectivePriceCentsTx(tx, order.engagementId);
  assertChangeOrderCoherent({
    pricingMethod,
    currentEffectivePriceCents,
    priceDeltaCents: order.priceDeltaCents,
    note: order.note,
    lines,
    liveMilestoneIds: new Set(live.map((m) => m.id)),
  });
  return { pricingMethod, currentEffectivePriceCents };
}

function lineCounts(
  lines: readonly { op: ChangeOrderLineOp }[]
): Record<ChangeOrderLineOp, number> {
  return {
    add: lines.filter((l) => l.op === 'add').length,
    edit: lines.filter((l) => l.op === 'edit').length,
    remove: lines.filter((l) => l.op === 'remove').length,
  };
}

async function auditOrderTx(
  tx: DbTx,
  input: {
    order: EngagementChangeOrder;
    userId: string;
    action:
      | 'engagement.change_order_requested'
      | 'engagement.change_order_drafted'
      | 'engagement.change_order_lines_replaced'
      | 'engagement.change_order_sent'
      | 'engagement.change_order_withdrawn'
      | 'engagement.change_order_draft_discarded'
      | 'engagement.change_order_approved'
      | 'engagement.change_order_declined';
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await recordDeliveryAudit(tx, {
    actorUserId: input.userId,
    action: input.action,
    entityType: 'engagement_change_order',
    entityId: input.order.id,
    engagementId: input.order.engagementId,
    metadata: input.metadata,
  });
}

/** The columns an edit line writes: title + description always, the rest only when carried. */
function editedColumns(
  line: EngagementChangeOrderLine,
  pricingMethod: PricingMethod,
  now: Date
): Partial<typeof engagementMilestones.$inferInsert> {
  return {
    title: line.title,
    descriptionHtml: line.descriptionHtml,
    ...(pricingMethod === 'tm' ? { estimatedMinutes: line.estimatedMinutes } : {}),
    ...(line.acceptanceCriteria === null ? {} : { acceptanceCriteria: line.acceptanceCriteria }),
    ...(line.valueCents === null ? {} : { valueCents: line.valueCents }),
    updatedAt: now,
  };
}

/**
 * Apply an approved order's lines to `engagement_milestones`, in `sort_order`. The ONLY
 * post-snapshot writer of `engagement_milestones.value_cents`
 * (`milestone-value-cents-has-one-post-snapshot-writer.test.ts`):
 *
 *   add    — inserts a `pending` milestone after the last live one, authored by the
 *            order's sender, then backfills the line's `engagement_milestone_id`.
 *   edit   — writes title + description, the estimate on T&M, and acceptance criteria /
 *            value only when the line carries them.
 *   remove — soft-deletes the milestone (a completed one included).
 *
 * A target that is no longer live throws `ChangeOrderCoherenceError('line_target_not_live')`
 * and the caller's transaction rolls every line back. Each line audits its milestone
 * action with the order id.
 */
async function applyChangeOrderLinesTx(
  tx: DbTx,
  input: {
    order: EngagementChangeOrder;
    lines: readonly EngagementChangeOrderLine[];
    pricingMethod: PricingMethod;
    userId: string;
  }
): Promise<string[]> {
  const { order, pricingMethod, userId } = input;
  const engagementId = order.engagementId;
  const [maxRow] = await tx
    .select({ maxSort: max(engagementMilestones.sortOrder) })
    .from(engagementMilestones)
    .where(
      and(
        eq(engagementMilestones.engagementId, engagementId),
        isNull(engagementMilestones.deletedAt)
      )
    );
  let nextSort = (maxRow?.maxSort ?? -1) + 1;
  const ctx: ApplyContext = { order, userId, engagementId, now: new Date() };
  const applied: string[] = [];

  for (const line of input.lines) {
    if (line.op === 'add') {
      const [inserted] = await tx
        .insert(engagementMilestones)
        .values({
          engagementId,
          sourceProposalMilestoneId: null,
          sortOrder: nextSort,
          title: line.title,
          descriptionHtml: line.descriptionHtml,
          acceptanceCriteria: line.acceptanceCriteria,
          valueCents: line.valueCents,
          estimatedMinutes: line.estimatedMinutes,
          status: 'pending',
          createdByUserId: order.sentByUserId,
        })
        .returning({ id: engagementMilestones.id });
      applied.push(await recordAddedMilestone(tx, ctx, line, inserted, nextSort));
      nextSort += 1;
      continue;
    }

    const target = line.engagementMilestoneId;
    if (target === null) {
      throw new ChangeOrderCoherenceError('line_target_not_live');
    }
    const liveTarget = and(
      eq(engagementMilestones.id, target),
      eq(engagementMilestones.engagementId, engagementId),
      isNull(engagementMilestones.deletedAt)
    );

    if (line.op === 'edit') {
      const [edited] = await tx
        .update(engagementMilestones)
        .set(editedColumns(line, pricingMethod, ctx.now))
        .where(liveTarget)
        .returning({ id: engagementMilestones.id });
      applied.push(await recordLiveMilestoneUpdate(tx, ctx, edited, 'engagement_milestone.edited'));
      continue;
    }

    const [removed] = await tx
      .update(engagementMilestones)
      .set({ deletedAt: ctx.now, updatedAt: ctx.now })
      .where(liveTarget)
      .returning({ id: engagementMilestones.id });
    applied.push(await recordLiveMilestoneUpdate(tx, ctx, removed, 'engagement_milestone.removed'));
  }

  return applied;
}

interface ApplyContext {
  order: EngagementChangeOrder;
  userId: string;
  engagementId: string;
  now: Date;
}

/** After an added line's milestone insert: backfill the line's milestone id and audit the add. */
async function recordAddedMilestone(
  tx: DbTx,
  ctx: ApplyContext,
  line: EngagementChangeOrderLine,
  inserted: { id: string } | undefined,
  sortOrder: number
): Promise<string> {
  if (inserted === undefined) {
    throw new Error(`Failed to add milestone for change order: ${ctx.order.id}`);
  }
  await tx
    .update(engagementChangeOrderLines)
    .set({ engagementMilestoneId: inserted.id, updatedAt: ctx.now })
    .where(eq(engagementChangeOrderLines.id, line.id));
  await recordDeliveryAudit(tx, {
    actorUserId: ctx.userId,
    action: 'engagement_milestone.added',
    entityType: 'engagement_milestone',
    entityId: inserted.id,
    engagementId: ctx.engagementId,
    metadata: { sort_order: sortOrder, changeOrderId: ctx.order.id },
  });
  return inserted.id;
}

/**
 * After an edit or remove of a milestone that must still be live: audit the action. A missing
 * row means the target is gone and throws `ChangeOrderCoherenceError('line_target_not_live')`.
 */
async function recordLiveMilestoneUpdate(
  tx: DbTx,
  ctx: ApplyContext,
  updated: { id: string } | undefined,
  action: 'engagement_milestone.edited' | 'engagement_milestone.removed'
): Promise<string> {
  if (updated === undefined) {
    throw new ChangeOrderCoherenceError('line_target_not_live');
  }
  await recordDeliveryAudit(tx, {
    actorUserId: ctx.userId,
    action,
    entityType: 'engagement_milestone',
    entityId: updated.id,
    engagementId: ctx.engagementId,
    metadata: { changeOrderId: ctx.order.id },
  });
  return updated.id;
}

export const engagementChangeOrdersRepository = {
  /**
   * The client asks for a change (→ `requested`). Refuses a second open order
   * ({@link ChangeOrderAlreadyOpenError}). Audits `engagement.change_order_requested`.
   */
  async requestByClient(input: {
    engagementId: string;
    userId: string;
    note: string;
  }): Promise<ChangeOrderRecord> {
    return db.transaction(async (tx) => {
      await lockActiveEngagement(tx, input.engagementId, { requireType: 'project' });
      await assertNoOpenOrderTx(tx, input.engagementId);

      const order = await insertOpenOrderTx(tx, {
        engagementId: input.engagementId,
        status: 'requested',
        requestNote: input.note,
        requestedByUserId: input.userId,
        requestedAt: new Date(),
        createdByUserId: input.userId,
      });
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_requested',
        metadata: { to: 'requested' },
      });
      return { ...order, lines: [] };
    });
  },

  /**
   * The expert drafts a change. With `fromOrderId`, the open `requested` order becomes
   * the draft (`requested → draft`); without, a fresh draft is opened (refused while
   * another order is open). Drafts are NOT coherence-checked — they may be incomplete.
   * `newTotalCents` is the intended expert-side price (fixed) or cap (T&M) after the
   * change, `null` for no price change; the stored delta is derived from it under the
   * lock. Audits `engagement.change_order_drafted`.
   */
  async createDraft(input: {
    engagementId: string;
    userId: string;
    fromOrderId?: string;
    note: string | null;
    newTotalCents: number | null;
    lines: readonly ChangeOrderLineInput[];
  }): Promise<ChangeOrderRecord> {
    const fromOrderId = input.fromOrderId;
    if (fromOrderId !== undefined) {
      return db.transaction(async (tx) => {
        const current = await lockChangeOrderTx(tx, input.engagementId, fromOrderId);
        assertFrom(current, 'requested', 'draft');

        const order = await updateOrderTx(tx, current.id, {
          status: 'draft',
          note: input.note,
          priceDeltaCents: await priceDeltaForNewTotalTx(
            tx,
            input.engagementId,
            input.newTotalCents
          ),
        });
        await softDeleteLinesTx(tx, order.id);
        await insertLinesTx(tx, order.id, input.lines);
        await auditOrderTx(tx, {
          order,
          userId: input.userId,
          action: 'engagement.change_order_drafted',
          metadata: { from: 'requested', to: 'draft', line_count: input.lines.length },
        });
        return withLinesTx(tx, order);
      });
    }

    return db.transaction(async (tx) => {
      await lockActiveEngagement(tx, input.engagementId, { requireType: 'project' });
      await assertNoOpenOrderTx(tx, input.engagementId);

      const order = await insertOpenOrderTx(tx, {
        engagementId: input.engagementId,
        status: 'draft',
        note: input.note,
        priceDeltaCents: await priceDeltaForNewTotalTx(tx, input.engagementId, input.newTotalCents),
        createdByUserId: input.userId,
      });
      await insertLinesTx(tx, order.id, input.lines);
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_drafted',
        metadata: { to: 'draft', line_count: input.lines.length },
      });
      return withLinesTx(tx, order);
    });
  },

  /**
   * Replace a draft's note, price change and lines (the old lines are soft-deleted).
   * `newTotalCents` follows {@link createDraft}. Draft only — anything else is
   * {@link InvalidChangeOrderTransitionError}. Audits `engagement.change_order_lines_replaced`.
   */
  async replaceLines(input: {
    engagementId: string;
    orderId: string;
    userId: string;
    note: string | null;
    newTotalCents: number | null;
    lines: readonly ChangeOrderLineInput[];
  }): Promise<ChangeOrderRecord> {
    return db.transaction(async (tx) => {
      const current = await lockChangeOrderTx(tx, input.engagementId, input.orderId);
      if (current.status !== 'draft') {
        throw new InvalidChangeOrderTransitionError(current.status, 'draft');
      }

      const order = await updateOrderTx(tx, current.id, {
        note: input.note,
        priceDeltaCents: await priceDeltaForNewTotalTx(tx, input.engagementId, input.newTotalCents),
      });
      await softDeleteLinesTx(tx, order.id);
      await insertLinesTx(tx, order.id, input.lines);
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_lines_replaced',
        metadata: { line_count: input.lines.length },
      });
      return withLinesTx(tx, order);
    });
  },

  /**
   * Send a draft to the client (`draft → sent`). Stamps each edit/remove line's
   * `before_*` from its live milestone, then asserts coherence
   * ({@link ChangeOrderCoherenceError} rolls the stamps back). From here the targeted
   * milestones are locked against plain edits. Audits `engagement.change_order_sent`.
   */
  async send(input: {
    engagementId: string;
    orderId: string;
    userId: string;
  }): Promise<ChangeOrderRecord> {
    return db.transaction(async (tx) => {
      const current = await lockChangeOrderTx(tx, input.engagementId, input.orderId);
      assertTransition(current, 'sent');

      const live = await liveMilestonesTx(tx, input.engagementId);
      const liveById = new Map(live.map((m) => [m.id, m]));
      const lines = await liveLinesTx(tx, current.id);
      for (const line of lines) {
        const milestone =
          line.engagementMilestoneId === null
            ? undefined
            : liveById.get(line.engagementMilestoneId);
        if (line.op === 'add' || milestone === undefined) continue;
        await tx
          .update(engagementChangeOrderLines)
          .set({
            beforeTitle: milestone.title,
            beforeDescriptionHtml: milestone.descriptionHtml,
            beforeEstimatedMinutes: milestone.estimatedMinutes,
            updatedAt: new Date(),
          })
          .where(eq(engagementChangeOrderLines.id, line.id));
      }
      await assertCoherentTx(tx, current, lines, live);

      const order = await updateOrderTx(tx, current.id, {
        status: 'sent',
        sentByUserId: input.userId,
        sentAt: new Date(),
      });
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_sent',
        metadata: {
          from: 'draft',
          to: 'sent',
          lines: lineCounts(lines),
          price_delta_cents: order.priceDeltaCents,
        },
      });
      return withLinesTx(tx, order);
    });
  },

  /**
   * Withdraw a draft or a sent order (→ `withdrawn`). `expectedFrom` must equal the
   * current status, so a stale tab cannot withdraw the wrong state. Nothing else moves.
   * Audits `engagement.change_order_withdrawn`.
   */
  async withdraw(input: {
    engagementId: string;
    orderId: string;
    userId: string;
    expectedFrom: 'draft' | 'sent';
  }): Promise<ChangeOrderRecord> {
    return db.transaction(async (tx) => {
      const current = await lockChangeOrderTx(tx, input.engagementId, input.orderId);
      assertFrom(current, input.expectedFrom, 'withdrawn');

      const order = await updateOrderTx(tx, current.id, {
        status: 'withdrawn',
        withdrawnByUserId: input.userId,
        withdrawnAt: new Date(),
      });
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_withdrawn',
        metadata: { from: input.expectedFrom, to: 'withdrawn' },
      });
      return withLinesTx(tx, order);
    });
  },

  /**
   * Discard a draft made from a client request: back to `requested`, with the expert's
   * note, delta and lines cleared (lines soft-deleted). A fresh draft has no request to
   * return to — {@link InvalidChangeOrderTransitionError}; withdraw it instead. Audits
   * `engagement.change_order_draft_discarded`.
   */
  async returnDraftToRequest(input: {
    engagementId: string;
    orderId: string;
    userId: string;
  }): Promise<ChangeOrderRecord> {
    return db.transaction(async (tx) => {
      const current = await lockChangeOrderTx(tx, input.engagementId, input.orderId);
      assertFrom(current, 'draft', 'requested');
      if (current.requestedAt === null) {
        throw new InvalidChangeOrderTransitionError(current.status, 'requested');
      }

      const order = await updateOrderTx(tx, current.id, {
        status: 'requested',
        note: null,
        priceDeltaCents: null,
      });
      await softDeleteLinesTx(tx, order.id);
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_draft_discarded',
        metadata: { from: 'draft', to: 'requested' },
      });
      return { ...order, lines: [] };
    });
  },

  /**
   * Decline (→ `declined`): the client declining a sent order, or the expert answering a
   * request without a change order (`expectedFrom: 'requested'`). `reason` holds the
   * client's reason or the expert's answer. Nothing else moves. Audits
   * `engagement.change_order_declined` with `{ from }`.
   */
  async decline(input: {
    engagementId: string;
    orderId: string;
    userId: string;
    reason: string;
    expectedFrom: 'requested' | 'sent';
  }): Promise<ChangeOrderRecord> {
    return db.transaction(async (tx) => {
      const current = await lockChangeOrderTx(tx, input.engagementId, input.orderId);
      assertFrom(current, input.expectedFrom, 'declined');

      const order = await updateOrderTx(tx, current.id, {
        status: 'declined',
        decidedByUserId: input.userId,
        decidedAt: new Date(),
        declineReason: input.reason,
      });
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_declined',
        metadata: { from: input.expectedFrom, to: 'declined' },
      });
      return withLinesTx(tx, order);
    });
  },

  /**
   * Approve a sent order (`sent → approved`) and apply it, in one transaction: coherence
   * is re-asserted against the live milestones and current effective price, the lines are
   * applied (`applyChangeOrderLinesTx`), and the delta joins the effective price.
   * `price_cents` is never rewritten. Any failure rolls back every line and leaves the
   * order `sent`. Audits `engagement.change_order_approved` with the expert-side delta.
   */
  async approve(input: {
    engagementId: string;
    orderId: string;
    userId: string;
  }): Promise<ChangeOrderApproval> {
    return db.transaction(async (tx) => {
      const current = await lockChangeOrderTx(tx, input.engagementId, input.orderId);
      assertTransition(current, 'approved');

      const live = await liveMilestonesTx(tx, input.engagementId);
      const lines = await liveLinesTx(tx, current.id);
      const { pricingMethod, currentEffectivePriceCents } = await assertCoherentTx(
        tx,
        current,
        lines,
        live
      );

      const appliedMilestoneIds = await applyChangeOrderLinesTx(tx, {
        order: current,
        lines,
        pricingMethod,
        userId: input.userId,
      });

      const order = await updateOrderTx(tx, current.id, {
        status: 'approved',
        decidedByUserId: input.userId,
        decidedAt: new Date(),
      });
      await auditOrderTx(tx, {
        order,
        userId: input.userId,
        action: 'engagement.change_order_approved',
        metadata: {
          from: 'sent',
          to: 'approved',
          lines: lineCounts(lines),
          price_delta_cents: order.priceDeltaCents,
        },
      });

      return {
        order: await withLinesTx(tx, order),
        appliedMilestoneIds,
        previousEffectivePriceCents: currentEffectivePriceCents,
        effectivePriceCents: await effectivePriceCentsTx(tx, input.engagementId),
      };
    });
  },

  /** The expert-side effective price: `price_cents` + Σ approved live deltas. */
  async effectivePriceCents(engagementId: string): Promise<number> {
    return effectivePriceCentsTx(db, engagementId);
  },

  /** {@link effectivePriceCents} inside the caller's transaction. */
  async effectivePriceCentsTx(exec: DbExecutor, engagementId: string): Promise<number> {
    return effectivePriceCentsTx(exec, engagementId);
  },

  /**
   * Every live order on the engagement, oldest first (ties by id), with live lines in
   * `sort_order` and the actors projected to a name only.
   */
  async listForEngagement(engagementId: string): Promise<ChangeOrderWithLines[]> {
    const actor = { columns: { id: true, firstName: true, lastName: true } } as const;
    return db.query.engagementChangeOrders.findMany({
      where: (o, { and: whereAnd, eq: whereEq, isNull: whereIsNull }) =>
        whereAnd(whereEq(o.engagementId, engagementId), whereIsNull(o.deletedAt)),
      orderBy: (o, { asc: orderAsc }) => [orderAsc(o.createdAt), orderAsc(o.id)],
      with: {
        lines: {
          where: (l, { isNull: lineIsNull }) => lineIsNull(l.deletedAt),
          orderBy: (l, { asc: lineAsc }) => [lineAsc(l.sortOrder), lineAsc(l.id)],
        },
        requestedBy: actor,
        sentBy: actor,
        decidedBy: actor,
        withdrawnBy: actor,
      },
    });
  },

  /**
   * The expert-side terms the settlement view derives from: accepted price, deposit, fee,
   * the source proposal's installments (fixed price only), and the approved deltas in
   * decision order. A null fee resolves to `DEFAULT_BALO_FEE_BPS`.
   */
  async settlementTermsFor(engagementId: string): Promise<ChangeOrderSettlementTerms> {
    return db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ currency: engagements.currency, baloFeeBps: engagements.baloFeeBps })
        .from(engagements)
        .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)));
      if (parent === undefined) {
        throw new Error(`Engagement not found: ${engagementId}`);
      }
      const terms = await readProjectTermsTx(tx, engagementId);
      const installments =
        terms.pricingMethod === 'fixed' && terms.sourceProposalId !== null
          ? (await listInstallmentsTx(tx, terms.sourceProposalId)).map((i) => ({ pct: i.pct }))
          : [];
      const approved = await tx
        .select({
          orderId: engagementChangeOrders.id,
          decidedAt: engagementChangeOrders.decidedAt,
          priceDeltaCents: engagementChangeOrders.priceDeltaCents,
        })
        .from(engagementChangeOrders)
        .where(
          and(
            eq(engagementChangeOrders.engagementId, engagementId),
            eq(engagementChangeOrders.status, 'approved'),
            isNull(engagementChangeOrders.deletedAt)
          )
        )
        .orderBy(asc(engagementChangeOrders.decidedAt), asc(engagementChangeOrders.id));

      return {
        pricingMethod: terms.pricingMethod,
        acceptedPriceCents: terms.priceCents,
        depositCents: terms.depositCents,
        baloFeeBps: parent.baloFeeBps ?? DEFAULT_BALO_FEE_BPS,
        currency: parent.currency,
        installments,
        approvedDeltas: approved.flatMap((row) =>
          row.decidedAt === null
            ? []
            : [
                {
                  orderId: row.orderId,
                  decidedAt: row.decidedAt,
                  priceDeltaCents: row.priceDeltaCents ?? 0,
                },
              ]
        ),
      };
    });
  },

  /**
   * Sent, undecided orders whose `sent_at` is at or before `cutoff`, on live projects whose
   * delivery is `active` — the stale-order admin alert's input. Oldest send first, capped
   * at `limit`. A soft-deleted expert user keeps the row with null names.
   */
  async listStaleSentForAlerts(cutoff: Date, limit: number): Promise<StaleChangeOrderAlertRow[]> {
    const rows = await db
      .select({
        engagementId: engagementChangeOrders.engagementId,
        changeOrderId: engagementChangeOrders.id,
        sentAt: engagementChangeOrders.sentAt,
        projectTitle: projectRequests.title,
        clientCompanyName: companies.name,
        expertFirstName: users.firstName,
        expertLastName: users.lastName,
        agencyName: agencies.name,
      })
      .from(engagementChangeOrders)
      .innerJoin(
        engagements,
        and(eq(engagements.id, engagementChangeOrders.engagementId), isNull(engagements.deletedAt))
      )
      .innerJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          eq(projectEngagements.deliveryStatus, 'active'),
          isNull(projectEngagements.deletedAt)
        )
      )
      .innerJoin(companies, eq(companies.id, engagements.companyId))
      .leftJoin(expertProfiles, eq(expertProfiles.id, engagements.expertProfileId))
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .leftJoin(
        projectRequests,
        and(
          eq(projectRequests.id, projectEngagements.projectRequestId),
          isNull(projectRequests.deletedAt)
        )
      )
      .where(
        and(
          eq(engagementChangeOrders.status, 'sent'),
          openChangeOrderPredicate(),
          lte(engagementChangeOrders.sentAt, cutoff)
        )
      )
      .orderBy(asc(engagementChangeOrders.sentAt), asc(engagementChangeOrders.id))
      .limit(limit);

    return rows.flatMap((row) => (row.sentAt === null ? [] : [{ ...row, sentAt: row.sentAt }]));
  },
};
