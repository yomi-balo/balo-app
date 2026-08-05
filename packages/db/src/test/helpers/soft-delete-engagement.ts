import { db } from '../../client';
import { softDeleteEngagementTx } from '../../repositories/_shared/engagement-supertype';

/**
 * The ONLY sanctioned way for a test fixture to soft-delete an engagement — the test
 * twin of `softDeleteEngagementTx`. Stamps the PARENT `engagements` row AND its
 * concrete child (`project_engagements` / `case_engagements`) with the SAME timestamp.
 *
 * A fixture that stamps only `engagements.deleted_at` leaves the child's
 * `project_request_id` occupying `project_engagement_request_unique_idx` and silently
 * breaks re-materialisation, which is precisely the bug the production helper exists
 * to prevent (reference_softdelete_nonpartial_unique_recreate) — do not hand-roll it
 * in a suite.
 *
 * Idempotent: an already-deleted or missing engagement is a no-op.
 */
export async function softDeleteEngagementFixture(engagementId: string, now?: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await softDeleteEngagementTx(tx, engagementId, now);
  });
}
