import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';
import type { EngagementType } from './engagement-supertype';

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
  //
  // `engagement.created` is TYPE-AGNOSTIC by design (BAL-417 post-review). Before it,
  // creation was unaudited for BOTH products — the project trail started at
  // `engagement.milestones_snapshotted` (kickoff only, so the seam writer left no trace
  // at all) and the case trail started at `engagement.case_closed`. The fix is therefore
  // ONE generic action emitted by EVERY creation path, not a case-only one; the concrete
  // product is carried in `metadata.engagement_type` so the two are distinguishable
  // downstream without two vocabularies. Emitted via `recordEngagementCreated` below.
  | 'engagement.created'
  | 'engagement.completion_requested'
  | 'engagement.completion_withdrawn'
  | 'engagement.accepted'
  | 'engagement.changes_requested'
  | 'engagement.cancelled'
  | 'engagement.milestones_snapshotted'
  // case lifecycle (BAL-417). There is deliberately NO
  // `engagement.resolution_requested` — the resolution-request pair is columns-only
  // (D1) and its write path (and its audit action) belong to BAL-421.
  | 'engagement.case_closed';

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

/**
 * Record the `engagement.created` row for ONE engagement, inside the caller's creation
 * transaction (BAL-417 post-review). Every engagement creation path calls this — the
 * project seam writer, the project kickoff materialisation, and the case create — so the
 * audit trail begins at creation for BOTH products rather than at the first transition.
 *
 * Defined ONCE here rather than inlined at each call site: three copies of the same
 * `recordDeliveryAudit` literal is exactly the shape Sonar's new-code duplication gate
 * flags, and it would let the `metadata.engagement_type` key drift between products.
 *
 * `actorUserId` is REQUIRED but NULLABLE — pass the human who caused the creation
 * (`materializeFromKickoff` has the approving admin), or `null` when the path genuinely
 * has none. `null` is the ADR-1030 SYSTEM-ACTOR ATTRIBUTION EXEMPTION, the same
 * convention `actionItemsRepository.createFromExtraction` uses for the BAL-387 transcript
 * pipeline and `caseEngagementsRepository.close({ reason: 'auto_inactive' })` uses for the
 * BAL-420 sweep: an unattributed row, never a fabricated actor.
 *
 * `entityId` IS the engagement id (it is the entity being created), and `engagementId` is
 * folded into `metadata` by `recordDeliveryAudit` as usual — both are the same value here.
 */
export async function recordEngagementCreated(
  exec: DbExecutor,
  input: {
    engagementId: string;
    engagementType: EngagementType;
    actorUserId: string | null;
  }
): Promise<void> {
  await recordDeliveryAudit(exec, {
    actorUserId: input.actorUserId,
    action: 'engagement.created',
    entityType: 'engagement',
    entityId: input.engagementId,
    engagementId: input.engagementId,
    // THE DISCRIMINATOR ON THE AUDIT ROW. `audit_events.action` is deliberately
    // type-agnostic, so this is the only thing that tells a downstream reader whether a
    // Case or a Project was created.
    metadata: { engagement_type: input.engagementType },
  });
}
