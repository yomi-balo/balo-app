import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { actionItems, type ActionItem, type Engagement, type NewActionItem } from '../schema';
import { lockActiveEngagement, type DbTx } from './_shared/engagement-lock';
import { recordActionItemAudit, type ActionItemAuditAction } from './_shared/action-item-audit';

/** Action-item status, derived from the schema column (single source of truth). */
export type ActionItemStatus = ActionItem['status'];

/** Which SIDE of the engagement owns the item (never `null` — `null` = unassigned). */
export type ActionItemAssigneeParty = NonNullable<ActionItem['assigneeParty']>;

/**
 * Allowed action-item status transitions (BAL-391). Mirrors the milestone transition
 * map shape.
 *
 *   open → done   (complete)
 *   done → open   (reopen)
 *
 * The map is the single source of truth for legal moves; ordering carries no
 * semantics.
 */
export const ACTION_ITEM_STATUS_TRANSITIONS: Record<ActionItemStatus, readonly ActionItemStatus[]> =
  {
    open: ['done'], // complete
    done: ['open'], // reopen
  };

export function isAllowedActionItemTransition(
  from: ActionItemStatus,
  to: ActionItemStatus
): boolean {
  return ACTION_ITEM_STATUS_TRANSITIONS[from].includes(to);
}

/** Thrown when a complete/reopen is attempted on an already-terminal (same) status. */
export class InvalidActionItemTransitionError extends Error {
  constructor(
    public readonly from: ActionItemStatus,
    public readonly to: ActionItemStatus
  ) {
    super(`Invalid action item status transition: ${from} → ${to}`);
    this.name = 'InvalidActionItemTransitionError';
  }
}

/**
 * The shared lock dance for action-item-scoped mutations (mirrors
 * `lockEngagementAndMilestone`):
 *   1. Unlocked read of the LIVE item → discover its `engagement_id` (lock-order
 *      discovery only; guards run against the FOR-UPDATE re-read).
 *   2. Lock the engagement FOR UPDATE + assert active (`lockActiveEngagement`).
 *   3. Re-read the item FOR UPDATE (under the engagement lock).
 * Missing item at step 1 or 3 → `Error('Action item not found')`. LOCK ORDER:
 * engagement row → then action-item row (never the reverse).
 */
async function lockEngagementAndActionItem(
  tx: DbTx,
  actionItemId: string
): Promise<{ engagement: Engagement; actionItem: ActionItem }> {
  const [discovered] = await tx
    .select({ engagementId: actionItems.engagementId })
    .from(actionItems)
    .where(and(eq(actionItems.id, actionItemId), isNull(actionItems.deletedAt)));

  if (discovered === undefined) {
    throw new Error(`Action item not found: ${actionItemId}`);
  }

  const engagement = await lockActiveEngagement(tx, discovered.engagementId);

  const [actionItem] = await tx
    .select()
    .from(actionItems)
    .where(and(eq(actionItems.id, actionItemId), isNull(actionItems.deletedAt)))
    .for('update');

  if (actionItem === undefined) {
    throw new Error(`Action item not found: ${actionItemId}`);
  }

  return { engagement, actionItem };
}

/**
 * Shared status-transition writer (mirrors `advanceMilestoneStatus`). Validates the
 * move against `ACTION_ITEM_STATUS_TRANSITIONS`, applies `{ status: to, ...set,
 * updatedAt }`, and emits `{ from, to }` audit metadata (the caller has already
 * locked the engagement + item via `lockEngagementAndActionItem`). Throws
 * `InvalidActionItemTransitionError` for an illegal move.
 */
async function advanceActionItemStatus(
  tx: DbTx,
  input: {
    actionItem: ActionItem;
    to: ActionItemStatus;
    userId: string;
    action: ActionItemAuditAction;
    set: Partial<NewActionItem>;
  }
): Promise<ActionItem> {
  if (!isAllowedActionItemTransition(input.actionItem.status, input.to)) {
    throw new InvalidActionItemTransitionError(input.actionItem.status, input.to);
  }

  const [updated] = await tx
    .update(actionItems)
    .set({ status: input.to, ...input.set, updatedAt: new Date() })
    .where(eq(actionItems.id, input.actionItem.id))
    .returning();
  if (updated === undefined) {
    throw new Error(`Failed to transition action item: ${input.actionItem.id}`);
  }

  await recordActionItemAudit(tx, {
    actorUserId: input.userId,
    action: input.action,
    actionItemId: input.actionItem.id,
    engagementId: input.actionItem.engagementId,
    metadata: { from: input.actionItem.status, to: input.to },
  });
  return updated;
}

export const actionItemsRepository = {
  /**
   * Create ONE manual action item (source `manual`) under a live, active engagement.
   * Stamps `created_by_user_id = userId`; when an `assigneeParty` is supplied the
   * create also assigns (stamps `assigned_by_user_id`/`assigned_at`). Audits
   * `action_item.created`.
   */
  async createManual(input: {
    engagementId: string;
    userId: string;
    body: string;
    assigneeParty?: ActionItemAssigneeParty | null;
    dueAt?: Date | null;
    meetingId?: string | null;
  }): Promise<ActionItem> {
    return db.transaction(async (tx) => {
      await lockActiveEngagement(tx, input.engagementId);

      const assigneeParty = input.assigneeParty ?? null;
      const dueAt = input.dueAt ?? null;
      const now = new Date();

      const [inserted] = await tx
        .insert(actionItems)
        .values({
          engagementId: input.engagementId,
          meetingId: input.meetingId ?? null,
          body: input.body,
          source: 'manual',
          status: 'open',
          assigneeParty,
          dueAt,
          createdByUserId: input.userId,
          assignedByUserId: assigneeParty === null ? null : input.userId,
          assignedAt: assigneeParty === null ? null : now,
        })
        .returning();
      if (inserted === undefined) {
        throw new Error(`Failed to create action item for engagement: ${input.engagementId}`);
      }

      await recordActionItemAudit(tx, {
        actorUserId: input.userId,
        action: 'action_item.created',
        actionItemId: inserted.id,
        engagementId: input.engagementId,
        metadata: { source: 'manual', assignee_party: assigneeParty, has_due: dueAt !== null },
      });
      return inserted;
    });
  },

  /**
   * FORWARD SEAM (BAL-387, no live producer yet). Bulk-create action items from a
   * meeting extraction (source `ai_extracted`) under a live, active engagement. The
   * actor is OPTIONAL — the pipeline has no human actor, so `created_by_user_id`
   * (and any assignment stamp) defaults to `null`. Emits one `action_item.created`
   * audit per inserted row. An empty `items` list is a legal no-op → `[]` (no lock,
   * no audit). A future meeting-write worker can call this standalone; composing it
   * inside a larger tx (an `exec?: DbExecutor` param) is a trivial later extension.
   */
  async createFromExtraction(input: {
    engagementId: string;
    meetingId?: string | null;
    actorUserId?: string | null;
    items: { body: string; assigneeParty?: ActionItemAssigneeParty | null; dueAt?: Date | null }[];
  }): Promise<ActionItem[]> {
    if (input.items.length === 0) {
      return [];
    }
    return db.transaction(async (tx) => {
      await lockActiveEngagement(tx, input.engagementId);

      const actorUserId = input.actorUserId ?? null;
      const meetingId = input.meetingId ?? null;
      const now = new Date();

      const inserted = await tx
        .insert(actionItems)
        .values(
          input.items.map((item) => {
            const assigneeParty = item.assigneeParty ?? null;
            return {
              engagementId: input.engagementId,
              meetingId,
              body: item.body,
              source: 'ai_extracted' as const,
              status: 'open' as const,
              assigneeParty,
              dueAt: item.dueAt ?? null,
              createdByUserId: actorUserId,
              // An extraction-carried party assignment is stamped without a human
              // actor on the ai path (assignedBy mirrors createdBy = actor ?? null).
              assignedByUserId: assigneeParty === null ? null : actorUserId,
              assignedAt: assigneeParty === null ? null : now,
            };
          })
        )
        .returning();
      if (inserted.length !== input.items.length) {
        throw new Error(`Failed to bulk-create action items for engagement: ${input.engagementId}`);
      }

      for (const row of inserted) {
        await recordActionItemAudit(tx, {
          actorUserId,
          action: 'action_item.created',
          actionItemId: row.id,
          engagementId: input.engagementId,
          metadata: {
            source: 'ai_extracted',
            assignee_party: row.assigneeParty,
            has_due: row.dueAt !== null,
          },
        });
      }
      return inserted;
    });
  },

  /**
   * Assign (or reassign, or clear) the item to a SIDE of the engagement. Setting
   * `assigneeParty` stamps `assigned_by_user_id = userId` / `assigned_at = now`;
   * passing `null` CLEARS both (unassign). Idempotent — assigning the same party
   * again is allowed. Audits `action_item.assigned` with `{ from, to }`.
   */
  async assign(input: {
    actionItemId: string;
    userId: string;
    assigneeParty: ActionItemAssigneeParty | null;
  }): Promise<ActionItem> {
    return db.transaction(async (tx) => {
      const { actionItem } = await lockEngagementAndActionItem(tx, input.actionItemId);
      const prev = actionItem.assigneeParty;
      const now = new Date();

      const set: Partial<NewActionItem> = { updatedAt: now };
      if (input.assigneeParty === null) {
        set.assigneeParty = null;
        set.assignedByUserId = null;
        set.assignedAt = null;
      } else {
        set.assigneeParty = input.assigneeParty;
        set.assignedByUserId = input.userId;
        set.assignedAt = now;
      }

      const [updated] = await tx
        .update(actionItems)
        .set(set)
        .where(eq(actionItems.id, actionItem.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to assign action item: ${input.actionItemId}`);
      }

      await recordActionItemAudit(tx, {
        actorUserId: input.userId,
        action: 'action_item.assigned',
        actionItemId: actionItem.id,
        engagementId: actionItem.engagementId,
        metadata: { from: prev, to: input.assigneeParty },
      });
      return updated;
    });
  },

  /**
   * Complete an item (open → done). Stamps `completed_by_user_id` / `completed_at`.
   * Rejects a double-complete via the transition map. Audits `action_item.completed`.
   */
  async complete(input: { actionItemId: string; userId: string }): Promise<ActionItem> {
    return db.transaction(async (tx) => {
      const { actionItem } = await lockEngagementAndActionItem(tx, input.actionItemId);
      return advanceActionItemStatus(tx, {
        actionItem,
        to: 'done',
        userId: input.userId,
        action: 'action_item.completed',
        set: { completedByUserId: input.userId, completedAt: new Date() },
      });
    });
  },

  /**
   * Reopen an item (done → open). CLEARS `completed_by_user_id` / `completed_at`.
   * Rejects a double-reopen via the transition map. Audits `action_item.reopened`.
   */
  async reopen(input: { actionItemId: string; userId: string }): Promise<ActionItem> {
    return db.transaction(async (tx) => {
      const { actionItem } = await lockEngagementAndActionItem(tx, input.actionItemId);
      return advanceActionItemStatus(tx, {
        actionItem,
        to: 'open',
        userId: input.userId,
        action: 'action_item.reopened',
        set: { completedByUserId: null, completedAt: null },
      });
    });
  },

  /**
   * Edit an item's `body` and/or `due_at` (no status change). Only provided keys are
   * written (an explicit `null` on `dueAt` clears; `undefined`/omitted skips). Tracks
   * the changed field names. Audits `action_item.edited` with `{ fields }`.
   */
  async edit(input: {
    actionItemId: string;
    userId: string;
    body?: string;
    dueAt?: Date | null;
  }): Promise<ActionItem> {
    return db.transaction(async (tx) => {
      const { actionItem } = await lockEngagementAndActionItem(tx, input.actionItemId);

      const set: Partial<NewActionItem> = { updatedAt: new Date() };
      const fields: string[] = [];
      if (input.body !== undefined) {
        set.body = input.body;
        fields.push('body');
      }
      if (input.dueAt !== undefined) {
        set.dueAt = input.dueAt;
        fields.push('dueAt');
      }

      const [updated] = await tx
        .update(actionItems)
        .set(set)
        .where(eq(actionItems.id, actionItem.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to edit action item: ${input.actionItemId}`);
      }

      await recordActionItemAudit(tx, {
        actorUserId: input.userId,
        action: 'action_item.edited',
        actionItemId: actionItem.id,
        engagementId: actionItem.engagementId,
        metadata: { fields },
      });
      return updated;
    });
  },

  /**
   * Soft-remove an item (`deleted_at = now`) under a live, active engagement. The row
   * then disappears from `listByEngagement`. Audits `action_item.removed`.
   */
  async softRemove(input: { actionItemId: string; userId: string }): Promise<ActionItem> {
    return db.transaction(async (tx) => {
      const { actionItem } = await lockEngagementAndActionItem(tx, input.actionItemId);

      const now = new Date();
      const [updated] = await tx
        .update(actionItems)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(actionItems.id, actionItem.id))
        .returning();
      if (updated === undefined) {
        throw new Error(`Failed to soft-remove action item: ${input.actionItemId}`);
      }

      await recordActionItemAudit(tx, {
        actorUserId: input.userId,
        action: 'action_item.removed',
        actionItemId: actionItem.id,
        engagementId: actionItem.engagementId,
        metadata: {},
      });
      return updated;
    });
  },

  /** Live action items for an engagement, ordered `created_at` asc (ties by id). */
  async listByEngagement(engagementId: string): Promise<ActionItem[]> {
    return db
      .select()
      .from(actionItems)
      .where(and(eq(actionItems.engagementId, engagementId), isNull(actionItems.deletedAt)))
      .orderBy(asc(actionItems.createdAt), asc(actionItems.id));
  },

  /**
   * ONE live action item by id (the web IDOR gate discovers `engagementId` from it,
   * then checks it against the resolved engagement). `undefined` when missing or
   * soft-removed.
   */
  async findById(id: string): Promise<ActionItem | undefined> {
    const [row] = await db
      .select()
      .from(actionItems)
      .where(and(eq(actionItems.id, id), isNull(actionItems.deletedAt)))
      .limit(1);
    return row;
  },

  /**
   * FORWARD READ (BAL-388 recap). Live action items for a meeting, ordered
   * `created_at` asc (ties by id). Rides `action_item_meeting_idx`.
   */
  async listByMeeting(meetingId: string): Promise<ActionItem[]> {
    return db
      .select()
      .from(actionItems)
      .where(and(eq(actionItems.meetingId, meetingId), isNull(actionItems.deletedAt)))
      .orderBy(asc(actionItems.createdAt), asc(actionItems.id));
  },
};
