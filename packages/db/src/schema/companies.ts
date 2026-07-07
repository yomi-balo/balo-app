import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  companyRoleEnum,
  domainJoinModeEnum,
  membershipAuthorityEnum,
  joinMethodEnum,
} from './enums';
import { users } from './users';
import { timestamps, softDelete } from './helpers';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),

  name: text('name').notNull(),
  slug: text('slug').unique(),
  logoUrl: text('logo_url'),
  domain: text('domain'),

  isPersonal: boolean('is_personal').default(true).notNull(),

  creditBalance: integer('credit_balance').default(0).notNull(),
  stripeCustomerId: text('stripe_customer_id'),

  // BAL-345: domain auto-join governance. `domainJoinMode` = auto | request | off;
  // `membershipAuthority` = balo (the engine governs) | directory (engine stands
  // down). NOT NULL + DEFAULT → existing rows backfill to 'auto'/'balo' in one
  // statement (PG fast-path, no rewrite).
  domainJoinMode: domainJoinModeEnum('domain_join_mode').notNull().default('auto'),
  membershipAuthority: membershipAuthorityEnum('membership_authority').notNull().default('balo'),

  ...timestamps,
});

export const companyMembers = pgTable(
  'company_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .references(() => companies.id)
      .notNull(),
    // BAL-345: the global `.unique()` on userId was DROPPED (removes constraint
    // `company_members_user_id_unique`). A user may now hold more than one live
    // membership (e.g. their personal workspace + a domain-matched shared org). The
    // partial composite unique index below (deleted_at IS NULL) enforces "≤1 LIVE
    // membership per (company, user)".
    userId: uuid('user_id')
      .references(() => users.id)
      .notNull(),

    role: companyRoleEnum('role').notNull().default('member'),

    // BAL-345: how this membership originated. Default 'personal_workspace'
    // backfills every existing row (the only current writer is
    // createWithWorkspace, which always creates a personal-workspace owner).
    joinMethod: joinMethodEnum('join_method').notNull().default('personal_workspace'),

    invitedById: uuid('invited_by_id').references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),

    // BAL-345: soft-delete + attribution (ADR-1030 actor+timestamp pairing). The
    // escape hatch soft-removes a domain_match membership rather than hard-deleting.
    // `deletedByUserId` RESTRICT mirrors party_domains — the deleting actor is never
    // hard-removed.
    ...softDelete,
    // ON DELETE RESTRICT (not CASCADE/SET NULL). Safe in v1 ONLY because the escape
    // hatch is SELF-removal (deletedByUserId === the row's own userId), so on a
    // user hard-delete this column cascades away WITH the user. The first
    // ADMIN-removal path (a different actor as deleter) will require a delete-user
    // anonymization/null phase for this column before RESTRICT can be honoured.
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => ({
    // PARTIAL on `deleted_at IS NULL` (BAL-345): "≤1 LIVE membership per
    // (company, user)". A soft-removed membership frees the slot so a later
    // re-join can INSERT ... ON CONFLICT DO NOTHING against this exact predicate.
    // Load-bearing — a non-partial unique would break re-create after soft-delete.
    companyUserIdx: uniqueIndex('company_user_idx')
      .on(table.companyId, table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
  })
);

// Relations
export const companiesRelations = relations(companies, ({ many }) => ({
  members: many(companyMembers),
}));

export const companyMembersRelations = relations(companyMembers, ({ one }) => ({
  company: one(companies, {
    fields: [companyMembers.companyId],
    references: [companies.id],
  }),
  user: one(users, {
    fields: [companyMembers.userId],
    references: [users.id],
  }),
}));

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type CompanyMember = typeof companyMembers.$inferSelect;
