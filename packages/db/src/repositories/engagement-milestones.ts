import { and, asc, eq, inArray, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import { isContractedMilestone } from '@balo/shared/engagements';
import { db } from '../client';
import {
  auditEvents,
  engagementMilestones,
  type EngagementMilestone,
  type ProposalMilestone,
} from '../schema';
import { recordDeliveryAudit, type DeliveryAuditAction } from './_shared/delivery-audit';
import {
  lockActiveEngagement,
  lockEngagementAndMilestone,
  type DbTx,
} from './_shared/engagement-lock';
import {
  assertMilestoneNotPendingChangeTx,
  isAddedByApprovedChangeOrderTx,
  MILESTONE_CONTENT_FIELDS,
  readProjectTermsTx,
  ScopeChangeRequiresChangeOrderError,
  type MilestoneContentField,
} from './_shared/change-order-guards';
import { milestoneIdsWithLoggedTimeTx } from './engagement-time-entries';

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
 * Thrown by {@link engagementMilestonesRepository.softDelete} when a time-and-materials
 * milestone has live time logged against it. Removing it would orphan entries the client has
 * seen; the milestone is completed instead. Nothing is written.
 */
export class MilestoneHasLoggedTimeError extends Error {
  constructor(
    public readonly engagementId: string,
    public readonly milestoneId: string
  ) {
    super(`Milestone ${milestoneId} of engagement ${engagementId} has logged time`);
    this.name = 'MilestoneHasLoggedTimeError';
  }
}

/**
 * The prior values of the fields a direct `editDescriptive` changed, recorded as
 * `metadata.before` on its `engagement_milestone.edited` audit row. Only keys whose value
 * actually changed are present.
 */
export type MilestoneEditBefore = Partial<{
  title: string;
  descriptionHtml: string | null;
  acceptanceCriteria: string | null;
  estimatedMinutes: number | null;
}>;

/**
 * One `engagement_milestone.edited` audit row that bears on "changed since the proposal", from
 * {@link engagementMilestonesRepository.listProposalContentEdits}. `direct` is an expert's
 * plain edit and carries the prior values; `change_order` is an approved change order's edit
 * and names the wording fields it wrote (`resetFields`): the client approved that wording, so
 * those fields' baselines reset. A change-order row recorded before the field list existed
 * resets all three.
 */
export type MilestoneContentEditRow =
  | { milestoneId: string; kind: 'direct'; before: MilestoneEditBefore }
  | {
      milestoneId: string;
      kind: 'change_order';
      resetFields: readonly MilestoneContentField[];
    };

export type { MilestoneContentField };

/** A change-order edit row's `metadata.fields`, narrowed to the wording fields; absent (a legacy row) → all three. */
function parseResetFields(raw: unknown): MilestoneContentField[] {
  if (!Array.isArray(raw)) return [...MILESTONE_CONTENT_FIELDS];
  return MILESTONE_CONTENT_FIELDS.filter((field) => raw.some((value) => value === field));
}

/** Narrows an audit row's `metadata.before` key by key, dropping any key of the wrong type. */
function parseEditBefore(raw: unknown): MilestoneEditBefore {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const before: MilestoneEditBefore = {};
  if (typeof record.title === 'string') before.title = record.title;
  if (typeof record.descriptionHtml === 'string' || record.descriptionHtml === null) {
    before.descriptionHtml = record.descriptionHtml;
  }
  if (typeof record.acceptanceCriteria === 'string' || record.acceptanceCriteria === null) {
    before.acceptanceCriteria = record.acceptanceCriteria;
  }
  if (typeof record.estimatedMinutes === 'number' || record.estimatedMinutes === null) {
    before.estimatedMinutes = record.estimatedMinutes;
  }
  return before;
}

/**
 * Shared milestone status transition writer (mirrors `advanceProjectDelivery`, which
 * BAL-417 renamed from `advanceEngagementStatus` when the delivery lifecycle moved to
 * `project-engagements.ts`).
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

/**
 * Revert a completed milestone (completed → in_progress) INSIDE THE CALLER'S
 * TRANSACTION. CLEARS `completed_by_user_id` / `completed_at` / `completion_note`;
 * KEEPS `started_*`. Audits `engagement_milestone.reverted` with
 * `{ from, to, ...extraMetadata }`. Throws `InvalidMilestoneTransitionError` unless
 * `milestone.status` is `completed`.
 *
 * ⚠ PRECONDITION — THE CALLER ALREADY HOLDS THE LOCKS. The parent engagement row must
 * be locked FOR UPDATE in `tx`, and `milestone` must be the row read FOR UPDATE under
 * that lock (lock order engagement → milestone). This helper takes no lock and does
 * NOT run `lockActiveEngagement`: `projectEngagementsRepository.requestChanges` calls
 * it after flipping a `pending_acceptance` project back to `active` under its own
 * lock. The public {@link engagementMilestonesRepository.revert} wraps it with the
 * full lock dance.
 */
export async function revertMilestoneTx(
  tx: DbTx,
  input: {
    milestone: EngagementMilestone;
    userId: string;
    extraMetadata?: Record<string, unknown>;
  }
): Promise<EngagementMilestone> {
  return advanceMilestoneStatus(tx, {
    milestone: input.milestone,
    to: 'in_progress',
    userId: input.userId,
    action: 'engagement_milestone.reverted',
    set: { completedByUserId: null, completedAt: null, completionNote: null },
    extraMetadata: input.extraMetadata,
  });
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
   * Audits `engagement_milestone.reverted`. Locks engagement (active) → milestone,
   * then delegates to {@link revertMilestoneTx}.
   */
  async revert(input: { milestoneId: string; userId: string }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);
      return revertMilestoneTx(tx, { milestone, userId: input.userId });
    });
  },

  /**
   * Edit a milestone's DESCRIPTIVE fields (no status change). `valueCents` is
   * DELIBERATELY absent from the signature — after the snapshot only an approved
   * change order writes it. Only provided keys are written (an explicit `null`
   * clears; `undefined`/omitted skips).
   *
   * Refuses, in this order and writing nothing:
   *   - a milestone targeted by a sent change order (`MilestoneChangePendingError`);
   *   - on time and materials, an estimate that differs from the current one
   *     (`ScopeChangeRequiresChangeOrderError('estimate_change')`). Re-sending the same
   *     estimate is not a change.
   *
   * A changed title, description or acceptance criteria on a milestone that came from the
   * accepted proposal stamps `content_edited_at`. Audits `engagement_milestone.edited` with
   * `{ fields, before? }`, where `before` holds the prior value of each field that changed.
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
      await assertMilestoneNotPendingChangeTx(tx, milestone.engagementId, milestone.id);
      const { pricingMethod } = await readProjectTermsTx(tx, milestone.engagementId);

      const before: MilestoneEditBefore = {};
      if (input.title !== undefined && input.title !== milestone.title) {
        before.title = milestone.title;
      }
      if (
        input.descriptionHtml !== undefined &&
        input.descriptionHtml !== milestone.descriptionHtml
      ) {
        before.descriptionHtml = milestone.descriptionHtml;
      }
      if (
        input.acceptanceCriteria !== undefined &&
        input.acceptanceCriteria !== milestone.acceptanceCriteria
      ) {
        before.acceptanceCriteria = milestone.acceptanceCriteria;
      }
      if (
        input.estimatedMinutes !== undefined &&
        input.estimatedMinutes !== milestone.estimatedMinutes
      ) {
        before.estimatedMinutes = milestone.estimatedMinutes;
      }

      if (pricingMethod === 'tm' && 'estimatedMinutes' in before) {
        throw new ScopeChangeRequiresChangeOrderError(
          'estimate_change',
          pricingMethod,
          milestone.engagementId,
          milestone.id
        );
      }

      const now = new Date();
      const set: Partial<typeof engagementMilestones.$inferInsert> = { updatedAt: now };
      if (
        milestone.sourceProposalMilestoneId !== null &&
        MILESTONE_CONTENT_FIELDS.some((field) => field in before)
      ) {
        set.contentEditedAt = now;
      }
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
        metadata: { fields, ...(Object.keys(before).length > 0 ? { before } : {}) },
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
   * `engagement_milestone.added`. Refuses on time and materials, writing nothing
   * (`ScopeChangeRequiresChangeOrderError('add_on_tm')`): a new milestone there grows the
   * billable estimate, so it goes through a change order.
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
      await lockActiveEngagement(tx, input.engagementId, { requireType: 'project' });
      const { pricingMethod } = await readProjectTermsTx(tx, input.engagementId);
      if (pricingMethod === 'tm') {
        throw new ScopeChangeRequiresChangeOrderError(
          'add_on_tm',
          pricingMethod,
          input.engagementId,
          null
        );
      }

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
   * may tighten that policy.) Refuses, writing nothing, a milestone targeted by a sent
   * change order (`MilestoneChangePendingError`), then — on a fixed price — contracted scope
   * (`ScopeChangeRequiresChangeOrderError('remove_contracted')`): a milestone from the
   * accepted proposal, one carrying a value, or one an approved change order added
   * (`isContractedMilestone`). On time and materials, a milestone with live time logged
   * (`MilestoneHasLoggedTimeError`); any other T&M milestone is removable.
   */
  async softDelete(input: { milestoneId: string; userId: string }): Promise<EngagementMilestone> {
    return db.transaction(async (tx) => {
      const { milestone } = await lockEngagementAndMilestone(tx, input.milestoneId);
      await assertMilestoneNotPendingChangeTx(tx, milestone.engagementId, milestone.id);
      const { pricingMethod } = await readProjectTermsTx(tx, milestone.engagementId);
      if (
        pricingMethod === 'tm' &&
        (await milestoneIdsWithLoggedTimeTx(tx, milestone.engagementId)).has(milestone.id)
      ) {
        throw new MilestoneHasLoggedTimeError(milestone.engagementId, milestone.id);
      }
      if (pricingMethod === 'fixed') {
        const addedByApprovedChangeOrder =
          !isContractedMilestone(milestone, false) &&
          (await isAddedByApprovedChangeOrderTx(tx, milestone.id));
        if (isContractedMilestone(milestone, addedByApprovedChangeOrder)) {
          throw new ScopeChangeRequiresChangeOrderError(
            'remove_contracted',
            pricingMethod,
            milestone.engagementId,
            milestone.id
          );
        }
      }

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

  /**
   * The `engagement_milestone.edited` audit rows for `milestoneIds` that bear on "changed since
   * the proposal": direct edits that recorded `before`, and approved change-order edits (which
   * carry `changeOrderId` and reset the baseline of the wording fields they wrote). Edits that
   * recorded neither are left out. Ordered by the audit trail contract (`created_at`, then
   * `seq`). Empty input returns `[]` without a query.
   */
  async listProposalContentEdits(
    milestoneIds: readonly string[]
  ): Promise<MilestoneContentEditRow[]> {
    if (milestoneIds.length === 0) return [];
    const rows = await db
      .select({ entityId: auditEvents.entityId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'engagement_milestone'),
          inArray(auditEvents.entityId, [...milestoneIds]),
          eq(auditEvents.action, 'engagement_milestone.edited'),
          or(
            isNotNull(sql`${auditEvents.metadata} -> 'before'`),
            isNotNull(sql`${auditEvents.metadata} -> 'changeOrderId'`)
          )
        )
      )
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.seq));

    return rows.map((row): MilestoneContentEditRow => {
      const metadata = row.metadata ?? {};
      if (metadata.changeOrderId !== undefined && metadata.changeOrderId !== null) {
        return {
          milestoneId: row.entityId,
          kind: 'change_order',
          resetFields: parseResetFields(metadata.fields),
        };
      }
      return {
        milestoneId: row.entityId,
        kind: 'direct',
        before: parseEditBefore(metadata.before),
      };
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
      // engagement lock + active guard (+ project-type guard — BAL-417)
      await lockActiveEngagement(tx, input.engagementId, { requireType: 'project' });

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
