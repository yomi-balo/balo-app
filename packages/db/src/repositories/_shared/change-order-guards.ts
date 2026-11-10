import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import type { ScopeChangeRedirectReason } from '@balo/shared/engagements';
import {
  engagementChangeOrderLines,
  engagementChangeOrders,
  projectEngagements,
} from '../../schema';
import type { EngagementChangeOrder } from '../../schema';
import type { PricingMethod } from '../proposal-types';
import type { DbExecutor } from './db-executor';
import type { DbTx } from './engagement-supertype';

/**
 * Change-order and scope guards consumed by OTHER delivery repositories
 * (`engagement-milestones.ts`, `project-engagements.ts`) as well as by
 * `engagement-change-orders.ts`. They live in `_shared/` so neither of the first two imports
 * `engagement-change-orders.ts`, which itself imports `engagement-milestones.ts`.
 *
 * Two kinds of guard: the change-order guards (an open or sent order blocks a write) and the
 * scope guards (a plain milestone write that would move money must go through a change order
 * instead, {@link ScopeChangeRequiresChangeOrderError}).
 *
 * Every `…Tx` helper here takes no lock: call it under the engagement lock the caller
 * already holds, so the rows it reads cannot change before the caller's write.
 */

/**
 * A milestone's wording columns: the fields "changed since the proposal" tracks. A direct edit
 * to one on a proposal-origin milestone stamps `content_edited_at`; an approved change order
 * that writes one resets that field's baseline.
 */
export const MILESTONE_CONTENT_FIELDS = ['title', 'descriptionHtml', 'acceptanceCriteria'] as const;

export type MilestoneContentField = (typeof MILESTONE_CONTENT_FIELDS)[number];

/** The SQL predicate for an OPEN change order: undecided, unwithdrawn, live. Timestamps only. */
export function openChangeOrderPredicate(): SQL {
  const predicate = and(
    isNull(engagementChangeOrders.decidedAt),
    isNull(engagementChangeOrders.withdrawnAt),
    isNull(engagementChangeOrders.deletedAt)
  );
  if (predicate === undefined) {
    throw new Error('open change-order predicate is empty');
  }
  return predicate;
}

/**
 * Whether an OPEN change order stops the expert marking the project ready: it has been
 * sent, or it came from a client request (a `requested` order, or a draft made from one).
 * A fresh expert draft does not block. Call only with an open order.
 */
export function blocksMarkReady(order: {
  status: EngagementChangeOrder['status'];
  requestedAt: Date | null;
}): boolean {
  return order.status === 'sent' || order.requestedAt !== null;
}

/**
 * Thrown by `projectEngagementsRepository.requestCompletion` when an open change order
 * blocks marking the project ready ({@link blocksMarkReady}). Nothing is written.
 */
export class ChangeOrderPendingError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly status: EngagementChangeOrder['status']
  ) {
    super(`Engagement ${engagementId} has a change order waiting (status: ${status})`);
    this.name = 'ChangeOrderPendingError';
  }
}

/**
 * Thrown by `engagementMilestonesRepository.editDescriptive` / `softDelete` when the
 * milestone is the target of an edit or remove line on a SENT change order: the client is
 * deciding on that milestone's next state, so it is locked until they do. Starting,
 * completing and reverting stay allowed — delivery continues.
 */
export class MilestoneChangePendingError extends Error {
  constructor(
    public readonly milestoneId: string,
    public readonly changeOrderId: string
  ) {
    super(`Milestone ${milestoneId} has a change waiting on change order ${changeOrderId}`);
    this.name = 'MilestoneChangePendingError';
  }
}

/**
 * Thrown by `engagementMilestonesRepository.editDescriptive` / `add` / `softDelete` when the
 * write would change what the client agreed to pay for, so it needs the client's approval
 * through a change order: an estimate change or an add on time and materials
 * (`estimate_change`, `add_on_tm`), or removing contracted scope on a fixed price
 * (`remove_contracted`). Nothing is written. `milestoneId` is null for a refused add.
 */
export class ScopeChangeRequiresChangeOrderError extends Error {
  constructor(
    public readonly reason: ScopeChangeRedirectReason,
    public readonly pricingMethod: PricingMethod,
    public readonly engagementId: string,
    public readonly milestoneId: string | null
  ) {
    super(
      `Engagement ${engagementId} needs a change order for this milestone change (${reason}, ${pricingMethod})`
    );
    this.name = 'ScopeChangeRequiresChangeOrderError';
  }
}

/** The live project child's commercial terms. Throws when the engagement has no project child. */
export async function readProjectTermsTx(
  exec: DbExecutor,
  engagementId: string
): Promise<{
  pricingMethod: PricingMethod;
  priceCents: number;
  depositCents: number | null;
  sourceProposalId: string | null;
  /** The expert-side hourly rate on T&M; null on fixed price. */
  rateCents: number | null;
}> {
  const [child] = await exec
    .select({
      pricingMethod: projectEngagements.pricingMethod,
      priceCents: projectEngagements.priceCents,
      depositCents: projectEngagements.depositCents,
      sourceProposalId: projectEngagements.sourceProposalId,
      rateCents: projectEngagements.rateCents,
    })
    .from(projectEngagements)
    .where(
      and(eq(projectEngagements.engagementId, engagementId), isNull(projectEngagements.deletedAt))
    );
  if (child === undefined) {
    throw new Error(`Project engagement not found: ${engagementId}`);
  }
  return child;
}

/**
 * Whether a live `add` line of a live APPROVED change order created `milestoneId`. The line's
 * `engagement_milestone_id` is set only when the order is approved, so a draft or sent add
 * line never matches.
 */
export async function isAddedByApprovedChangeOrderTx(
  tx: DbTx,
  milestoneId: string
): Promise<boolean> {
  const [line] = await tx
    .select({ id: engagementChangeOrderLines.id })
    .from(engagementChangeOrderLines)
    .innerJoin(
      engagementChangeOrders,
      eq(engagementChangeOrders.id, engagementChangeOrderLines.changeOrderId)
    )
    .where(
      and(
        eq(engagementChangeOrderLines.engagementMilestoneId, milestoneId),
        eq(engagementChangeOrderLines.op, 'add'),
        isNull(engagementChangeOrderLines.deletedAt),
        eq(engagementChangeOrders.status, 'approved'),
        isNull(engagementChangeOrders.deletedAt)
      )
    )
    .limit(1);
  return line !== undefined;
}

/** The engagement's open change order that blocks marking it ready, or `null`. */
export async function findMarkReadyBlockerTx(
  tx: DbTx,
  engagementId: string
): Promise<{ id: string; status: EngagementChangeOrder['status'] } | null> {
  const [open] = await tx
    .select({
      id: engagementChangeOrders.id,
      status: engagementChangeOrders.status,
      requestedAt: engagementChangeOrders.requestedAt,
    })
    .from(engagementChangeOrders)
    .where(and(eq(engagementChangeOrders.engagementId, engagementId), openChangeOrderPredicate()))
    .orderBy(asc(engagementChangeOrders.createdAt), asc(engagementChangeOrders.id));
  if (open === undefined || !blocksMarkReady(open)) {
    return null;
  }
  return { id: open.id, status: open.status };
}

/**
 * Refuse a plain edit or removal of `milestoneId` while a live edit/remove line of the
 * engagement's open SENT change order targets it ({@link MilestoneChangePendingError}).
 */
export async function assertMilestoneNotPendingChangeTx(
  tx: DbTx,
  engagementId: string,
  milestoneId: string
): Promise<void> {
  const [pending] = await tx
    .select({ changeOrderId: engagementChangeOrders.id })
    .from(engagementChangeOrderLines)
    .innerJoin(
      engagementChangeOrders,
      eq(engagementChangeOrders.id, engagementChangeOrderLines.changeOrderId)
    )
    .where(
      and(
        eq(engagementChangeOrders.engagementId, engagementId),
        eq(engagementChangeOrders.status, 'sent'),
        openChangeOrderPredicate(),
        eq(engagementChangeOrderLines.engagementMilestoneId, milestoneId),
        inArray(engagementChangeOrderLines.op, ['edit', 'remove']),
        isNull(engagementChangeOrderLines.deletedAt)
      )
    )
    .limit(1);
  if (pending !== undefined) {
    throw new MilestoneChangePendingError(milestoneId, pending.changeOrderId);
  }
}
