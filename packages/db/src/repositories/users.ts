import { eq, and, isNull, inArray, gt, lte } from 'drizzle-orm';
import { db } from '../client';
import {
  users,
  companies,
  companyMembers,
  expertProfiles,
  type User,
  type NewUser,
  type Company,
  type CompanyMember,
} from '../schema';
import { auditEventsRepository } from './audit-events';

/**
 * Platform-role enum values, derived from the inferred `users.platformRole`
 * column type so it stays in lock-step with the `platformRoleEnum` definition
 * (single source of truth) — same house style as the A6 proposal enum types.
 */
export type PlatformRole = User['platformRole'];

export const usersRepository = {
  /**
   * Find user by internal UUID (excludes soft-deleted)
   */
  findById: async (id: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: and(eq(users.id, id), isNull(users.deletedAt)),
    });
  },

  /**
   * Find user by WorkOS ID (used in auth callback, excludes soft-deleted)
   */
  findByWorkosId: async (workosId: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: and(eq(users.workosId, workosId), isNull(users.deletedAt)),
    });
  },

  /**
   * Find user by email (excludes soft-deleted)
   */
  findByEmail: async (email: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: and(eq(users.email, email), isNull(users.deletedAt)),
    });
  },

  /**
   * Find user with their company membership (for session hydration, excludes soft-deleted).
   *
   * BAL-345: the global unique on `company_members.userId` was dropped, so a user
   * may hold more than one live membership. Session consumers read
   * `companyMemberships[0]`, so this read MUST be deterministic: filter out
   * soft-removed memberships and order `[role, joinedAt, id]`. `role` is a NATIVE
   * pg enum (`owner|admin|member`) ordered by DECLARATION order, so `asc(role)`
   * puts the user's own personal-workspace `owner` row FIRST — the session lands
   * in the personal workspace, never a domain-joined secondary org.
   */
  findWithCompany: async (id: string) => {
    return db.query.users.findFirst({
      where: and(eq(users.id, id), isNull(users.deletedAt)),
      with: {
        companyMemberships: {
          where: (m, { isNull: isNullOp }) => isNullOp(m.deletedAt),
          orderBy: (m, { asc }) => [asc(m.role), asc(m.joinedAt), asc(m.id)],
          with: { company: true },
        },
      },
    });
  },

  /**
   * Find user by internal UUID including soft-deleted users
   */
  findByIdIncludingDeleted: async (id: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, id),
    });
  },

  /**
   * Soft-delete a user by setting deletedAt to the current timestamp
   */
  softDelete: async (id: string): Promise<User> => {
    const [user] = await db
      .update(users)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user!;
  },

  /**
   * Find minimal user fields for session sync comparison.
   * Intentionally does NOT filter deletedAt — needs to detect deleted users.
   * Returns: status, activeMode, platformRole, onboardingCompleted, deletedAt, expertProfileId
   */
  findForSessionSync: async (id: string) => {
    const rows = await db
      .select({
        status: users.status,
        activeMode: users.activeMode,
        platformRole: users.platformRole,
        onboardingCompleted: users.onboardingCompleted,
        deletedAt: users.deletedAt,
        expertProfileId: expertProfiles.id,
      })
      .from(users)
      .leftJoin(expertProfiles, eq(expertProfiles.userId, users.id))
      .where(eq(users.id, id))
      .limit(1);

    return rows[0] ?? null;
  },

  /**
   * Batch lookup for notification fan-out (BAL-289): every non-deleted user id
   * whose platformRole is in `roles` (e.g. admins + super_admins). Returns the
   * ids in no particular order; an empty `roles` array yields an empty result.
   */
  findIdsByPlatformRoles: async (roles: PlatformRole[]): Promise<string[]> => {
    if (roles.length === 0) return [];
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.platformRole, roles), isNull(users.deletedAt)));
    return rows.map((r) => r.id);
  },

  /**
   * Create user without workspace (rare - use createWithWorkspace instead)
   */
  create: async (data: NewUser): Promise<User> => {
    const [user] = await db.insert(users).values(data).returning();
    return user!;
  },

  /**
   * Create user with personal workspace (standard signup flow).
   * This is a TRANSACTION - all or nothing.
   *
   * Used by:
   * - apps/web: OAuth callback (BAL-43)
   * - apps/api: Future invite acceptance webhooks
   */
  createWithWorkspace: async (
    data: NewUser
  ): Promise<{
    user: User;
    company: Company;
    membership: CompanyMember;
  }> => {
    return db.transaction(async (tx) => {
      // 1. Create user
      const [user] = await tx.insert(users).values(data).returning();
      if (user === undefined) throw new Error('users insert returned no row');

      // 2. Create personal workspace
      const workspaceName = data.firstName ? `${data.firstName}'s Workspace` : 'My Workspace';

      const [company] = await tx
        .insert(companies)
        .values({
          name: workspaceName,
          isPersonal: true,
          creditBalance: 0,
        })
        .returning();
      if (company === undefined) throw new Error('companies insert returned no row');

      // 3. Add user as owner
      const [membership] = await tx
        .insert(companyMembers)
        .values({
          companyId: company.id,
          userId: user.id,
          role: 'owner',
          // BAL-345: self-documenting — this is the personal-workspace owner row
          // (the column also defaults to this value as a safety net).
          joinMethod: 'personal_workspace',
        })
        .returning();
      if (membership === undefined) throw new Error('company_members insert returned no row');

      // BAL-369 / ADR-1038: signup no longer claims a corporate domain. The domain
      // claim + org promotion now happen at the onboarding Intent step
      // (`companiesRepository.promoteToOrganization`), NOT here. A structural
      // invariant test (invariants/createwithworkspace-no-domain-claim.test.ts)
      // guards this seam against regression.
      return { user, company, membership };
    });
  },

  /**
   * Update user profile
   */
  update: async (id: string, data: Partial<NewUser>): Promise<User> => {
    const [user] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user!;
  },

  /**
   * BAL-360: adopt a NEW workosId onto an existing LIVE user row (identity re-link),
   * writing an immutable audit row in the SAME transaction (ADR-1030). Guards on
   * deleted_at IS NULL — the caller resolved a live email match. Throws if the row
   * is missing (returning() empty).
   *
   * TWO account-takeover guards are ENFORCED here (fail closed, defense-in-depth) so
   * any future caller of this reusable seam cannot re-link an unverified identity:
   * - INCOMING profile (`opts.emailVerified !== true`) — checked before the tx opens.
   * - EXISTING row (BAL-362, `user.emailVerified !== true`) — checked inside the tx,
   *   after the update loads the current row, before the audit write. Reachable
   *   because the password path can persist an unverified users row (sign-in
   *   orphan-recovery). Throwing inside the tx rolls back the workosId write AND
   *   prevents the audit row.
   *
   * The caller still owns the user-facing conflict surface (e.g. AccountExistsError).
   */
  relinkWorkosId: async (
    userId: string,
    newWorkosId: string,
    opts: { actorUserId: string; oldWorkosId: string; email: string; emailVerified: boolean }
  ): Promise<User> => {
    // BAL-360 account-takeover guard (defense-in-depth): a re-link is only ever
    // safe on a WorkOS-verified email. The OAuth callback already checks this, but
    // enforce it here too so any future caller of this reusable seam cannot re-link
    // an unverified identity. Fail closed — never assume, never coerce.
    if (opts.emailVerified !== true) {
      throw new Error('relinkWorkosId: refusing to re-link an unverified identity');
    }
    return db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ workosId: newWorkosId, updatedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .returning();
      if (user === undefined) throw new Error('relinkWorkosId: user row not found');

      // BAL-362 existing-row account-takeover guard (fail-closed, defense-in-depth):
      // the row being re-linked ONTO must also be verified. The update only sets
      // workosId+updatedAt, so `user.emailVerified` here reflects the EXISTING row.
      // Throwing inside the tx rolls back the workosId write AND prevents the audit
      // row. Reachable because the password path can persist an unverified users row.
      if (user.emailVerified !== true) {
        throw new Error('relinkWorkosId: refusing to re-link onto an unverified existing row');
      }

      await auditEventsRepository.record(
        {
          actorUserId: opts.actorUserId,
          action: 'user.workos_relinked',
          entityType: 'user',
          entityId: userId,
          metadata: { oldWorkosId: opts.oldWorkosId, newWorkosId, email: opts.email },
        },
        tx
      );

      return user;
    });
  },

  /**
   * Mark phone as verified, writing phone + verified timestamp atomically.
   * Both fields are written together so the record never has a verified
   * timestamp pointing to a different phone number than what was verified.
   */
  setPhoneVerified: async (userId: string, phone: string, verifiedAt: Date): Promise<User> => {
    const [user] = await db
      .update(users)
      .set({ phone, phoneVerifiedAt: verifiedAt, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return user!;
  },

  /**
   * Update last active timestamp
   */
  touch: async (id: string): Promise<void> => {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, id));
  },

  /**
   * Batch NAME hydration (BAL-347) — projects id/firstName/lastName ONLY for a set
   * of user ids (never email/workosId/PII into a client-bound DTO). Excludes
   * soft-deleted users; returns `[]` for empty input (no query). Ordering is
   * unspecified — callers key by id. Batch-shaped for reuse (today: the join-mode
   * last-changed-by actor, a batch of one).
   */
  findNamesByIds: async (
    ids: string[]
  ): Promise<Array<{ id: string; firstName: string | null; lastName: string | null }>> => {
    if (ids.length === 0) return [];
    return db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(inArray(users.id, ids), isNull(users.deletedAt)));
  },

  /**
   * BAL-374 onboarding-reminder sweep: non-deleted users who have NOT completed
   * onboarding and whose `created_at` falls in the HALF-OPEN window `(after, until]`
   * (`created_at > after AND created_at <= until`). Projects `id` + `email` ONLY
   * (email → domain-class recompute + engine recipient resolution; no PII beyond
   * that). The half-open lower bound is deliberate: the hourly sweep uses a
   * one-cron-period-wide band per cadence step, so a user whose `created_at` sits on
   * a tick boundary is matched on exactly ONE tick per step (no double-send). Ordering
   * is unspecified — the caller iterates per row.
   */
  findIncompleteOnboardingCreatedBetween: async (
    after: Date,
    until: Date
  ): Promise<Array<{ id: string; email: string }>> => {
    return db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.onboardingCompleted, false),
          isNull(users.deletedAt),
          gt(users.createdAt, after),
          lte(users.createdAt, until)
        )
      );
  },
};
