import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { db } from '../client';
import {
  engagementMilestones,
  type Engagement,
  type EngagementMilestone,
  type ProposalMilestone,
} from '../schema';
import { recordDeliveryAudit, type DeliveryAuditAction } from './_shared/delivery-audit';
import { lockActiveEngagement, type DbTx } from './_shared/engagement-lock';

// Re-export so the established public path `import { EngagementNotActiveError } from '@balo/db'`
// (via repositories/index.ts) stays intact after the lock helper moved to _shared.
export { EngagementNotActiveError } from './_shared/engagement-lock';

/** Milestone status, derived from the schema column (single source of truth). */
export type EngagementMilestoneStatus = EngagementMilestone['status'];

/**
 * Allowed milestone status transitions (BAL-330). Mirrors the proposal transition
 * map shape.
 *
 *   pending     → in_progress   (start)
 *   in_progress → completed     (complete)
 *   completed   → in_progress   (revert)
 *
 * The map is the single source of truth for legal moves; ordering carries no
 * semantics.
 */
export const ENGAGEMENT_MILESTONE_STATUS_TRANSITIONS: Record<
  EngagementMilestoneStatus,
  readonly EngagementMilestoneStatus[]
> = {
  pending: ['in_progress'],
  in_progress: ['completed'],
  completed: ['in_progress'], // revert
};

export function isAllowedMilestoneTransition(
  from: EngagementMilestoneStatus,
  to: EngagementMilestoneStatus
): boolean {
  return ENGAGEMENT_MILESTONE_STATUS_TRANSITIONS[from].includes(to);
}

export class InvalidMilestoneTransitionError extends Error {
  constructor(
    public readonly from: EngagementMilestoneStatus,
    public readonly to: EngagementMilestoneStatus
  ) {
    super(`Invalid engagement milestone status transition: ${from} → ${to}`);
    this.name = 'InvalidMilestoneTransitionError';
  }
}

/**
 * Thrown by {@link engagementMilestonesRepository.reorder} when the provided id list
 * is not an exact permutation of the engagement's LIVE milestone id set (a stale tab
 * racing a concurrent add/remove, a duplicate id, or a foreign/soft-deleted id). The
 * whole reorder is rolled back — sort_order is never partially rewritten.
 */
export class MilestoneReorderMismatchError extends Error {
  constructor(public readonly engagementId: string) {
    super(`Reorder id set does not match the live milestones of engagement ${engagementId}`);
    this.name = 'MilestoneReorderMismatchError';
  }
}

/**
 * CONCURRENCY (document once, obeyed everywhere): every milestone transition locks
 * the parent `engagements` row FOR UPDATE FIRST, THEN the milestone row. Holding
 * the engagement lock is a single-writer gate over the whole engagement, so an
 * engagement-level guard (e.g. "all milestones completed" in `requestCompletion`)
 * cannot be raced by a concurrent milestone transition. LOCK ORDER EVERYWHERE:
 * engagement row → then milestone row. Never the reverse (deadlock hazard). This
 * mirrors `proposals.accept`'s documented "proposal first, then relationship".
 */

/**
 * The shared lock dance for milestone-scoped transitions:
 *   1. Unlocked read of the LIVE milestone → discover its `engagement_id`
 *      (lock-order discovery only; the guards run against the FOR-UPDATE re-read).
 *   2. Lock the engagement FOR UPDATE + assert active (`lockActiveEngagement`).
 *   3. Re-read the milestone FOR UPDATE (under the engagement lock).
 * Missing milestone at step 1 or 3 → `Error('Milestone not found')`.
 */
async function lockEngagementAndMilestone(
  tx: DbTx,
  milestoneId: string
): Promise<{ engagement: Engagement; milestone: EngagementMilestone }> {
  const [discovered] = await tx
    .select({ engagementId: engagementMilestones.engagementId })
    .from(engagementMilestones)
    .where(and(eq(engagementMilestones.id, milestoneId), isNull(engagementMilestones.deletedAt)));

  if (discovered === undefined) {
    throw new Error(`Milestone not found: ${milestoneId}`);
  }

  const engagement = await lockActiveEngagement(tx, discovered.engagementId);

  const [milestone] = await tx
    .select()
    .from(engagementMilestones)
    .where(and(eq(engagementMilestones.id, milestoneId), isNull(engagementMilestones.deletedAt)))
    .for('update');

  if (milestone === undefined) {
    throw new Error(`Milestone not found: ${milestoneId}`);
  }

  return { engagement, milestone };
}

/**
 * Shared milestone status transition writer (mirrors `advanceEngagementStatus`).
 * Validates the move against `ENGAGEMENT_MILESTONE_STATUS_TRANSITIONS`, applies
 * `{ status: to, ...set, updatedAt }`, and emits the audit event with the standard
 * `{ from, to, ...extraMetadata }` shape (the caller has already locked the
 * engagement + milestone via `lockEngagementAndMilestone`). Used by
 * start/complete/revert so their bodies stay a single call. Throws
 * `InvalidMilestoneTransitionError` for an illegal move.
 */
async function advanceMilestoneStatus(
  tx: DbTx,
  input: {
    milestone: EngagementMilestone;
    to: EngagementMilestoneStatus;
    userId: string;
    action: DeliveryAuditAction;
    set: Partial<typeof engagementMilestones.$inferInsert>;
    extraMetadata?: Record<string, unknown>;
  }
): Promise<EngagementMilestone> {
  if (!isAllowedMilestoneTransition(input.milestone.status, input.to)) {
    throw new InvalidMilestoneTransitionError(input.milestone.status, input.to);
  }

  const [updated] = await tx
    .update(engagementMilestones)
    .set({ status: input.to, ...input.set, updatedAt: new Date() })
    .where(eq(engagementMilestones.id, input.milestone.id))
    .returning();
  if (updated === undefined) {
    throw new Error(`Failed to transition milestone: ${input.milestone.id}`);
  }

  await recordDeliveryAudit(tx, {
    actorUserId: input.userId,
    action: input.action,
    entityType: 'engagement_milestone',
    entityId: input.milestone.id,
    engagementId: input.milestone.engagementId,
    metadata: { from: input.milestone.status, to: input.to, ...input.extraMetadata },
  });
  return updated;
}

/**
 * Snapshot the accepted proposal's live milestones into `engagement_milestones`
 * within an EXISTING transaction — the delivery counterpart to
 * `insertMilestonesTx`. Pure insert primitive (NO audit inside — the single
 * summary `engagement.milestones_snapshotted` event is emitted by the caller
 * `materializeFromKickoff`, mirroring how `insertMilestonesTx` stays audit-free).
 *
 * Copies title / description / acceptance criteria / value / estimate + provenance
 * (`source_proposal_milestone_id`) and preserves source `sort_order` faithfully.
 * `created_by_user_id` is the approving admin. Empty sources → `[]` (a
 * zero-milestone proposal, e.g. a retainer, is legal).
 */
export async function snapshotFromProposalTx(
  tx: DbTx,
  input: { engagementId: string; approvingAdminUserId: string; sources: ProposalMilestone[] }
): Promise<EngagementMilestone[]> {
  if (input.sources.length === 0) {
    return [];
  }
  return tx
    .insert(engagementMilestones)
    .values(
      input.sources.map((m) => ({
        engagementId: input.engagementId,
        sourceProposalMilestoneId: m.id,
        sortOrder: m.sortOrder, // preserve source order faithfully
        title: m.title,
        descriptionHtml: m.descriptionHtml,
        acceptanceCriteria: m.acceptanceCriteria,
        valueCents: m.valueCents,
        estimatedMinutes: m.estimatedMinutes,
        status: 'pending' as const,
        createdByUserId: input.approvingAdminUserId,
      }))
    )
    .returning();
}

export const engagementMilestonesRepository = {
  /**
   * Start a milestone (pending → in_progress). Stamps `started_by_user_id` /
   * `started_at`. Locks engagement (active) → milestone. Audits
   * `engagement_milestone.started`.
   */
  async start(input: { milestoneId: string; userId: string }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);
      return advanceMilestoneStatus(tx, {
        milestone,
        to: 'in_progress',
        userId: input.userId,
        action: 'engagement_milestone.started',
        set: { startedByUserId: input.userId, startedAt: new Date() },
      });
    });
  },

  /**
   * Complete a milestone (in_progress → completed). Stamps `completed_by_user_id` /
   * `completed_at` / `completion_note`. Audits `engagement_milestone.completed`.
   */
  async complete(input: {
    milestoneId: string;
    userId: string;
    completionNote?: string;
  }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);
      return advanceMilestoneStatus(tx, {
        milestone,
        to: 'completed',
        userId: input.userId,
        action: 'engagement_milestone.completed',
        set: {
          completedByUserId: input.userId,
          completedAt: new Date(),
          completionNote: input.completionNote ?? null,
        },
        extraMetadata:
          input.completionNote === undefined ? undefined : { note: input.completionNote },
      });
    });
  },

  /**
   * Revert a completed milestone (completed → in_progress). CLEARS
   * `completed_by_user_id` / `completed_at` / `completion_note`; KEEPS `started_*`.
   * Audits `engagement_milestone.reverted`.
   */
  async revert(input: { milestoneId: string; userId: string }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);
      return advanceMilestoneStatus(tx, {
        milestone,
        to: 'in_progress',
        userId: input.userId,
        action: 'engagement_milestone.reverted',
        set: { completedByUserId: null, completedAt: null, completionNote: null },
      });
    });
  },

  /**
   * Edit a milestone's DESCRIPTIVE fields (no status change). `valueCents` is
   * DELIBERATELY absent from the signature — the money axis is fixed at snapshot
   * (type-level immutability). Only provided keys are written (an explicit `null`
   * clears; `undefined`/omitted skips). Audits `engagement_milestone.edited`.
   */
  async editDescriptive(input: {
    milestoneId: string;
    userId: string;
    title?: string;
    descriptionHtml?: string | null;
    acceptanceCriteria?: string | null;
    estimatedMinutes?: number | null;
  }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);

      const set: Partial<typeof engagementMilestones.$inferInsert> = { updatedAt: new Date() };
      const fields: string[] = [];
      if (input.title !== undefined) {
        set.title = input.title;
        fields.push('title');
      }
      if (input.descriptionHtml !== undefined) {
        set.descriptionHtml = input.descriptionHtml;
        fields.push('descriptionHtml');
      }
      if (input.acceptanceCriteria !== undefined) {
        set.acceptanceCriteria = input.acceptanceCriteria;
        fields.push('acceptanceCriteria');
      }
      if (input.estimatedMinutes !== undefined) {
        set.estimatedMinutes = input.estimatedMinutes;
        fields.push('estimatedMinutes');
      }

      const [updated] = await tx
        .update(engagementMilestones)
        .set(set)
        .where(eq(engagementMilestones.id, milestone.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to edit milestone: ${input.milestoneId}`);
      }

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_milestone.edited',
        entityType: 'engagement_milestone',
        entityId: milestone.id,
        engagementId: milestone.engagementId,
        metadata: { fields },
      });
      return updated;
    });
  },

  /**
   * Add a NEW milestone to a live, active engagement (a D3 expert-added deliverable
   * — mechanism built + tested in D0). `valueCents` is DELIBERATELY absent (added
   * milestones carry a null value). Inserts `status='pending'`,
   * `source_proposal_milestone_id=null`, `created_by_user_id=userId`,
   * `sort_order = sortOrder ?? (max live sort_order + 1)`. Audits
   * `engagement_milestone.added`.
   */
  async add(input: {
    engagementId: string;
    userId: string;
    title: string;
    descriptionHtml?: string | null;
    acceptanceCriteria?: string | null;
    estimatedMinutes?: number | null;
    sortOrder?: number;
  }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      await lockActiveEngagement(tx, input.engagementId);

      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const [row] = await tx
          .select({ maxSort: max(engagementMilestones.sortOrder) })
          .from(engagementMilestones)
          .where(
            and(
              eq(engagementMilestones.engagementId, input.engagementId),
              isNull(engagementMilestones.deletedAt)
            )
          );
        const maxSort = row?.maxSort ?? null;
        sortOrder = maxSort === null ? 0 : maxSort + 1;
      }

      const [inserted] = await tx
        .insert(engagementMilestones)
        .values({
          engagementId: input.engagementId,
          sourceProposalMilestoneId: null,
          sortOrder,
          title: input.title,
          descriptionHtml: input.descriptionHtml ?? null,
          acceptanceCriteria: input.acceptanceCriteria ?? null,
          estimatedMinutes: input.estimatedMinutes ?? null,
          status: 'pending',
          createdByUserId: input.userId,
        })
        .returning();
      if (inserted === undefined) {
        throw new Error(`Failed to add milestone to engagement: ${input.engagementId}`);
      }

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_milestone.added',
        entityType: 'engagement_milestone',
        entityId: inserted.id,
        engagementId: input.engagementId,
        metadata: { sort_order: sortOrder },
      });
      return inserted;
    });
  },

  /**
   * Soft-delete a milestone (`deleted_at = now`) under a live, active engagement.
   * The row then disappears from `listByEngagement`. Audits
   * `engagement_milestone.removed`. (D0 permits removing a completed milestone; D3
   * may tighten that policy.)
   */
  async softDelete(input: { milestoneId: string; userId: string }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);

      const now = new Date();
      const [updated] = await tx
        .update(engagementMilestones)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(engagementMilestones.id, milestone.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to soft-delete milestone: ${input.milestoneId}`);
      }

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_milestone.removed',
        entityType: 'engagement_milestone',
        entityId: milestone.id,
        engagementId: milestone.engagementId,
        metadata: {},
      });
      return updated;
    });
  },

  /** Live milestones for an engagement, ordered by `sort_order` asc (ties by id). */
  async listByEngagement(engagementId: string): Promise<EngagementMilestone[]> {
    return db
      .select()
      .from(engagementMilestones)
      .where(
        and(
          eq(engagementMilestones.engagementId, engagementId),
          isNull(engagementMilestones.deletedAt)
        )
      )
      .orderBy(asc(engagementMilestones.sortOrder), asc(engagementMilestones.id));
  },

  /**
   * Reorder the LIVE milestones of an active engagement by writing sequential
   * `sort_order` (0..n-1) in the given order (D3 / BAL-333). ONLY touches
   * `sort_order` + `updated_at` — status, provenance, `value_cents`, completion
   * timestamps are UNTOUCHED (this is NOT the destructive REPLACE-ALL that
   * `setForProposal` performs). Lock order: engagement FOR UPDATE + active guard,
   * THEN the live rows FOR UPDATE (single-writer gate over the whole engagement).
   * `orderedMilestoneIds` MUST be an exact permutation of the live id set (same
   * size, no duplicates, same membership) — this guards the concurrent add/remove
   * race — else {@link MilestoneReorderMismatchError}. One transaction, one audit
   * `engagement_milestone.reordered` (engagement-scoped). Returns the fresh ordered
   * live list (mirrors `listByEngagement` ordering).
   */
  async reorder(input: {
    engagementId: string;
    userId: string;
    orderedMilestoneIds: string[];
  }): Promise<EngagementMilestone[]> {
    return db.transaction(async (tx) => {
      await lockActiveEngagement(tx, input.engagementId); // engagement lock + active guard

      const live = await tx
        .select({ id: engagementMilestones.id })
        .from(engagementMilestones)
        .where(
          and(
            eq(engagementMilestones.engagementId, input.engagementId),
            isNull(engagementMilestones.deletedAt)
          )
        )
        .for('update'); // rows locked under the engagement lock

      const liveIds = new Set(live.map((r) => r.id));
      const provided = input.orderedMilestoneIds;
      const uniqueProvided = new Set(provided);
      // Exact permutation: same size, no dupes, same membership (foreign / soft-deleted
      // ids fail the membership check because they are absent from the LIVE set).
      if (
        provided.length !== liveIds.size ||
        uniqueProvided.size !== provided.length ||
        provided.some((id) => !liveIds.has(id))
      ) {
        throw new MilestoneReorderMismatchError(input.engagementId);
      }

      const now = new Date();
      for (let i = 0; i < provided.length; i++) {
        const id = provided[i];
        if (id === undefined) continue; // noUncheckedIndexedAccess guard (unreachable post-validation)
        await tx
          .update(engagementMilestones)
          .set({ sortOrder: i, updatedAt: now })
          .where(eq(engagementMilestones.id, id));
      }

      await recordDeliveryAudit(tx, {
        actorUserId: input.userId,
        action: 'engagement_milestone.reordered',
        entityType: 'engagement', // engagement-scoped op (no single milestone entity)
        entityId: input.engagementId,
        engagementId: input.engagementId,
        metadata: { order: provided },
      });

      return tx
        .select()
        .from(engagementMilestones)
        .where(
          and(
            eq(engagementMilestones.engagementId, input.engagementId),
            isNull(engagementMilestones.deletedAt)
          )
        )
        .orderBy(asc(engagementMilestones.sortOrder), asc(engagementMilestones.id));
    });
  },
};
