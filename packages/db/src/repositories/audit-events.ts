import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
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

  /**
   * Count the immutable audit rows for one entity + action — the indexed
   * "how many times has X happened to this entity" read. Rides
   * `audit_events_entity_idx` (entity_type, entity_id) with the `action` filter
   * applied on top; no JSON/metadata scan (the engagement id IS `entity_id` for
   * engagement-level rows, not only inside `metadata`). Used by BAL-334 to derive
   * `review_cycle` (the number of prior `engagement.completion_requested` rows for
   * an engagement) AFTER the request commits. Standalone read → uses the base `db`.
   */
  countByEntityAndAction: async (input: {
    entityType: string;
    entityId: string;
    action: string;
  }): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, input.entityType),
          eq(auditEvents.entityId, input.entityId),
          eq(auditEvents.action, input.action)
        )
      );
    return row?.count ?? 0;
  },

  /**
   * The MOST-RECENT audit row for one entity + action (BAL-347) — powers the
   * "Last changed by {Name} · {date}" header on the join-mode card. Returns just the
   * actor id + timestamp (the caller batch-hydrates the name), or `undefined` when
   * the action has never occurred. Rides `audit_events_entity_idx` (entity_type,
   * entity_id) with the `action` filter + a `created_at DESC LIMIT 1`.
   */
  findLatestByEntityAndAction: async (input: {
    entityType: string;
    entityId: string;
    action: string;
  }): Promise<{ actorUserId: string | null; createdAt: Date } | undefined> => {
    const [row] = await db
      .select({ actorUserId: auditEvents.actorUserId, createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, input.entityType),
          eq(auditEvents.entityId, input.entityId),
          eq(auditEvents.action, input.action)
        )
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    return row;
  },
};
