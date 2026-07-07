import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { db } from '../client';
import {
  engagementMilestones,
  engagements,
  type Engagement,
  type EngagementMilestone,
  type ProposalMilestone,
} from '../schema';
import { auditEventsRepository } from './audit-events';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The delivery audit vocabulary (BAL-330). `audit_events` (BAL-344) stores `action`
 * and `entityType` as open `text`, so these unions keep OUR emitted taxonomy
 * typo-safe at compile time WITHOUT the generic repo needing to know it — each
 * emitted literal is annotated `satisfies DeliveryAuditAction` /
 * `satisfies DeliveryAuditEntityType`. Shared with `engagements.ts` (the engagement
 * lifecycle half of the same vocabulary).
 *
 * NOTE: `audit_events` has NO `engagement_id` column — every delivery event FOLDS
 * the engagement id into `metadata.engagementId` (see the `.record(...)` calls).
 */
export type DeliveryAuditAction =
  // milestone lifecycle
  | 'engagement_milestone.started'
  | 'engagement_milestone.completed'
  | 'engagement_milestone.reverted'
  | 'engagement_milestone.added'
  | 'engagement_milestone.edited'
  | 'engagement_milestone.removed'
  // engagement lifecycle
  | 'engagement.completion_requested'
  | 'engagement.completion_withdrawn'
  | 'engagement.accepted'
  | 'engagement.changes_requested'
  | 'engagement.cancelled'
  | 'engagement.milestones_snapshotted';

export type DeliveryAuditEntityType = 'engagement' | 'engagement_milestone';

/** Milestone status, derived from the schema column (single source of truth). */
export type EngagementMilestoneStatus = EngagementMilestone['status'];

/** Engagement status, derived from the schema column. */
type EngagementStatus = Engagement['status'];

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

export class EngagementNotActiveError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly status: EngagementStatus
  ) {
    super(`Engagement ${engagementId} is not active (status: ${status})`);
    this.name = 'EngagementNotActiveError';
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
 * Lock the LIVE engagement FOR UPDATE and assert it is `active`. Shared first step
 * of every milestone transition (and `add`). Throws `Error` (missing) /
 * `EngagementNotActiveError` (non-active).
 */
async function lockActiveEngagement(tx: DbTx, engagementId: string): Promise<Engagement> {
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
      if (!isAllowedMilestoneTransition(milestone.status, 'in_progress')) {
        throw new InvalidMilestoneTransitionError(milestone.status, 'in_progress');
      }

      const [updated] = await tx
        .update(engagementMilestones)
        .set({
          status: 'in_progress',
          startedByUserId: input.userId,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(engagementMilestones.id, milestone.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to start milestone: ${input.milestoneId}`);
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.userId,
          action: 'engagement_milestone.started' satisfies DeliveryAuditAction,
          entityType: 'engagement_milestone' satisfies DeliveryAuditEntityType,
          entityId: milestone.id,
          metadata: {
            from: milestone.status,
            to: 'in_progress',
            engagementId: milestone.engagementId,
          },
        },
        tx
      );
      return updated;
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
      if (!isAllowedMilestoneTransition(milestone.status, 'completed')) {
        throw new InvalidMilestoneTransitionError(milestone.status, 'completed');
      }

      const [updated] = await tx
        .update(engagementMilestones)
        .set({
          status: 'completed',
          completedByUserId: input.userId,
          completedAt: new Date(),
          completionNote: input.completionNote ?? null,
          updatedAt: new Date(),
        })
        .where(eq(engagementMilestones.id, milestone.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to complete milestone: ${input.milestoneId}`);
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.userId,
          action: 'engagement_milestone.completed' satisfies DeliveryAuditAction,
          entityType: 'engagement_milestone' satisfies DeliveryAuditEntityType,
          entityId: milestone.id,
          metadata: {
            from: milestone.status,
            to: 'completed',
            engagementId: milestone.engagementId,
            ...(input.completionNote === undefined ? {} : { note: input.completionNote }),
          },
        },
        tx
      );
      return updated;
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
      if (!isAllowedMilestoneTransition(milestone.status, 'in_progress')) {
        throw new InvalidMilestoneTransitionError(milestone.status, 'in_progress');
      }

      const [updated] = await tx
        .update(engagementMilestones)
        .set({
          status: 'in_progress',
          completedByUserId: null,
          completedAt: null,
          completionNote: null,
          updatedAt: new Date(),
        })
        .where(eq(engagementMilestones.id, milestone.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to revert milestone: ${input.milestoneId}`);
      }

      await auditEventsRepository.record(
        {
          actorUserId: input.userId,
          action: 'engagement_milestone.reverted' satisfies DeliveryAuditAction,
          entityType: 'engagement_milestone' satisfies DeliveryAuditEntityType,
          entityId: milestone.id,
          metadata: {
            from: milestone.status,
            to: 'in_progress',
            engagementId: milestone.engagementId,
          },
        },
        tx
      );
      return updated;
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

      await auditEventsRepository.record(
        {
          actorUserId: input.userId,
          action: 'engagement_milestone.edited' satisfies DeliveryAuditAction,
          entityType: 'engagement_milestone' satisfies DeliveryAuditEntityType,
          entityId: milestone.id,
          metadata: { fields, engagementId: milestone.engagementId },
        },
        tx
      );
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

      await auditEventsRepository.record(
        {
          actorUserId: input.userId,
          action: 'engagement_milestone.added' satisfies DeliveryAuditAction,
          entityType: 'engagement_milestone' satisfies DeliveryAuditEntityType,
          entityId: inserted.id,
          metadata: { sort_order: sortOrder, engagementId: input.engagementId },
        },
        tx
      );
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

      await auditEventsRepository.record(
        {
          actorUserId: input.userId,
          action: 'engagement_milestone.removed' satisfies DeliveryAuditAction,
          entityType: 'engagement_milestone' satisfies DeliveryAuditEntityType,
          entityId: milestone.id,
          metadata: { engagementId: milestone.engagementId },
        },
        tx
      );
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
};
