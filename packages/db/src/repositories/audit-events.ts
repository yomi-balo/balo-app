import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, type AuditEvent } from '../schema';

/** Active transaction handle (matches `advanceProposalStatus` in proposals.ts). */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The polymorphic entity an audit row points at. Free `text` at the DB
 * (`audit_events.entity_type`); the value space is enforced HERE (compile-time)
 * as the single write entry point.
 */
export type AuditEntityType = 'engagement' | 'engagement_milestone';

/**
 * Every delivery `action` audited by the platform. Free `text` at the DB
 * (`audit_events.action`) — this union is the value space, enforced in
 * `recordAuditEvent`. Adding a new action here needs NO migration (the whole point
 * of `text`-not-enum). The D3 milestone edit/add/remove actions are declared now
 * (the mechanism ships in D0, tested here) even though the UI lands later.
 */
export type AuditAction =
  // milestone lifecycle
  | 'engagement_milestone.started'
  | 'engagement_milestone.completed'
  | 'engagement_milestone.reverted'
  | 'engagement_milestone.added' // D3 (method defined + tested in D0)
  | 'engagement_milestone.edited' // D3
  | 'engagement_milestone.removed' // D3
  // engagement lifecycle
  | 'engagement.completion_requested'
  | 'engagement.completion_withdrawn'
  | 'engagement.accepted'
  | 'engagement.changes_requested'
  | 'engagement.cancelled'
  | 'engagement.milestones_snapshotted'; // materialize snapshot

export interface RecordAuditEventInput {
  actorUserId: string | null; // null for system/auto (e.g. D7 auto-accept)
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  engagementId?: string | null;
  metadata?: Record<string, unknown>; // defaults {} at the DB
  occurredAt?: Date; // defaults now() at the DB
}

/**
 * Append one immutable audit row INSIDE the caller's transaction — the SAME tx as
 * the state change it records (composable exactly like `advanceProposalStatus`).
 * Every delivery transition calls this. Insert-only; audit rows are never updated
 * or soft-deleted.
 */
export async function recordAuditEvent(
  tx: DbTx,
  input: RecordAuditEventInput
): Promise<AuditEvent> {
  const [row] = await tx
    .insert(auditEvents)
    .values({
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      engagementId: input.engagementId ?? null,
      metadata: input.metadata ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  if (row === undefined) {
    throw new Error('Failed to record audit event');
  }
  return row;
}

export const auditEventsRepository = {
  /** Immutable history for one engagement, oldest first (ties by id). */
  async listByEngagement(engagementId: string): Promise<AuditEvent[]> {
    return db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.engagementId, engagementId))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  },

  /** Immutable history for one polymorphic entity, oldest first (ties by id). */
  async listByEntity(entityType: AuditEntityType, entityId: string): Promise<AuditEvent[]> {
    return db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id));
  },
};
