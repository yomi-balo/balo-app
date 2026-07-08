import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';

/**
 * The delivery audit vocabulary (BAL-330). `audit_events` (BAL-344) stores `action`
 * and `entityType` as open `text`, so these unions keep OUR emitted taxonomy
 * typo-safe at compile time WITHOUT the generic repo needing to know it. Shared by
 * both delivery repos (`engagement-milestones.ts` + `engagements.ts`).
 */
export type DeliveryAuditAction =
  // milestone lifecycle
  | 'engagement_milestone.started'
  | 'engagement_milestone.completed'
  | 'engagement_milestone.reverted'
  | 'engagement_milestone.added'
  | 'engagement_milestone.edited'
  | 'engagement_milestone.removed'
  | 'engagement_milestone.reordered'
  // engagement lifecycle
  | 'engagement.completion_requested'
  | 'engagement.completion_withdrawn'
  | 'engagement.accepted'
  | 'engagement.changes_requested'
  | 'engagement.cancelled'
  | 'engagement.milestones_snapshotted';

export type DeliveryAuditEntityType = 'engagement' | 'engagement_milestone';

/**
 * Record ONE delivery audit event inside the caller's transaction (pass the `tx`
 * handle — it satisfies `DbExecutor`), folding `engagementId` into `metadata`
 * because main's generic `audit_events` table (BAL-344) has NO `engagement_id`
 * column. The single write path for every delivery transition, mirroring how
 * `advanceProposalStatus` centralises the proposal write.
 */
export async function recordDeliveryAudit(
  exec: DbExecutor,
  input: {
    actorUserId: string | null;
    action: DeliveryAuditAction;
    entityType: DeliveryAuditEntityType;
    entityId: string;
    engagementId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: { ...input.metadata, engagementId: input.engagementId },
    },
    exec
  );
}
