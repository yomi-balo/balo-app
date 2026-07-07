import { pgTable, uuid, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partyTypeEnum, partyJoinRequestStatusEnum } from './enums';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * party_join_requests (BAL-345 / ADR-1031) — a pending "let me into this party"
 * request filed by the domain-match engine when the owning party's
 * `domainJoinMode = 'request'`. An admin (owner/admin — `MANAGE_MEMBERS`)
 * approves (materialising a `company_members`/`agency_members` row via
 * `findOrCreateDomainMembership`) or declines; the requester may withdraw.
 *
 * `partyId` is POLYMORPHIC (points at `companies.id` OR `agencies.id` by
 * `partyType`) — no SQL FK is possible with two targets; integrity is enforced
 * app-side, mirroring `party_domains`.
 *
 * FK onDelete rationale: `userId` = the requester AND the "who requested"
 * attribution (paired with `createdAt`); CASCADE so a hard-deleted requester
 * cleans up their own rows (no separate `requestedByUserId` — that would be
 * redundant and, as RESTRICT, would block the requester's own delete).
 * `resolvedByUserId` (the admin who resolved) is nullable + SET NULL: deleting an
 * admin who once resolved a request must NOT delete the requester's row nor be
 * blocked — the immutable `audit_events` ledger already records the actor.
 */
export const partyJoinRequests = pgTable(
  'party_join_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // POLYMORPHIC party ref — points at companies.id OR agencies.id by partyType.
    partyType: partyTypeEnum('party_type').notNull(),
    partyId: uuid('party_id').notNull(),

    // The requester (and the "who requested" attribution, paired with createdAt).
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    status: partyJoinRequestStatusEnum('status').notNull().default('pending'),

    // Resolution attribution (ADR-1030 actor+timestamp pairing): the admin who
    // resolved + when. SET NULL / nullable — see the FK rationale above.
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    ...timestamps,
    // deletedAt only — nothing soft-deletes requests in v1 (lifecycle is
    // status-driven). Kept for the CLAUDE.md convention + TTL compatibility. No
    // deletedByUserId (no soft-delete actor in v1; avoids a 3rd RESTRICT FK).
    ...softDelete,
  },
  (t) => [
    // ≤1 LIVE PENDING request per (party, user). The predicate MUST include
    // `deleted_at IS NULL` so a soft-deleted pending row does not wedge the slot;
    // the repo's ON CONFLICT arbiter restates this predicate EXACTLY.
    uniqueIndex('party_join_requests_pending_unique_idx')
      .on(t.partyType, t.partyId, t.userId)
      .where(sql`${t.status} = 'pending' AND ${t.deletedAt} IS NULL`),
    index('party_join_requests_party_idx').on(t.partyType, t.partyId),
    index('party_join_requests_user_idx').on(t.userId),
  ]
);

// ── Type exports ───────────────────────────────────────────────────────

export type PartyJoinRequest = typeof partyJoinRequests.$inferSelect;
export type NewPartyJoinRequest = typeof partyJoinRequests.$inferInsert;
export type PartyJoinRequestStatus = (typeof partyJoinRequestStatusEnum.enumValues)[number];
