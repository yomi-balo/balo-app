import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import type { Capability } from '@balo/shared/authz';
import { representationScopeEnum, representationStatusEnum } from './enums';
import { users } from './users';
import { companies } from './companies';
import { projectRequests } from './project-requests';
import { timestamps, softDelete } from './helpers';

/**
 * `representations` (BAL-313 / ADR-1028 Phase 1) — ONE act-on-behalf grant: "user A may act
 * for company B, carrying capability set C, until D", at either ORG grain or the grain of ONE
 * project request.
 *
 * ── IT SHIPS INERT. NOTHING READS OR WRITES IT IN THIS PR ─────────────────────────────
 * There is no UI, no Server Action, no API route and no notification. `hasCapability`
 * (`apps/web/src/lib/authz/index.ts`) is UNTOUCHED and still answers on membership alone —
 * wiring role ∪ representation is BAL-314's scope, and so is the grant surface itself.
 * (Precedent for a deliberately inert data seam: BAL-420, BAL-387, BAL-391.)
 *
 * ── AUTHORIZATION IS THE CALLER'S (ADR-1029) ──────────────────────────────────────────
 * Nothing here decides WHO MAY GRANT. The repository enforces only the capability SUBSET
 * (`REPRESENTABLE_CAPABILITIES`); the no-escalation rule — *a granter may grant only
 * capabilities they themselves hold* — belongs at the call site and is BAL-314's. No new
 * platform capability token is added by this ticket, and `authz/platform.ts` is untouched.
 *
 * ── `deleted_at` HAS NO WRITER IN v1 ──────────────────────────────────────────────────
 * It exists per the `softDelete` house convention, is filtered by EVERY read AND by both
 * partial uniques, and is reserved for an admin hard-scrub path. ⚠ REVOKE IS A `status`
 * TRANSITION, NOT A SOFT DELETE — `revoke()` sets `status='revoked'` + `revoked_at` +
 * `revoked_by_user_id` and writes NO `deleted_at`. Do not assume otherwise.
 *
 * ── `status = 'active'` IN AN INDEX PREDICATE IS A DELIBERATE DEVIATION ────────────────
 * `action-items.ts` states the house rule "predicate on a column, never an enum literal".
 * `reschedule_proposal_one_pending_idx` is the precedent for breaking it, and the reason is
 * the same: the slot must be freed when the grant ends, or one grant would occupy an
 * (actor, company) pair for its entire life. FORWARD CONSTRAINT: a future
 * `ALTER TYPE representation_status ADD VALUE` must NOT *use* the new value in the same
 * migration (memory `reference_enum_default_same_tx_migration_hazard`). Creating the type and
 * using its literals in the SAME migration — what this table's migration does — is safe;
 * `check_safe_enum_use` only blocks values added to a PRE-EXISTING type.
 *
 * ── DEVIATION FROM ADR-1029, TO BE RECORDED BY AMENDMENT ──────────────────────────────
 * ADR-1029 specifies `representative_user_id` / `represented_company_id`, a
 * `representation_role_enum` (`ae` | `account_manager`) resolving to a bundle, and a
 * `representation_requests` pivot. This ships BAL-313's naming, EXPLICIT CAPABILITIES (a
 * role→bundle would hand an AE `consume_credits`, which sits in `MEMBER_BUNDLE`) and NO PIVOT
 * (a pivot makes uniqueness span two tables and cannot express the "no duplicate active
 * grants" AC). Plus the `'expired'` status label. Flag in the PR body as needing an ADR-1029
 * amendment — do not ship a third shape unremarked.
 *
 * NO RLS — matching every existing schema file: NOT ONE of them CALLS `.enableRLS()` or
 * `pgPolicy()` (`stripe-webhook-events.ts` mentions `.enableRLS()` in prose only, saying the
 * same thing this paragraph does — so a bare `grep -l` matches it; a grep for the CALL does
 * not). Balo authenticates with WorkOS + iron-session, so `auth.uid()` is meaningless here,
 * every reader is the admin `db` client (which bypasses RLS anyway), and the boundary is the
 * application layer (ADR-1029 / ADR-1040 Decision 4). ⚠ This is a conscious deviation from
 * the `drizzle-schema` skill, which lists "Forgetting RLS on new tables" under What NOT to Do
 * — flagged in the PR body. Inventing the codebase's first policy on an inert table would be
 * the larger error.
 */
export const representations = pgTable(
  'representations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * WHO acts. ATTRIBUTION — `restrict`, the dominant `users` reference in this schema
     * (36 restrict / 6 cascade / 3 set null) and the ADR-1030 rule that
     * `project_requests.created_by_user_id` and `reschedule_proposals.proposed_by_user_id`
     * already follow. Intended consequence: a user who ever HELD a grant cannot be
     * hard-deleted until the row is scrubbed.
     */
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /**
     * WHOSE work they act on. `cascade` — a representation is a LIVE AUTHORIZATION, not a
     * money or audit record, so it must not outlive the company it points at.
     * ⚠ NOT the `companies.parent_company_id` "no onDelete" shape: that line is a
     * SELF-reference, not the pattern for referring to a company. The real population of
     * `references(() => companies.id, …)` is 4 cascade (`company-billing`, `credit-wallets`,
     * `engagements`, `project-requests`) / 4 restrict (money + audit rows that must survive)
     * / 1 none (the self-ref). NO ACTION here would make a company hard-delete fail `23503`
     * from a table nobody knows exists.
     */
    onBehalfOfCompanyId: uuid('on_behalf_of_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** ORG-wide or ONE request. NO DEFAULT — the grain is always an explicit decision. */
    scope: representationScopeEnum('scope').notNull(),

    /**
     * The single request a `scope='request'` grant is confined to; NULL for `scope='org'`.
     * Paired with `scope` by `representation_scope_request_paired`, so the two can never
     * disagree.
     *
     * ⚠ NO INLINE `.references(...)` — THE FK IS THE COMPOSITE `representation_request_company_fk`
     * DECLARED BELOW, and it is a TENANCY constraint, not merely an existence one. A
     * single-column FK to `project_requests(id)` proves the request EXISTS and nothing about
     * WHOSE it is, so a grant could name company X while pointing at company Y's request —
     * cross-tenant escalation, and `representation_project_request_idx` ("who may act on this
     * request?") would hand that foreign representative back. Read that comment for the
     * MATCH SIMPLE semantics that make the org grain skip the constraint entirely.
     *
     * `cascade` on that FK, and `set null` (the `project_engagements` choice) is STRUCTURALLY
     * FORBIDDEN here: it would leave a `scope='request'` row with a NULL request and violate
     * that CHECK at delete time. All six other child references to `project_requests` cascade.
     */
    projectRequestId: uuid('project_request_id'),

    /**
     * The EXPLICIT capability set this grant carries — never a role that resolves to a
     * bundle. `jsonb` because there is no PG array column anywhere in this schema and every
     * list-valued column is jsonb — the precedent is `transcripts.extractedActionItems`
     * (`schema/transcripts.ts:133`, `jsonb(...).$type<ExtractedActionItem[]>()`). ⚠ NOT
     * `audit-events.metadata` / `payouts.form_values`: both are `$type<Record<string, …>>`,
     * i.e. OBJECT-valued, and prove nothing about a jsonb ARRAY.
     *
     * ⚠ `$type<Capability[]>()` IS A COMPILE-TIME CLAIM POSTGRES DOES NOT ENFORCE (memory
     * `reference_jsonb_date_type_lie`). The CHECK below pins only "a non-empty array"; the
     * ALLOWLIST (`REPRESENTABLE_CAPABILITIES`) is enforced by the repository on the write
     * path AND re-filtered on the read path, because a row can also arrive by script or hand
     * edit, and narrowing the allowlist later must take effect immediately rather than
     * waiting for a backfill.
     */
    capabilities: jsonb('capabilities').$type<Capability[]>().notNull(),

    /** WHO issued it. ATTRIBUTION — `restrict`, same reasoning as `actor_user_id`. */
    grantedByUserId: uuid('granted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    status: representationStatusEnum('status').notNull().default('active'),

    /**
     * NULL ⇒ no expiry. When set, the grant lapses AT this instant (`gt`, not `gte`).
     *
     * ⚠ EXPIRY IS LAZY AND THE COLUMN REPORTS RATHER THAN ENFORCES. A lapsed row keeps
     * `status='active'` until the next `grant()` for the same subject sweeps it — the READ
     * predicate in `repositories/representations.ts` is what refuses it. Nothing sweeps this
     * table on a schedule; there is no job.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /** When a human ended it. Paired with `status='revoked'` by CHECK. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    /**
     * WHO ended it. `set null`, mirroring `reschedule_proposals.resolved_by_user_id`: the
     * revocation FACT (`revoked_at` + `status`) survives the revoker's hard deletion.
     * ⚠ It is therefore NOT a reliable audit column for a deleted user; `revoked_at` +
     * `status` are. NULL for `expired` — nobody acted (ADR-1030's system-actor attribution
     * exemption: an unattributed row, never a fabricated actor).
     */
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * ⚠ THE ANSWER TO "CAN ONE ACTOR HOLD TWO ACTIVE GRANTS FOR ONE COMPANY?" — NO, ONCE PER
     * GRAIN. TWO indexes, because a single one cannot express "one row per (a, b) when c IS
     * NULL, and one row per (a, b, c) otherwise": in Postgres a UNIQUE index treats every
     * NULL as distinct, so `(a, b, c)` alone would permit unlimited org grants.
     *
     * Both halves of each predicate are load-bearing:
     *  · `deleted_at IS NULL` — the hard-learned house convention (memory
     *    `reference_softdelete_nonpartial_unique_recreate`): soft-delete plus a NON-partial
     *    unique makes any re-create fail SILENTLY.
     *  · `status = 'active'` — without it one grant would occupy the slot for the table's
     *    lifetime; revoke it and the actor could never be granted again.
     *
     * ⚠ THEY CANNOT KNOW ABOUT EXPIRY — `now()` is not IMMUTABLE and may not appear in an
     * index predicate — so a LAPSED grant still occupies its slot. The gap is closed at the
     * WRITE path: `representationsRepository.grant` runs `expireLapsedForSubject` as the
     * FIRST statement of its transaction. Without it, re-granting after an expiry is
     * impossible forever.
     *
     * ⚠ NO `ON CONFLICT` ANYWHERE AGAINST THESE INDEXES. `grant()` is expire-then-INSERT,
     * with the `23505` contained by a nested-transaction SAVEPOINT. An arbiter naming a
     * PARTIAL index needs the enum literal INLINED via raw `sql`; a Drizzle `eq()` emits a
     * bind parameter Postgres's predicate-implication prover can never match, failing
     * `42P10` at runtime with typecheck green (memory
     * `reference_pg_partial_index_arbiter_param_42p10`).
     */
    uniqueIndex('representation_active_org_idx')
      .on(t.actorUserId, t.onBehalfOfCompanyId)
      .where(
        sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL AND ${t.projectRequestId} IS NULL`
      ),
    uniqueIndex('representation_active_request_idx')
      .on(t.actorUserId, t.onBehalfOfCompanyId, t.projectRequestId)
      .where(
        sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL AND ${t.projectRequestId} IS NOT NULL`
      ),

    // ── The ticket's AC read paths. ────────────────────────────────────
    /** "Which companies may I act for?" — `findActiveForActor`. */
    index('representation_actor_idx')
      .on(t.actorUserId)
      .where(sql`${t.deletedAt} IS NULL`),
    /** "Who may act for us?" — the company-side administration read (BAL-314). */
    index('representation_company_idx')
      .on(t.onBehalfOfCompanyId)
      .where(sql`${t.deletedAt} IS NULL`),
    /** "Who may act on this request?" — the request-grain read. */
    index('representation_project_request_idx')
      .on(t.projectRequestId)
      .where(sql`${t.deletedAt} IS NULL`),

    /**
     * The FK delete-time scans, on the `reschedule_proposal_proposed_by_idx` reasoning: users
     * really are hard-deleted (`admin-dev/_actions/delete-user.ts`), `restrict` makes the
     * delete FAIL and `set null` makes it WRITE — either way Postgres scans this table.
     * ⚠ NOT partial on `deleted_at`: a soft-deleted row still holds the FK.
     */
    index('representation_granted_by_idx').on(t.grantedByUserId),
    index('representation_revoked_by_idx').on(t.revokedByUserId),

    /**
     * ⚠ THE TENANCY FK — A REQUEST-GRAIN GRANT CANNOT NAME ANOTHER COMPANY'S REQUEST.
     * COMPOSITE, and that is the whole point: a single-column FK to `project_requests(id)`
     * proves only that the request EXISTS. Nothing else in this table ties
     * `project_request_id` to `on_behalf_of_company_id` — `representation_scope_request_paired`
     * pairs `scope` with the column's PRESENCE, not its OWNER — so
     * `{ onBehalfOfCompanyId: X, scope: 'request', projectRequestId: <Y's request> }` would be
     * accepted, and `representation_project_request_idx` (the BAL-314 "who may act on this
     * request?" read) would return a representative from a DIFFERENT tenant. Postgres decides
     * this, not a repository read, because a read-time check races and a hand-written row or a
     * seed bypasses it entirely.
     *
     * ⚠ MATCH SIMPLE IS WHAT MAKES ONE FK SERVE BOTH GRAINS, AND IT IS SUBTLE. Postgres's
     * default match type for a composite FK is MATCH SIMPLE: if ANY referencing column is
     * NULL the constraint is NOT ENFORCED AT ALL. `on_behalf_of_company_id` is NOT NULL, so
     * the only nullable half is `project_request_id`:
     *   · ORG grain (`project_request_id IS NULL`) — skipped entirely, exactly as wanted; an
     *     org grant references no request and must not be forced to.
     *   · REQUEST grain (both non-NULL) — fully checked against `(id, company_id)`.
     * Do NOT "tighten" this to MATCH FULL: that would reject every org-grain row.
     *
     * The referenced pair is backed by `project_request_id_company_uq` (project-requests.ts) —
     * Postgres requires a UNIQUE CONSTRAINT on the referenced columns, and a `uniqueIndex`
     * will not do. `onDelete: 'cascade'` preserves the previous behaviour (a deleted request
     * takes its grants with it). `onUpdate` stays `no action` DELIBERATELY: a
     * `project_requests.company_id` change under a live grant must be BLOCKED, not silently
     * followed into another tenant.
     */
    foreignKey({
      columns: [t.projectRequestId, t.onBehalfOfCompanyId],
      foreignColumns: [projectRequests.id, projectRequests.companyId],
      name: 'representation_request_company_fk',
    }).onDelete('cascade'),

    /**
     * THE GRAIN BICONDITIONAL — `scope` and `project_request_id` say the same thing or the
     * write is refused.
     *
     * NO THREE-VALUED-LOGIC HOLE (the `reschedule_proposal_resolution_paired` argument):
     * `scope` is NOT NULL and `'request'` is a literal ⇒ the LHS is never NULL; `IS NOT NULL`
     * is total ⇒ the RHS is never NULL. boolean = boolean over two non-NULL operands yields
     * TRUE or FALSE and can never "pass by being unknown".
     */
    check(
      'representation_scope_request_paired',
      sql`(${t.scope} = 'request') = (${t.projectRequestId} IS NOT NULL)`
    ),

    /** A revoked grant has a revocation time, and only a revoked grant has one. Total. */
    check(
      'representation_revocation_paired',
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`
    ),

    /**
     * A revoker implies a revocation. One-directional on purpose — `revoked_by_user_id` is
     * `set null`, so a revoked row whose revoker was hard-deleted must stay legal.
     */
    check(
      'representation_revoker_implies_revoked',
      sql`${t.revokedByUserId} IS NULL OR ${t.status} = 'revoked'`
    ),

    /** `expired` is only reachable for a grant that had an expiry to lapse past. Total. */
    check(
      'representation_expired_requires_expiry',
      sql`${t.status} <> 'expired' OR ${t.expiresAt} IS NOT NULL`
    ),

    /**
     * A GRANT OF NOTHING IS NOT A GRANT — structural, not merely validated in the repository.
     *
     * ⚠ TWO TOTAL OPERATORS ONLY. `jsonb_array_length` would ERROR (`22023`) rather than fail
     * `23514` on a non-array value, and SQL does not guarantee AND short-circuits, so the
     * type test cannot be relied on to guard a length call. `jsonb_typeof` and `<>` are both
     * total over any jsonb value.
     */
    check(
      'representation_capabilities_nonempty',
      sql`jsonb_typeof(${t.capabilities}) = 'array' AND ${t.capabilities} <> '[]'::jsonb`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const representationsRelations = relations(representations, ({ one }) => ({
  actor: one(users, {
    fields: [representations.actorUserId],
    references: [users.id],
  }),
  grantedBy: one(users, {
    fields: [representations.grantedByUserId],
    references: [users.id],
  }),
  revokedBy: one(users, {
    fields: [representations.revokedByUserId],
    references: [users.id],
  }),
  onBehalfOfCompany: one(companies, {
    fields: [representations.onBehalfOfCompanyId],
    references: [companies.id],
  }),
  projectRequest: one(projectRequests, {
    fields: [representations.projectRequestId],
    references: [projectRequests.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type Representation = typeof representations.$inferSelect;
export type NewRepresentation = typeof representations.$inferInsert;

/** The grant grain (schema-derived — single source of truth). */
export type RepresentationScope = (typeof representationScopeEnum.enumValues)[number];
/** The grant lifecycle (schema-derived — single source of truth). */
export type RepresentationStatus = (typeof representationStatusEnum.enumValues)[number];
