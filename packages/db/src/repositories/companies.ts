import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { companies, companyMembers, type Company, type User } from '../schema';
import { auditEventsRepository } from './audit-events';
import { partyDomainsRepository } from './party-domains';

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
   * Atomically increment/decrement credit balance
   */
  updateCredits: async (id: string, delta: number): Promise<Company> => {
    const [company] = await db
      .update(companies)
      .set({
        creditBalance: sql`${companies.creditBalance} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, id))
      .returning();
    return company!;
  },

  /**
   * Rename a company (BAL-350 onboarding workspace naming). Bumps `updatedAt`
   * and returns the updated row. Throws if no row matches `id` so the caller
   * surfaces a retryable error instead of a silent no-op.
   *
   * NOTE: the `companies` table has no `deleted_at` column (only
   * `company_members` is soft-deletable — see schema/companies.ts), so there is
   * no soft-delete predicate to apply here; the not-found guard is the only
   * liveness check this table admits. Matches the `updateCredits` mutation
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
