import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  expertApplicationDecisions,
  type ExpertDeclineReason,
  type NewExpertApplicationDecision,
} from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/**
 * One archived expert-application decision, as the staff review page reads it. A projection of
 * every column the page renders — INCLUDING the staff-only `declineNote` (see
 * `listForStaffReview`).
 */
export interface ArchivedApplicationDecision {
  id: string;
  decision: 'declined';
  decidedByUserId: string | null;
  decidedAt: Date | null;
  declineReason: ExpertDeclineReason | null;
  /** ⚠ STAFF-ONLY free text. Never on an applicant-facing surface. */
  declineNote: string | null;
  submittedAt: Date | null;
  createdAt: Date;
}

export const expertApplicationDecisionsRepository = {
  /**
   * Append one archived decision on the caller's transaction. Called ONLY by
   * `expertsRepository.reopenApplication`, which copies the values from the profile row it holds
   * `FOR UPDATE` and clears them on the profile in the same transaction.
   */
  async archiveTx(exec: DbExecutor, row: NewExpertApplicationDecision): Promise<{ id: string }> {
    const [inserted] = await exec
      .insert(expertApplicationDecisions)
      .values(row)
      .returning({ id: expertApplicationDecisions.id });
    if (inserted === undefined) {
      throw new Error('expert_application_decisions insert returned no row');
    }
    return inserted;
  },

  /**
   * The archived decisions for one application, NEWEST FIRST (`created_at DESC, id DESC`), live
   * rows only. Rides `expert_application_decisions_profile_idx`.
   *
   * ⚠⚠ THE ONLY READ OF THIS TABLE'S `decline_note`, and `/admin/applications/[profileId]/page.tsx`
   * is its only caller. That page passes the note on only when the viewer holds
   * `REVIEW_EXPERT_APPLICATIONS`, and renders it server-side — it never crosses a `'use client'`
   * boundary and never reaches the applicant. Same rule as
   * `expertsRepository.findApplicationForStaffReview` for the current decision's note.
   */
  async listForStaffReview(expertProfileId: string): Promise<ArchivedApplicationDecision[]> {
    return db
      .select({
        id: expertApplicationDecisions.id,
        decision: expertApplicationDecisions.decision,
        decidedByUserId: expertApplicationDecisions.decidedByUserId,
        decidedAt: expertApplicationDecisions.decidedAt,
        declineReason: expertApplicationDecisions.declineReason,
        declineNote: expertApplicationDecisions.declineNote,
        submittedAt: expertApplicationDecisions.submittedAt,
        createdAt: expertApplicationDecisions.createdAt,
      })
      .from(expertApplicationDecisions)
      .where(
        and(
          eq(expertApplicationDecisions.expertProfileId, expertProfileId),
          isNull(expertApplicationDecisions.deletedAt)
        )
      )
      .orderBy(desc(expertApplicationDecisions.createdAt), desc(expertApplicationDecisions.id));
  },

  /**
   * Whether the application has any live archived decision — i.e. this submit is a
   * resubmission. Read on the caller's transaction (`submitApplication`'s audit metadata).
   */
  async existsForProfileTx(exec: DbExecutor, expertProfileId: string): Promise<boolean> {
    const [row] = await exec
      .select({ id: expertApplicationDecisions.id })
      .from(expertApplicationDecisions)
      .where(
        and(
          eq(expertApplicationDecisions.expertProfileId, expertProfileId),
          isNull(expertApplicationDecisions.deletedAt)
        )
      )
      .limit(1);
    return row !== undefined;
  },
};
