import { auditEvents, type AuditEvent } from '../schema';
import type { DbExecutor } from './_shared/db-executor';

/** Input for one immutable audit row. `metadata` is optional structured context. */
export interface RecordAuditInput {
  actorUserId: string | null;
  action: string; // e.g. 'party_domain.captured'
  entityType: string; // e.g. 'party_domain'
  entityId: string;
  metadata?: Record<string, unknown> | null;
}

export const auditEventsRepository = {
  /**
   * Append one immutable audit row. Takes an executor so it participates in the
   * CALLER'S `db.transaction` — the audit row and the change it records commit or
   * roll back together. Pass the base `db` for standalone use.
   */
  record: async (input: RecordAuditInput, exec: DbExecutor): Promise<AuditEvent> => {
    const [row] = await exec
      .insert(auditEvents)
      .values({
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata ?? null,
      })
      .returning();
    if (row === undefined) {
      throw new Error('audit_events insert returned no row');
    }
    return row;
  },
};
