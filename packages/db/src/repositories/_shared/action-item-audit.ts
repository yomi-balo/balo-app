import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';

/**
 * The action-item audit vocabulary (BAL-391 / ADR-1043). `audit_events` (BAL-344)
 * stores `action` and `entityType` as open `text`, so this union keeps OUR emitted
 * taxonomy typo-safe at compile time WITHOUT the generic repo needing to know it.
 * Mirrors `_shared/delivery-audit.ts`.
 */
export type ActionItemAuditAction =
  | 'action_item.created'
  | 'action_item.assigned'
  | 'action_item.completed'
  | 'action_item.reopened'
  | 'action_item.edited'
  | 'action_item.removed';

export type ActionItemAuditEntityType = 'action_item';

/**
 * Record ONE action-item audit event inside the caller's transaction (pass the `tx`
 * handle — it satisfies `DbExecutor`), folding `engagementId` into `metadata` because
 * main's generic `audit_events` table (BAL-344) has NO `engagement_id` column. The
 * single write path for every action-item mutation, mirroring `recordDeliveryAudit`.
 */
export async function recordActionItemAudit(
  exec: DbExecutor,
  input: {
    actorUserId: string | null;
    action: ActionItemAuditAction;
    actionItemId: string;
    engagementId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'action_item',
      entityId: input.actionItemId,
      metadata: { ...input.metadata, engagementId: input.engagementId },
    },
    exec
  );
}
