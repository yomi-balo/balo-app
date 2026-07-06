import { pgTable, uuid, text, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * audit_events (BAL-344) — a generic, reusable, append-only audit log for the
 * whole platform. Introduced for domain auto-capture but deliberately domain-
 * agnostic: any feature can record an immutable "who did what to which entity"
 * row, participating in the same transaction as the change it records.
 *
 * `actorUserId` NULLABLE (system/automated events may have no human actor);
 * RESTRICT to preserve attribution. `action` / `entityType` are TEXT not enums —
 * the audit vocabulary is open-ended and grows without a migration per event.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Who performed the action. NULLABLE (system/automated events may have no
    // human actor); restrict to preserve attribution.
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),

    // Dot-namespaced event type, e.g. 'party_domain.captured'. TEXT not enum —
    // the audit vocabulary is open-ended and grows without a migration per event.
    action: text('action').notNull(),

    // The affected entity. entityType groups by domain ('party_domain'); entityId
    // is that row's uuid (all Balo PKs are uuid).
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),

    // Arbitrary structured context. Typed per drizzle-schema JSONB rule.
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // "History of one entity" — the primary read path.
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
    index('audit_events_actor_idx').on(t.actorUserId),
    index('audit_events_action_idx').on(t.action),
    index('audit_events_created_at_idx').on(t.createdAt),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
