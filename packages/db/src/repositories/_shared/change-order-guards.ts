import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { engagementChangeOrderLines, engagementChangeOrders } from '../../schema';
import type { EngagementChangeOrder } from '../../schema';
import type { DbTx } from './engagement-supertype';

/**
 * Change-order guards consumed by OTHER delivery repositories (`engagement-milestones.ts`,
 * `project-engagements.ts`). They live in `_shared/` so neither of those files imports
 * `engagement-change-orders.ts`, which itself imports `engagement-milestones.ts`.
 *
 * Every `…Tx` helper here takes no lock: call it under the engagement lock the caller
 * already holds, so the order it reads cannot change before the caller's write.
 */

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
