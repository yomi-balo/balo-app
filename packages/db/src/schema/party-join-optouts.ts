import { pgTable, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partyTypeEnum } from './enums';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * party_join_optouts (BAL-345 / ADR-1031) — a durable per-user "engine, do NOT
 * auto-join / auto-request me into this party" marker. Written by the escape
 * hatch when a user rejects a domain-driven join; the match engine short-circuits
 * (`opted_out`) whenever a LIVE opt-out row exists for a (party, user).
 *
 * A TABLE (not a boolean on membership) because it must decouple the engine's
 * short-circuit from the membership/request lifecycle (the auto path soft-deletes
 * a membership, the request path withdraws a request — two different shapes), it
 * is explicit and auditable, and it is forward-compatible with a future re-match
 * sweep. An opt-out only blocks the engine's AUTOMATIC paths; a future explicit
 * user-initiated join is out of scope.
 *
 * `partyId` is POLYMORPHIC (companies.id OR agencies.id by partyType), app-side
 * integrity (mirror party_domains). `userId` = the opting-out subject AND actor
 * (self-opt-out only in v1); userId + createdAt is the full attribution. CASCADE
 * keeps `delete-user.ts`'s final `tx.delete(users)` clean with no new phase.
 */
export const partyJoinOptouts = pgTable(
  'party_join_optouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // POLYMORPHIC party ref — companies.id OR agencies.id by partyType.
    partyType: partyTypeEnum('party_type').notNull(),
    partyId: uuid('party_id').notNull(),

    // The opting-out user (subject AND actor in v1).
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // ≤1 LIVE opt-out per (party, user). PARTIAL on `deleted_at IS NULL`; the
    // repo's ON CONFLICT arbiter restates this predicate EXACTLY (idempotent).
    uniqueIndex('party_join_optouts_unique_idx')
      .on(t.partyType, t.partyId, t.userId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('party_join_optouts_user_idx').on(t.userId),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type PartyJoinOptout = typeof partyJoinOptouts.$inferSelect;
export type NewPartyJoinOptout = typeof partyJoinOptouts.$inferInsert;
