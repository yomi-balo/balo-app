import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, type AuditEvent } from '../schema';
import type { DbExecutor } from './_shared/db-executor';
import type { EngagementType } from './_shared/engagement-supertype';

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
   * BAL-400 (S6) — how many rows ONE ACTOR has appended for ONE ACTION since `since`. The
   * append-only log doubles as a durable, infrastructure-free rate-limit counter for write
   * paths that live in `apps/web`, where `apps/api`'s Redis limiter is unreachable (there is
   * no Redis client, and no `REDIS_URL`, in the Next app).
   *
   * ⚠ IT IS A COUNTER, NOT A RESERVATION. It cannot be atomic against a concurrent burst the
   * way a Redis `INCR` is: two simultaneous requests can both read `n` and both proceed. That
   * is accepted — the target is the SCRIPTED loop (thousands of rows), not the two-request
   * race, and the alternative is standing up Redis in `apps/web` for one cap.
   *
   * Rides `audit_events_actor_idx` (`actor_user_id`) with the `action` + `created_at` filters
   * applied on top; one actor's audit history is small enough that no composite index is
   * warranted. `actorUserId` is required here — a `null`-actor (system) row is never rate
   * limited, so a `NULL` argument would be meaningless rather than merely useless.
   *
   * ⚠ N2 (reverify round 3) — `action: 'engagement.created'` is TYPE-AGNOSTIC BY DESIGN
   * (`_shared/delivery-audit.ts`): it fires for BOTH a case create and a project kickoff, with
   * the concrete product distinguished only by `metadata.engagement_type`. A caller that counts
   * `'engagement.created'` WITHOUT `engagementType` is therefore counting BOTH products against
   * ONE shared budget — that was BAL-400's original bug (a burst of approved project kickoffs
   * could exhaust a client's case-booking budget with no case involved). Pass `engagementType`
   * whenever the count is meant to gate one product's write path; only omit it when a budget is
   * deliberately meant to span both (no current caller does this).
   *
   * The `engagementType` filter reads `metadata->>'engagement_type'` via a raw `->>` (jsonb →
   * text) comparison — there is no index on `metadata`, but this still rides
   * `audit_events_actor_idx` first (actor + action + created_at narrow the row set to "one
   * actor's recent history" before the jsonb comparison ever runs), so the extra predicate is
   * cheap.
   */
  countByActorAndActionSince: async (input: {
    actorUserId: string;
    action: string;
    since: Date;
    engagementType?: EngagementType;
  }): Promise<number> => {
    const [row] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, input.actorUserId),
          eq(auditEvents.action, input.action),
          gte(auditEvents.createdAt, input.since),
          input.engagementType === undefined
            ? undefined
            : sql`${auditEvents.metadata} ->> 'engagement_type' = ${input.engagementType}`
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
