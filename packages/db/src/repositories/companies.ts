import { eq, and, asc, inArray, isNull } from 'drizzle-orm';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { db } from '../client';
import { companies, companyMembers, type Company, type User } from '../schema';
import { auditEventsRepository } from './audit-events';
import { partyDomainsRepository } from './party-domains';
import { partyMembershipsRepository } from './party-memberships';

/**
 * Outcome of a join-mode write (BAL-347). `changed` is false when the requested mode
 * already matches (no write, no audit, no analytics) — the caller skips the emit.
 */
export interface SetJoinModeResult {
  previous: Company['domainJoinMode'];
  next: Company['domainJoinMode'];
  changed: boolean;
}

/**
 * BAL-369 / ADR-1038 — input for `promoteToOrganization`. `name` is pre-validated by
 * `companyNameSchema` in the caller; `domain` is caller-extracted via
 * `extractEmailDomain` (already normalised — the repo re-normalises defensively via
 * `capture`).
 */
export interface PromoteToOrganizationInput {
  companyId: string;
  name: string;
  domain: string;
  actorUserId: string;
}

/**
 * BAL-494 — the PROJECTED batch company read used to hydrate workspace entries.
 * Exactly the three fields a workspace needs; deliberately no `logoUrl` (the
 * workspace list is sealed into the ~4 KB `balo_session` cookie), and never the
 * billing columns.
 */
export interface CompanySummary {
  id: string;
  name: string;
  isPersonal: boolean;
}

/**
 * BAL-522 — the BILLING-IDENTITY projection of ONE company. See
 * {@link companiesRepository.findBillingIdentityById} for why it is a third projection on this
 * table rather than a widening of either existing one.
 */
export interface CompanyBillingIdentity {
  id: string;
  /** → `customers.update({ name })`. */
  name: string;
  /** → the `company_is_personal` property on both analytics events. */
  isPersonal: boolean;
  /** NULL ⇒ the seed condition is met. → `customers.update({ email })`. */
  billingEmail: string | null;
  /** → the provenance line's verb, and `previous_source` on `billing_email_updated`. */
  billingEmailSource: 'seeded' | 'set' | null;
  /** → the provenance line's attributed person + their membership-liveness lookup. */
  billingEmailSetByUserId: string | null;
  /** → the provenance line's date, and `days_since_set` on `billing_email_updated`. */
  billingEmailSetAt: Date | null;
}

/** BAL-522 — input for the first-purchase seed of `companies.billing_email`. */
export interface SeedBillingEmailInput {
  companyId: string;
  /** The actor's own account email, already resolved by the caller. */
  email: string;
  actorUserId: string;
}

/**
 * BAL-522 — total and explicit: every non-throwing outcome names the EFFECTIVE billing email,
 * so the caller's Stripe identity sync always knows what address (if any) to carry.
 */
export type SeedBillingEmailResult =
  | { seeded: true; billingEmail: string; auditEventId: string }
  | { seeded: false; reason: 'already_set'; billingEmail: string }
  | { seeded: false; reason: 'no_capability'; billingEmail: null }
  | { seeded: false; reason: 'company_not_found'; billingEmail: null };

/** BAL-522 — input for an explicit billing-email change from /settings/billing. */
export interface SetBillingEmailInput {
  companyId: string;
  /** Pre-validated by the route's zod schema (trimmed, non-empty, RFC-shaped, ≤254). */
  billingEmail: string;
  actorUserId: string;
}

/**
 * BAL-522 — the outcome of an explicit billing-email change. `unchanged` is the
 * `setDomainJoinMode` no-op posture (no write, no audit, no notification, no analytics);
 * `forbidden` is the TRANSACTIONAL capability gate, distinct from the route's own 403.
 */
export type SetBillingEmailResult =
  | {
      outcome: 'changed';
      company: { name: string; isPersonal: boolean };
      billingEmail: string;
      setAt: Date;
      previousEmail: string | null;
      previousSource: 'seeded' | 'set' | null;
      previousSetAt: Date | null;
      auditEventId: string;
    }
  | {
      outcome: 'unchanged';
      company: { name: string; isPersonal: boolean };
      billingEmail: string;
      setAt: Date | null;
    }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' };

/**
 * Discriminated result — no thrown control-flow error (deviates deliberately from the
 * agency axis's `AgencyDomainCaptureConflictError`, see the note on the method):
 *  - 'promoted'                    → company flipped to a typed org + domain claimed
 *  - 'domain_conflict_same_type'   → another live COMPANY owns the domain → caller stays
 *                                    PERSONAL (non-blocked); the live owner keeps the domain.
 *                                    Retry is futile (that owner never disappears), so this is
 *                                    NOT retryable — the paths back are JOIN or admin
 *                                    reassignment (BAL-347 removeDomain+addDomain).
 *  - 'domain_conflict_other_type'  → a live AGENCY owns the domain → caller stays personal.
 *  - 'domain_conflict_retryable'   → transient race: the slot was freed mid-op (concurrent
 *                                    soft-delete), so a retry legitimately re-attempts the claim.
 */
export type PromoteToOrganizationResult =
  | { outcome: 'promoted'; company: Company }
  | { outcome: 'domain_conflict_same_type' }
  | { outcome: 'domain_conflict_other_type' }
  | { outcome: 'domain_conflict_retryable' };

export const companiesRepository = {
  findById: async (id: string): Promise<Company | undefined> => {
    return db.query.companies.findFirst({
      where: eq(companies.id, id),
    });
  },

  /**
   * DISPLAY-ONLY hydration of ONE company (BAL-388) — `id` + `name`, and nothing else.
   * `findById` returns the whole row (billing details, domain, join mode), which has no place
   * on a counterparty-facing render path. Same posture as `usersRepository.findDisplayById`.
   */
  findNameById: async (id: string): Promise<{ id: string; name: string } | undefined> => {
    const [row] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, id))
      .limit(1);
    return row;
  },

  /**
   * BAL-494 — BATCH projected hydration of `id` / `name` / `isPersonal` for a set of
   * company ids. The batch counterpart of {@link companiesRepository.findNameById}
   * (there is no other batch company read today), added for the workspace derivation's
   * representation arm, which knows only company ids.
   *
   * ⚠ EXPLICIT PROJECTION ONLY — never a full row. The result is destined for the
   * `balo_session` cookie, and `findById` would carry `billingEmail`, `domain` and the
   * join-mode governance columns with it (the shape of memory
   * `reference_drizzle_with_hydration_leaks_secrets`). Concealment is enforced by what the
   * row CAN hold, not by remembering to omit downstream.
   *
   * Empty input short-circuits to `[]` WITHOUT touching the DB — an empty `inArray` is a
   * SQL error, and this is the steady-state case in production (BAL-313 shipped
   * `representations` with no writer, so the id set is always empty today).
   *
   * Unknown ids are simply absent from the result. Ordered `name asc, id asc` so the
   * caller's workspace list is deterministic.
   *
   * NOTE: no `deleted_at` guard — the `companies` table has NO such column (see
   * schema/companies.ts; same note as `updateName` / `promoteToOrganization`). A hard
   * delete is the only removal path this table admits.
   */
  findSummariesByIds: async (ids: readonly string[]): Promise<CompanySummary[]> => {
    if (ids.length === 0) return [];
    return db
      .select({ id: companies.id, name: companies.name, isPersonal: companies.isPersonal })
      .from(companies)
      .where(inArray(companies.id, [...ids]))
      .orderBy(asc(companies.name), asc(companies.id));
  },

  /**
   * BAL-522 — the BILLING-IDENTITY projection of ONE company. The THIRD projection on this
   * table (alongside `findNameById`'s display pair and `findSummariesByIds`' batch triple),
   * deliberately NOT a widening of either: `findNameById` is a counterparty-facing DISPLAY
   * read with 11 callers and a pinned two-key shape, and a billing address has no business
   * on it (`project-engagements.integration.test.ts` pins that shape).
   *
   * Two consumers, one projection: `ensureCustomer` (apps/api — the Stripe identity sync +
   * the seed condition) and `loadBillingSettingsWallet` (apps/web — the settings read).
   *
   * NOTE: no `deleted_at` guard — `companies` has NO such column (see schema/companies.ts,
   * same note as `findSummariesByIds` / `updateName`). A not-found returns `undefined`; that
   * is the only liveness check this table admits.
   */
  findBillingIdentityById: async (id: string): Promise<CompanyBillingIdentity | undefined> => {
    const [row] = await db
      .select({
        id: companies.id,
        name: companies.name,
        isPersonal: companies.isPersonal,
        billingEmail: companies.billingEmail,
        billingEmailSource: companies.billingEmailSource,
        billingEmailSetByUserId: companies.billingEmailSetByUserId,
        billingEmailSetAt: companies.billingEmailSetAt,
      })
      .from(companies)
      .where(eq(companies.id, id))
      .limit(1);
    return row;
  },

  findBySlug: async (slug: string): Promise<Company | undefined> => {
    return db.query.companies.findFirst({
      where: eq(companies.slug, slug),
    });
  },

  findWithMembers: async (id: string) => {
    return db.query.companies.findFirst({
      where: eq(companies.id, id),
      with: {
        members: {
          with: { user: true },
        },
      },
    });
  },

  /**
   * Get user's company (for session).
   *
   * BAL-345: with the global unique on `company_members.userId` dropped a user may
   * hold >1 live membership, so this must exclude soft-removed rows and order
   * deterministically `[role, joinedAt, id]` (native pg enum `role` sorts
   * owner→admin→member, so the personal-workspace owner row wins). NB this method
   * has no live app callers today — the fix is forward-safety/consistency, not the
   * load-bearing seam (that is `usersRepository.findWithCompany`).
   */
  findByUserId: async (userId: string) => {
    const membership = await db.query.companyMembers.findFirst({
      where: and(eq(companyMembers.userId, userId), isNull(companyMembers.deletedAt)),
      orderBy: (members, { asc }) => [asc(members.role), asc(members.joinedAt), asc(members.id)],
      with: { company: true },
    });
    return membership?.company;
  },

  /**
   * The owner user of a company. Ownership is role-based (company_members.role =
   * 'owner'), written at workspace creation. Throws if the company has no owner —
   * a structural invariant violation, so fail loud. Orders by joinedAt (then id) so
   * the result is deterministic — the earliest-joined owner — even if a second
   * owner membership ever exists (nothing at the DB level enforces a single owner,
   * and multi-owner is a v2 concern).
   */
  findOwnerByCompanyId: async (companyId: string): Promise<User> => {
    const membership = await db.query.companyMembers.findFirst({
      // BAL-345: exclude soft-removed owner memberships (a soft-removed owner must
      // not be returned as the live owner).
      where: and(
        eq(companyMembers.companyId, companyId),
        eq(companyMembers.role, 'owner'),
        isNull(companyMembers.deletedAt)
      ),
      orderBy: (members, { asc }) => [asc(members.joinedAt), asc(members.id)],
      with: { user: true },
    });
    if (membership?.user === undefined) {
      throw new Error(`No owner found for company: ${companyId}`);
    }
    return membership.user;
  },

  /**
   * The owner user id of a company, or `undefined` when the company has no live owner
   * (retainer / owner-miss) — the non-throwing variant of `findOwnerByCompanyId` for callers
   * where a missing owner is an expected, non-fatal case (e.g. resolving a notification
   * recipient). A transient DB error still THROWS (so the caller can retry) — a genuine
   * no-owner is never conflated with a failure.
   */
  findOwnerUserIdByCompanyId: async (companyId: string): Promise<string | undefined> => {
    const membership = await db.query.companyMembers.findFirst({
      where: and(
        eq(companyMembers.companyId, companyId),
        eq(companyMembers.role, 'owner'),
        isNull(companyMembers.deletedAt)
      ),
      orderBy: (members, { asc }) => [asc(members.joinedAt), asc(members.id)],
      // Project only the id — avoid hydrating the full user row (PII/secret-leak footgun).
      with: { user: { columns: { id: true } } },
    });
    return membership?.user?.id;
  },

  /**
   * Rename a company (BAL-350 onboarding workspace naming). Bumps `updatedAt`
   * and returns the updated row. Throws if no row matches `id` so the caller
   * surfaces a retryable error instead of a silent no-op.
   *
   * NOTE: the `companies` table has no `deleted_at` column (only
   * `company_members` is soft-deletable — see schema/companies.ts), so there is
   * no soft-delete predicate to apply here; the not-found guard is the only
   * liveness check this table admits. Matches the `setDomainJoinMode` mutation
   * pattern (explicit `updatedAt` bump + `.returning()`).
   *
   * The caller (the onboarding Server Action) owns zod validation of `name`
   * (non-empty after trim, max length); this method assumes a pre-validated,
   * non-empty value and does not trim or re-validate.
   */
  updateName: async (id: string, name: string): Promise<Company> => {
    const [company] = await db
      .update(companies)
      .set({ name, updatedAt: new Date() })
      .where(eq(companies.id, id))
      .returning();
    if (company === undefined) {
      throw new Error(`Company not found: ${id}`);
    }
    return company;
  },

  /**
   * Set a company's domain join mode (BAL-347 admin surface), one tx: lock the row
   * `FOR UPDATE`, no-op when the mode is unchanged (`changed: false` — no write, no
   * audit), otherwise UPDATE + write the `company.join_mode_changed` audit row
   * (metadata `{ from, to }`) in the SAME tx. Throws when the company is missing so
   * the Server Action surfaces a retryable error (companies has NO `deleted_at`, so
   * — like `updateName` — the not-found guard is the only liveness check).
   */
  setDomainJoinMode: async (
    companyId: string,
    next: Company['domainJoinMode'],
    actorUserId: string
  ): Promise<SetJoinModeResult> => {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({ mode: companies.domainJoinMode })
        .from(companies)
        .where(eq(companies.id, companyId))
        .for('update');

      if (current === undefined) {
        throw new Error(`Company not found: ${companyId}`);
      }

      if (current.mode === next) {
        return { previous: current.mode, next, changed: false };
      }

      await tx
        .update(companies)
        .set({ domainJoinMode: next, updatedAt: new Date() })
        .where(eq(companies.id, companyId));

      await auditEventsRepository.record(
        {
          actorUserId,
          action: 'company.join_mode_changed',
          entityType: 'company',
          entityId: companyId,
          metadata: { from: current.mode, to: next },
        },
        tx
      );

      return { previous: current.mode, next, changed: true };
    });
  },

  /**
   * BAL-522 — seed `companies.billing_email` from the FIRST purchaser, at `ensureCustomer`.
   * ONE tx: lock the row `FOR UPDATE`, resolve the actor's capability ON THAT TX, write iff
   * still null, and append the `company.billing_email_seeded` audit row in the SAME tx.
   *
   * ⚠ THE CAPABILITY GATE LIVES HERE, INSIDE THE TRANSACTION (plan D4). It must be atomic
   * with the conditional write — "write iff still null AND the actor still holds
   * MANAGE_BILLING" — and resolved outside the tx it is a TOCTOU gap on a permanent, audited
   * value. `hasCapability` is `apps/web`-only (`import 'server-only'`), so the spelling here
   * is the documented api-side one: `getMemberRole(...)` + `roleHasCapability(...)`. NO ROLE
   * STRING IS INTERPRETED HERE (ADR-1029) — `@balo/shared/authz` stays the single place a
   * role becomes a capability; this method only calls the predicate. A platform-role actor
   * holds no company membership ⇒ `undefined` ⇒ fails CLOSED, never seeds.
   *
   * The row lock is what makes two concurrent first purchases converge on one seed: the
   * loser sees `already_set` and gets the WINNER'S address back, so its Stripe sync still
   * carries the right value.
   *
   * Never throws for a business outcome — the caller is a fail-soft step on the money path
   * and branches on the discriminant. A genuine DB fault still throws and rolls the tx back.
   *
   * NOTE: no `deleted_at` guard on the company — `companies` has no such column; the
   * not-found guard is the only liveness check this table admits. (The MEMBERSHIP liveness
   * check IS real: `getMemberRole` filters `deleted_at IS NULL`.)
   */
  seedBillingEmail: async (input: SeedBillingEmailInput): Promise<SeedBillingEmailResult> => {
    return db.transaction(async (tx) => {
      // 1. Lock the row. FOR UPDATE serialises concurrent first purchases.
      const [current] = await tx
        .select({ id: companies.id, billingEmail: companies.billingEmail })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .for('update');

      if (current === undefined) {
        return { seeded: false, reason: 'company_not_found', billingEmail: null };
      }

      // 2. The transactional MANAGE_BILLING gate (D4).
      const role = await partyMembershipsRepository.getMemberRole(
        'company',
        input.companyId,
        input.actorUserId,
        tx
      );
      if (role === undefined || !roleHasCapability(role, CAPABILITIES.MANAGE_BILLING)) {
        return { seeded: false, reason: 'no_capability', billingEmail: null };
      }

      // 3. Already seeded (or explicitly set) — never overwrite. Hand the caller the
      //    effective address so this touch's Stripe sync still carries one.
      if (current.billingEmail !== null) {
        return { seeded: false, reason: 'already_set', billingEmail: current.billingEmail };
      }

      // 4. Write value + attribution + `updatedAt` in one statement.
      const now = new Date();
      await tx
        .update(companies)
        .set({
          billingEmail: input.email,
          billingEmailSource: 'seeded',
          billingEmailSetByUserId: input.actorUserId,
          billingEmailSetAt: now,
          updatedAt: now,
        })
        .where(eq(companies.id, input.companyId));

      // 5. Audit, same tx (the row and the record it describes commit together).
      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'company.billing_email_seeded',
          entityType: 'company',
          entityId: input.companyId,
          metadata: { email: input.email, source: 'seeded' },
        },
        tx
      );

      return { seeded: true, billingEmail: input.email, auditEventId: auditRow.id };
    });
  },

  /**
   * BAL-522 — an EXPLICIT billing-email change from /settings/billing. ONE tx, modelled on
   * `setDomainJoinMode`: lock `FOR UPDATE`, gate, no-op when unchanged, otherwise UPDATE +
   * the `company.billing_email_changed` audit row in the SAME tx.
   *
   * ⚠ The MANAGE_BILLING gate runs HERE, on the transaction, BEFORE any write — the
   * TOCTOU-safe half of "at the route AND the repository layer". A membership revoked
   * between the route's gate and this transaction is caught here. Same ADR-1029 posture as
   * {@link companiesRepository.seedBillingEmail}: the role is never interpreted locally.
   *
   * ⚠ NEVER ACCEPTS AN EMPTY VALUE. Zod at the route is the real validator (this method
   * assumes a pre-validated address, exactly as `updateName` does), but "never blankable"
   * must not depend on one caller's schema — hence the structural backstop below. There is
   * no path back to NULL once seeded.
   *
   * NOTE: no `deleted_at` guard on the company (it has no such column); the not-found guard
   * is the only liveness check this table admits.
   */
  setBillingEmail: async (input: SetBillingEmailInput): Promise<SetBillingEmailResult> => {
    if (input.billingEmail.trim().length === 0) {
      throw new Error('billingEmail must be non-empty');
    }

    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: companies.id,
          name: companies.name,
          isPersonal: companies.isPersonal,
          billingEmail: companies.billingEmail,
          billingEmailSource: companies.billingEmailSource,
          billingEmailSetAt: companies.billingEmailSetAt,
        })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .for('update');

      if (current === undefined) {
        return { outcome: 'not_found' };
      }

      const role = await partyMembershipsRepository.getMemberRole(
        'company',
        input.companyId,
        input.actorUserId,
        tx
      );
      if (role === undefined || !roleHasCapability(role, CAPABILITIES.MANAGE_BILLING)) {
        return { outcome: 'forbidden' };
      }

      const company = { name: current.name, isPersonal: current.isPersonal };

      // The `setDomainJoinMode` no-op posture: no write, no audit, no notification, no
      // analytics. The caller still syncs Stripe (the identity may have drifted there).
      if (current.billingEmail === input.billingEmail) {
        return {
          outcome: 'unchanged',
          company,
          billingEmail: current.billingEmail,
          setAt: current.billingEmailSetAt,
        };
      }

      const now = new Date();
      await tx
        .update(companies)
        .set({
          billingEmail: input.billingEmail,
          billingEmailSource: 'set',
          billingEmailSetByUserId: input.actorUserId,
          billingEmailSetAt: now,
          updatedAt: now,
        })
        .where(eq(companies.id, input.companyId));

      const auditRow = await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'company.billing_email_changed',
          entityType: 'company',
          entityId: input.companyId,
          metadata: {
            previous_email: current.billingEmail,
            new_email: input.billingEmail,
            previous_source: current.billingEmailSource,
          },
        },
        tx
      );

      return {
        outcome: 'changed',
        company,
        billingEmail: input.billingEmail,
        setAt: now,
        previousEmail: current.billingEmail,
        previousSource: current.billingEmailSource,
        previousSetAt: current.billingEmailSetAt,
        auditEventId: auditRow.id,
      };
    });
  },

  /**
   * BAL-369 / ADR-1038 — promote a personal workspace into a typed ORGANIZATION at
   * the onboarding Intent step. One tx (all-or-nothing): claim the domain FIRST (so a
   * collision returns/rolls back with NO partial write), then flip `is_personal` + set
   * the name + append the promotion audit row. Attribution is the audit row only —
   * `companies` has no createdBy/owner column and none is invented. Does NOT touch the
   * vestigial `companies.domain` column (D2). Never throws on a domain collision — the
   * caller (a never-throw `AuthResult` Server Action) branches on the returned outcome;
   * a genuine DB failure still throws and rolls the tx back.
   *
   * Deviation from the agency axis (which throws `AgencyDomainCaptureConflictError`):
   * there the tx has already created an agency to roll back; here the collision
   * branches return BEFORE any company mutation, and the caller must distinguish
   * same-type (retryable) from other-type (silent personal fallback) — a discriminated
   * result expresses that cleanly. Genuine DB errors still throw.
   */
  promoteToOrganization: async (
    input: PromoteToOrganizationInput
  ): Promise<PromoteToOrganizationResult> => {
    return db.transaction(async (tx) => {
      // 1. Claim the domain FIRST. `capture()` is race-safe (INSERT ... ON CONFLICT DO
      //    NOTHING on the partial-unique arbiter) and never throws on the conflict
      //    path; on success it also writes the `party_domain.captured` audit row in
      //    this tx. `source: 'auto_captured'` matches the agency axis (`provision`).
      const capture = await partyDomainsRepository.capture(
        {
          partyType: 'company',
          partyId: input.companyId,
          domain: input.domain,
          actorUserId: input.actorUserId,
          source: 'auto_captured',
        },
        tx
      );

      // 2. Branch on the claim outcome. `capture` only special-cases the SAME party as
      //    `already_owned`; a DIFFERENT winner is `skipped:already_claimed`, so
      //    re-resolve the winner's `partyType` to distinguish same/other-type.
      if (capture.outcome !== 'captured' && capture.outcome !== 'already_owned') {
        // Only reachable outcome here is `skipped:already_claimed` (blocked_domain /
        // not_applicable are impossible — the caller only promotes for corporate +
        // verified, which is non-blocked and has a usable domain).
        const owner = await partyDomainsRepository.findActiveByDomain(input.domain);
        // Transient race: a concurrent soft-delete freed the slot between our failed INSERT
        // and this SELECT → retry legitimately re-attempts the now-free claim.
        if (owner === undefined) {
          return { outcome: 'domain_conflict_retryable' };
        }
        // A live COMPANY rightfully owns the domain → same-type. NOT retryable (the owner
        // never disappears); the caller completes onboarding as a personal workspace.
        if (owner.partyType === 'company') {
          return { outcome: 'domain_conflict_same_type' };
        }
        // owner.partyType === 'agency' → other-type: caller stays personal (no error).
        return { outcome: 'domain_conflict_other_type' };
      }

      // 3. Claim held (captured, or idempotently already-owned by THIS company) →
      //    promote. `companies` has no `deleted_at` — a not-found guard is the only
      //    liveness check this table admits (like `updateName`); throwing rolls the
      //    claim + its audit row back too (atomic).
      const [company] = await tx
        .update(companies)
        .set({ name: input.name, isPersonal: false, updatedAt: new Date() })
        .where(eq(companies.id, input.companyId))
        .returning();
      if (company === undefined) {
        throw new Error(`Company not found: ${input.companyId}`);
      }

      // 4. Promotion audit (ADR-1030). Free-form action string — no enum change.
      await auditEventsRepository.record(
        {
          actorUserId: input.actorUserId,
          action: 'company.promoted_to_organization',
          entityType: 'company',
          entityId: input.companyId,
          metadata: { domain: input.domain, name: input.name },
        },
        tx
      );

      return { outcome: 'promoted', company };
    });
  },
};
