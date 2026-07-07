import { pgTable, uuid, text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { partyTypeEnum, partyDomainSourceEnum } from './enums';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

/**
 * party_domains (BAL-344 / ADR-1031) — the registry that maps a corporate email
 * domain to the party (company or agency) that owns it. Balo owns this mapping;
 * WorkOS never decides org membership. Populated by auto-capture of a party
 * creator's verified corporate domain, and (future) by an admin path.
 *
 * `partyId` is POLYMORPHIC — it points at `companies.id` OR `agencies.id`
 * selected by `partyType`. No SQL foreign key is possible with two targets;
 * integrity is enforced app-side (the capture caller passes a real `company.id`
 * from the SAME transaction). Documented tradeoff.
 *
 * `domain` is stored LOWERCASED/normalised by the repo (via @balo/shared/domains)
 * before insert — @balo/db never normalises here; the partial unique index
 * matches the already-canonical value (mirrors `expert_referral_invites.email`).
 *
 * `createdByUserId` RESTRICT (preserve capture attribution); `deletedByUserId`
 * nullable + RESTRICT (records who soft-deleted the mapping without ever
 * hard-removing that actor).
 */
export const partyDomains = pgTable(
  'party_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // POLYMORPHIC party ref — points at companies.id OR agencies.id by partyType.
    // No SQL FK is possible (two targets); integrity is enforced app-side (the
    // capture caller passes a real company.id from the same tx). Documented tradeoff.
    partyType: partyTypeEnum('party_type').notNull(),
    partyId: uuid('party_id').notNull(),

    // Registered domain, stored LOWERCASED by the caller/repo (this layer's repo
    // normalises via @balo/shared/domains before insert; the partial unique index
    // matches the already-canonical value — mirrors expert_referral_invites.email).
    domain: text('domain').notNull(),

    // How the row was created. NO default — every writer states it explicitly
    // ('auto_captured' here; 'admin_added' from the future admin path). Avoids any
    // enum-default cast hazard.
    source: partyDomainSourceEnum('source').notNull(),

    // Attribution (mirror project_requests.createdByUserId — restrict to preserve).
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Net-new actor column (no precedent): who soft-deleted this mapping. NULLABLE
    // (unset while live); restrict so the deleting actor is never hard-removed.
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // ONE live party may own a domain PLATFORM-WIDE. PARTIAL on `deleted_at IS NULL`
    // (mirrors `expert_referral_invite_unique_idx`) so a soft-deleted mapping frees
    // the slot for re-capture; the repo's ON CONFLICT arbiter restates this
    // predicate EXACTLY. Load-bearing — a non-partial unique would silently break
    // re-create after soft-delete.
    uniqueIndex('party_domains_domain_unique_idx')
      .on(t.domain)
      .where(sql`${t.deletedAt} IS NULL`),
    // Reverse lookup for BAL-345 ("all domains for this party") + party joins.
    index('party_domains_party_idx').on(t.partyType, t.partyId),
    index('party_domains_created_by_idx').on(t.createdByUserId),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const partyDomainsRelations = relations(partyDomains, ({ one }) => ({
  createdByUser: one(users, {
    fields: [partyDomains.createdByUserId],
    references: [users.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type PartyDomain = typeof partyDomains.$inferSelect;
export type NewPartyDomain = typeof partyDomains.$inferInsert;
export type PartyType = (typeof partyTypeEnum.enumValues)[number];
export type PartyDomainSource = (typeof partyDomainSourceEnum.enumValues)[number];
