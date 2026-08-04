import { and, eq, isNull } from 'drizzle-orm';
import { engagements, projectEngagements, type Engagement } from '../../schema';
import {
  EngagementTypeMismatchError,
  type DbTx,
  type EngagementStatus,
  type EngagementType,
  type ProjectDeliveryStatus,
} from './engagement-supertype';

/**
 * Shared engagement single-writer lock (BAL-330 / BAL-391 / BAL-417). Extracted from
 * `engagement-milestones.ts` so BOTH the milestone repo and the action-items repo
 * lock the parent engagement identically (single-writer gate; avoids Sonar new-code
 * duplication of the ~15-line lock).
 *
 * CONCURRENCY (document once, obeyed everywhere): every engagement-scoped transition
 * locks the parent `engagements` row FOR UPDATE FIRST, THEN the child row (the
 * concrete subtype row, then the milestone / action item). Holding the engagement lock
 * is a single-writer gate over the whole engagement, so an engagement-level guard
 * cannot be raced by a concurrent child transition. LOCK ORDER EVERYWHERE: engagement
 * row → then child row. Never the reverse (deadlock hazard).
 */

/** Re-exported so `engagement-milestones.ts` / `action-items.ts` keep their existing import path. */
export type { DbTx };

/** Thrown when a transition is attempted on a non-active engagement. */
export class EngagementNotActiveError extends Error {
  constructor(
    public readonly engagementId: string,
    // WIDENED by BAL-417: for a PROJECT this carries the concrete
    // `delivery_status` (which may be `pending_acceptance`), not the coarse
    // supertype status. Consumers already treat it as an opaque display string.
    public readonly status: EngagementStatus | ProjectDeliveryStatus
  ) {
    super(`Engagement ${engagementId} is not active (status: ${status})`);
    this.name = 'EngagementNotActiveError';
  }
}

/**
 * Lock the LIVE engagement FOR UPDATE and assert it is MUTABLE. Shared first step of
 * every engagement-scoped transition (milestone + action item).
 *
 * "Mutable" is TYPE-DEPENDENT after BAL-417:
 *   - parent `engagements.status` must be `'active'` for every type; AND
 *   - for `engagement_type = 'project'`, the child's `delivery_status` must ALSO be
 *     `'active'` — a project in `pending_acceptance` projects to a parent status of
 *     `'active'` but is NOT mutable (the client is reviewing delivered work).
 *
 * WITHOUT that second read the split would silently REGRESS live behaviour: before
 * BAL-417 a `pending_acceptance` project carried `engagements.status =
 * 'pending_acceptance'` and this gate rejected it. Do not "simplify" it back to a
 * single parent-status check.
 *
 * `opts.requireType` additionally asserts the concrete type. Pass
 * `{ requireType: 'project' }` from milestone writers (milestones are a
 * PROJECT-shaped concept); pass nothing from action-item writers (action items are
 * engagement-generic and INTENTIONALLY widen to cases).
 *
 * LOCK ORDER (documented once, obeyed everywhere): parent `engagements` row FOR
 * UPDATE → THEN the child row. Never the reverse (deadlock hazard).
 *
 * Throws `Error` (missing parent / missing project child) /
 * `EngagementTypeMismatchError` (wrong type) / `EngagementNotActiveError`.
 */
export async function lockActiveEngagement(
  tx: DbTx,
  engagementId: string,
  opts?: { requireType?: EngagementType }
): Promise<Engagement> {
  const [engagement] = await tx
    .select()
    .from(engagements)
    .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
    .for('update');

  if (engagement === undefined) {
    throw new Error(`Engagement not found: ${engagementId}`);
  }
  if (opts?.requireType !== undefined && engagement.engagementType !== opts.requireType) {
    throw new EngagementTypeMismatchError(
      engagementId,
      opts.requireType,
      engagement.engagementType
    );
  }
  if (engagement.status !== 'active') {
    throw new EngagementNotActiveError(engagementId, engagement.status);
  }

  if (engagement.engagementType === 'project') {
    const [child] = await tx
      .select({ deliveryStatus: projectEngagements.deliveryStatus })
      .from(projectEngagements)
      .where(
        and(eq(projectEngagements.engagementId, engagementId), isNull(projectEngagements.deletedAt))
      )
      .for('update');

    if (child === undefined) {
      throw new Error(`Project engagement child row missing: ${engagementId}`);
    }
    if (child.deliveryStatus !== 'active') {
      throw new EngagementNotActiveError(engagementId, child.deliveryStatus);
    }
  }

  return engagement;
}
