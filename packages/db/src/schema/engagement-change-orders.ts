import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { engagementChangeOrderLineOpEnum, engagementChangeOrderStatusEnum } from './enums';
import { engagements } from './engagements';
import { engagementMilestones } from './engagement-milestones';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * engagement_change_orders — one row per change order on a live project: an amendment to
 * the delivery plan (added, edited and removed milestones) plus a signed expert-side
 * price delta — the price on a fixed-price project, the cap on a T&M one. Nothing applies
 * until the client approves; approval writes the lines onto `engagement_milestones` and the
 * delta becomes part of the effective price (`price_cents` + Σ approved
 * `price_delta_cents`) in one transaction.
 *
 * A client request opens the row as `requested` (`request_note`); the expert either turns
 * it into a draft or answers it without a change order (stored as `declined`, with the
 * answer in `decline_reason`). An expert can also open a fresh `draft`.
 *
 * FK TARGET IS THE SUPERTYPE (`engagements.id`) with CASCADE, mirroring
 * `engagement_milestones` and `project_change_requests`. Orders are PROJECT-only by
 * writer, not by constraint — every writer locks the active project first.
 *
 * ONE OPEN ORDER PER ENGAGEMENT — `engagement_change_order_one_open_idx`. "Open" is
 * defined by timestamps only (`decided_at`, `withdrawn_at`, `deleted_at` all NULL), never
 * by a status literal, so the predicate is safe against a later `ADD VALUE`.
 *
 * STATUS ⇔ TIMESTAMPS — the `*_stamped` / `open_unstamped` CHECKs tie each status to the
 * timestamps it implies, so the timestamp-only "open" predicate and the status always
 * agree. CHECKs (unlike partial-index predicates) may name enum literals created in the
 * same migration.
 *
 * ACTOR-FK INDEXING — the four actor columns are DELIBERATELY UNINDEXED, the same ruling
 * as the actor FKs on `project_engagements`: nothing filters or joins on them (they are
 * hydrated by id over the `users` PK), and users are never hard-deleted, so the
 * `restrict` FK's delete-time scan never runs.
 *
 * MONEY — `price_delta_cents` is EXPERT-SIDE. The client figure is always derived through
 * `applyBaloFee` at the read layer (`@balo/shared/engagements`), never stored here.
 *
 * NO RLS — A KNOWING DEVIATION, RECORDED. No schema file in this package calls
 * `.enableRLS()` or `pgPolicy()`: Balo authenticates with WorkOS + iron-session, so a
 * Supabase-shaped policy would be decoration; every reader is the admin `db` client and
 * the boundary is the application layer (membership capabilities for the client acts, the
 * engagement axis for the expert acts). ⚠ This deviates from the `drizzle-schema` skill
 * ("Forgetting RLS on new tables") and is flagged in the PR body, as
 * `project-change-requests.ts` does.
 */
export const engagementChangeOrders = pgTable(
  'engagement_change_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Parent engagement — CASCADE (orders die with the engagement).
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),

    /** Lifecycle position. No default — every writer names the status it inserts. */
    status: engagementChangeOrderStatusEnum('status').notNull(),

    /** The client's note when they asked for the change. NULL on an expert-opened order. */
    requestNote: text('request_note'),

    /** The expert's "what's changing and why". Required at send (coherence `note_missing`). */
    note: text('note'),

    /**
     * Signed expert-side change to the price (fixed) or the cap (T&M); NULL on a
     * scope-only change. The repository derives it under the engagement lock from the
     * caller's intended new total, against the effective price at that moment.
     */
    priceDeltaCents: integer('price_delta_cents'),

    // ── Actors (RESTRICT preserves attribution) + their timestamps ──
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    requestedAt: timestamp('requested_at', { withTimezone: true }),

    /** Whoever inserted the row: the requesting client, or the expert opening a draft. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    sentByUserId: uuid('sent_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    /** Who approved or declined (a client) — or who answered a request (an expert). */
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    withdrawnByUserId: uuid('withdrawn_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),

    /** The client's reason for declining, or the expert's answer to a request. */
    declineReason: text('decline_reason'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // At most one OPEN order per engagement. Timestamps only in the predicate.
    uniqueIndex('engagement_change_order_one_open_idx')
      .on(t.engagementId)
      .where(sql`${t.decidedAt} IS NULL AND ${t.withdrawnAt} IS NULL AND ${t.deletedAt} IS NULL`),
    // The workspace reads an engagement's live orders oldest → newest.
    index('engagement_change_order_engagement_idx')
      .on(t.engagementId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    // The stale-order finder scans open orders by `sent_at`.
    index('engagement_change_order_open_sent_idx')
      .on(t.sentAt)
      .where(sql`${t.decidedAt} IS NULL AND ${t.withdrawnAt} IS NULL AND ${t.deletedAt} IS NULL`),
    check(
      'engagement_change_order_requested_pair',
      sql`(${t.requestedAt} IS NULL) = (${t.requestedByUserId} IS NULL)`
    ),
    check(
      'engagement_change_order_sent_pair',
      sql`(${t.sentAt} IS NULL) = (${t.sentByUserId} IS NULL)`
    ),
    check(
      'engagement_change_order_decided_pair',
      sql`(${t.decidedAt} IS NULL) = (${t.decidedByUserId} IS NULL)`
    ),
    check(
      'engagement_change_order_withdrawn_pair',
      sql`(${t.withdrawnAt} IS NULL) = (${t.withdrawnByUserId} IS NULL)`
    ),
    check(
      'engagement_change_order_decided_xor_withdrawn',
      sql`NOT (${t.decidedAt} IS NOT NULL AND ${t.withdrawnAt} IS NOT NULL)`
    ),
    check(
      'engagement_change_order_decided_stamped',
      sql`(${t.status} <> 'approved' AND ${t.status} <> 'declined') OR (${t.decidedAt} IS NOT NULL AND ${t.decidedByUserId} IS NOT NULL)`
    ),
    check(
      'engagement_change_order_withdrawn_stamped',
      sql`${t.status} <> 'withdrawn' OR ${t.withdrawnAt} IS NOT NULL`
    ),
    check(
      'engagement_change_order_sent_stamped',
      sql`(${t.status} <> 'sent' AND ${t.status} <> 'approved') OR ${t.sentAt} IS NOT NULL`
    ),
    check(
      'engagement_change_order_open_unstamped',
      sql`(${t.status} <> 'requested' AND ${t.status} <> 'draft' AND ${t.status} <> 'sent') OR (${t.decidedAt} IS NULL AND ${t.withdrawnAt} IS NULL)`
    ),
    check(
      'engagement_change_order_requested_stamped',
      sql`${t.status} <> 'requested' OR ${t.requestedAt} IS NOT NULL`
    ),
  ]
);

/**
 * engagement_change_order_lines — the milestone amendments one change order proposes.
 *
 *   add    — a new milestone; `engagement_milestone_id` is NULL until approval, when it is
 *            backfilled with the inserted milestone (the "added by an approved change"
 *            provenance).
 *   edit   — the full after-state of title and description (plus the estimate on T&M);
 *            `acceptance_criteria` / `value_cents` apply only when non-null.
 *   remove — soft-deletes the target on approval; `title` copies the live title.
 *
 * `before_*` are stamped at send from the live milestone, so the history view can show
 * before/after (and the T&M estimate delta) after the milestone itself has moved on.
 *
 * `engagement_milestone_id` CASCADES: milestones are only ever soft-deleted, and CASCADE
 * avoids an FK ordering failure when an engagement is hard-deleted (its milestones and
 * orders both cascade from it). Lines are soft-deleted by `replaceLines`.
 *
 * NO RLS — the same recorded deviation as `engagement_change_orders` above.
 */
export const engagementChangeOrderLines = pgTable(
  'engagement_change_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    changeOrderId: uuid('change_order_id')
      .notNull()
      .references(() => engagementChangeOrders.id, { onDelete: 'cascade' }),

    op: engagementChangeOrderLineOpEnum('op').notNull(),

    engagementMilestoneId: uuid('engagement_milestone_id').references(
      () => engagementMilestones.id,
      { onDelete: 'cascade' }
    ),

    // ── After-state (descriptionHtml is sanitised in the web caller) ──
    title: text('title').notNull(),
    descriptionHtml: text('description_html'),
    acceptanceCriteria: text('acceptance_criteria'),
    valueCents: integer('value_cents'),
    estimatedMinutes: integer('estimated_minutes'),

    // ── Before-state, stamped at send for edit/remove lines ──
    beforeTitle: text('before_title'),
    beforeDescriptionHtml: text('before_description_html'),
    beforeEstimatedMinutes: integer('before_estimated_minutes'),

    sortOrder: integer('sort_order').notNull(),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('engagement_change_order_line_order_idx')
      .on(t.changeOrderId, t.sortOrder)
      .where(sql`${t.deletedAt} IS NULL`),
    index('engagement_change_order_line_milestone_idx')
      .on(t.engagementMilestoneId)
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      'engagement_change_order_line_target',
      sql`${t.op} = 'add' OR ${t.engagementMilestoneId} IS NOT NULL`
    ),
    check(
      'engagement_change_order_line_value_nonneg',
      sql`${t.valueCents} IS NULL OR ${t.valueCents} >= 0`
    ),
    check(
      'engagement_change_order_line_estimate_nonneg',
      sql`${t.estimatedMinutes} IS NULL OR ${t.estimatedMinutes} >= 0`
    ),
    check('engagement_change_order_line_sort_nonneg', sql`${t.sortOrder} >= 0`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const engagementChangeOrdersRelations = relations(
  engagementChangeOrders,
  ({ one, many }) => ({
    engagement: one(engagements, {
      fields: [engagementChangeOrders.engagementId],
      references: [engagements.id],
    }),
    lines: many(engagementChangeOrderLines),
    // ⚠ Hydrate actors with an explicit `columns:` projection — a bare `requestedBy: true`
    // pulls `workos_id` and the full PII row.
    requestedBy: one(users, {
      fields: [engagementChangeOrders.requestedByUserId],
      references: [users.id],
    }),
    sentBy: one(users, {
      fields: [engagementChangeOrders.sentByUserId],
      references: [users.id],
    }),
    decidedBy: one(users, {
      fields: [engagementChangeOrders.decidedByUserId],
      references: [users.id],
    }),
    withdrawnBy: one(users, {
      fields: [engagementChangeOrders.withdrawnByUserId],
      references: [users.id],
    }),
  })
);

export const engagementChangeOrderLinesRelations = relations(
  engagementChangeOrderLines,
  ({ one }) => ({
    changeOrder: one(engagementChangeOrders, {
      fields: [engagementChangeOrderLines.changeOrderId],
      references: [engagementChangeOrders.id],
    }),
    milestone: one(engagementMilestones, {
      fields: [engagementChangeOrderLines.engagementMilestoneId],
      references: [engagementMilestones.id],
    }),
  })
);

// ── Type exports ───────────────────────────────────────────────────────

export type EngagementChangeOrder = typeof engagementChangeOrders.$inferSelect;
export type NewEngagementChangeOrder = typeof engagementChangeOrders.$inferInsert;
export type EngagementChangeOrderLine = typeof engagementChangeOrderLines.$inferSelect;
export type NewEngagementChangeOrderLine = typeof engagementChangeOrderLines.$inferInsert;
