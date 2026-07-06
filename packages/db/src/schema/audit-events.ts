import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { engagements } from './engagements';
import { timestamps } from './helpers'; // NOTE: timestamps ONLY — NO softDelete (append-only)

/**
 * audit_events — the immutable delivery audit trail (BAL-330).
 *
 * ADR-lite / DELIBERATE CLAUDE.md EXCEPTION: this is the ONE table in the schema
 * WITHOUT a `deleted_at` soft-delete column. An audit trail is append-only by
 * definition — rows are NEVER updated or deleted. A `deleted_at` column would
 * invite exactly the accidental filtering/mutation an audit log exists to
 * prevent, and would let a bug silently erase history. Immutability IS the
 * feature, so the "every table gets `deleted_at`" rule is intentionally waived
 * here (flagged in the BAL-330 plan §9.1 for review acknowledgement). The
 * `...timestamps` `updated_at` is kept only for column-shape convention; because
 * rows are never updated, `updated_at` always equals `created_at`.
 *
 * Every delivery state transition writes exactly one row here via
 * `recordAuditEvent(tx, …)` in the SAME transaction as the state change (see
 * `repositories/audit-events.ts`). This is an INTERNAL log — it is NOT the
 * notification engine and never sends anything.
 *
 * `action` / `entity_type` are free `text` (not pg enums) deliberately — the TS
 * unions `AuditAction` / `AuditEntityType` enforce the value space at the single
 * write entry point, avoiding an `ALTER TYPE ... ADD VALUE` migration every time a
 * future slice audits a new action (same rationale as
 * `engagements.billing_model`/`approval_model` being text).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null for system/auto actions (e.g. D7 auto-accept). RESTRICT: a user with
    // audit history can never be hard-deleted (mirrors
    // proposal_change_requests.requested_by_user_id RESTRICT).
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    // Free text (TS union `AuditAction` enforced in recordAuditEvent).
    // e.g. 'engagement_milestone.started'.
    action: text('action').notNull(),
    // Polymorphic entity kind (TS union `AuditEntityType`).
    // e.g. 'engagement' | 'engagement_milestone'.
    entityType: text('entity_type').notNull(),
    // Polymorphic id — NO FK (points at an engagement OR a milestone). Integrity is
    // enforced by the helper + the engagement_id FK. Mirrors credit_transactions'
    // reference_id/reference_type polymorphic pattern.
    entityId: uuid('entity_id').notNull(),
    // Denormalised for cheap per-engagement history. Nullable (a non-engagement
    // audit could omit it). SET NULL so a hard-deleted engagement never destroys
    // the immutable trail.
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'set null',
    }),
    // Transition-specific context: { from, to, note?, reason?, acceptance_method?,
    // milestone_count?, … }.
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    // Domain event time (caller may pass; defaults now). The ORDER-BY column for
    // history reads.
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [
    index('audit_event_engagement_occurred_idx').on(t.engagementId, t.occurredAt),
    index('audit_event_entity_idx').on(t.entityType, t.entityId),
    index('audit_event_actor_idx').on(t.actorUserId),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] }),
  engagement: one(engagements, {
    fields: [auditEvents.engagementId],
    references: [engagements.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
