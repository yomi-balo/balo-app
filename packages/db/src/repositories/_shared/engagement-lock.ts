import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../client';
import { engagements, type Engagement } from '../../schema';

/**
 * Shared engagement single-writer lock (BAL-330 / BAL-391). Extracted from
 * `engagement-milestones.ts` so BOTH the milestone repo and the action-items repo
 * lock the parent engagement identically (single-writer gate; avoids Sonar new-code
 * duplication of the ~15-line lock). Behaviour is byte-for-byte identical to the
 * original private copies.
 *
 * CONCURRENCY (document once, obeyed everywhere): every engagement-scoped transition
 * locks the parent `engagements` row FOR UPDATE FIRST, THEN the child row (milestone /
 * action item). Holding the engagement lock is a single-writer gate over the whole
 * engagement, so an engagement-level guard cannot be raced by a concurrent child
 * transition. LOCK ORDER EVERYWHERE: engagement row → then child row. Never the reverse
 * (deadlock hazard).
 */

/** Active transaction handle (extracted from `engagement-milestones.ts`). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Thrown when a transition is attempted on a non-active engagement. */
export class EngagementNotActiveError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly status: Engagement['status']
  ) {
    super(`Engagement ${engagementId} is not active (status: ${status})`);
    this.name = 'EngagementNotActiveError';
  }
}

/**
 * Lock the LIVE engagement FOR UPDATE and assert it is `active`. Shared first step
 * of every engagement-scoped transition (milestone + action item). Throws `Error`
 * (missing) / `EngagementNotActiveError` (non-active).
 */
export async function lockActiveEngagement(tx: DbTx, engagementId: string): Promise<Engagement> {
  const [engagement] = await tx
    .select()
    .from(engagements)
    .where(and(eq(engagements.id, engagementId), isNull(engagements.deletedAt)))
    .for('update');

  if (engagement === undefined) {
    throw new Error(`Engagement not found: ${engagementId}`);
  }
  if (engagement.status !== 'active') {
    throw new EngagementNotActiveError(engagementId, engagement.status);
  }
  return engagement;
}
