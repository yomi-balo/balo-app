import { db } from '../../client';
import { engagementChangeOrderLines, engagementChangeOrders } from '../../schema';
import type {
  EngagementChangeOrder,
  EngagementChangeOrderLine,
  NewEngagementChangeOrder,
  NewEngagementChangeOrderLine,
} from '../../schema';
import { engagementFactory } from './engagement.factory';
import { userFactory } from './user.factory';

type FactoryStatus = EngagementChangeOrder['status'];

interface EngagementChangeOrderFactoryOverrides {
  /** Reuse an existing engagement instead of seeding a fresh active project. */
  engagementId?: string;
  /** The acting user stamped on every actor column the status implies. Defaults to a fresh user. */
  actorUserId?: string;
  /** Defaults to `draft`. */
  status?: FactoryStatus;
  /** Also stamp the client-request pair, as on a draft made from a request. */
  fromRequest?: boolean;
  /** Row-level overrides, applied after the status-derived actor stamps. */
  values?: Partial<NewEngagementChangeOrder>;
  /** Lines to insert, in order (`sortOrder` defaults to the index). */
  lines?: (Omit<NewEngagementChangeOrderLine, 'changeOrderId' | 'sortOrder'> & {
    sortOrder?: number;
  })[];
}

export interface EngagementChangeOrderFactoryResult {
  order: EngagementChangeOrder;
  lines: EngagementChangeOrderLine[];
  engagementId: string;
  actorUserId: string;
}

/** The actor/timestamp pairs a row in `status` carries, so the pair CHECKs hold. */
function stampsFor(
  status: FactoryStatus,
  userId: string,
  at: Date
): Partial<NewEngagementChangeOrder> {
  const sent = { sentByUserId: userId, sentAt: at, note: 'Adds a data migration milestone.' };
  switch (status) {
    case 'requested':
      return { requestedByUserId: userId, requestedAt: at, requestNote: 'Can we add a migration?' };
    case 'draft':
      return {};
    case 'sent':
      return sent;
    case 'approved':
      return { ...sent, decidedByUserId: userId, decidedAt: at };
    case 'declined':
      return {
        ...sent,
        decidedByUserId: userId,
        decidedAt: at,
        declineReason: 'Not this quarter.',
      };
    case 'withdrawn':
      return { withdrawnByUserId: userId, withdrawnAt: at };
  }
}

/**
 * Seeds one `engagement_change_orders` row (default `draft`) plus optional lines under an
 * active project. Inserts directly via `db`, not the repository, so tests can seed any
 * status — including terminal ones and stale `sent_at` values — without driving the
 * guarded lifecycle. The actor columns the status implies are stamped with `actorUserId`.
 */
export async function engagementChangeOrderFactory(
  overrides: EngagementChangeOrderFactoryOverrides = {}
): Promise<EngagementChangeOrderFactoryResult> {
  const engagementId = overrides.engagementId ?? (await engagementFactory()).engagement.id;
  const actorUserId = overrides.actorUserId ?? (await userFactory()).id;
  const status = overrides.status ?? 'draft';

  const [order] = await db
    .insert(engagementChangeOrders)
    .values({
      engagementId,
      status,
      createdByUserId: actorUserId,
      ...stampsFor(status, actorUserId, new Date()),
      ...(overrides.fromRequest === true ? stampsFor('requested', actorUserId, new Date()) : {}),
      ...overrides.values,
    })
    .returning();
  if (order === undefined) {
    throw new Error('engagement change order insert failed');
  }

  const lineValues = (overrides.lines ?? []).map((line, index) => ({
    ...line,
    sortOrder: line.sortOrder ?? index,
    changeOrderId: order.id,
  }));
  const lines =
    lineValues.length === 0
      ? []
      : await db.insert(engagementChangeOrderLines).values(lineValues).returning();

  return { order, lines, engagementId, actorUserId };
}
