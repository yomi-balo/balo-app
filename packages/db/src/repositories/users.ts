import { eq, and, isNull, inArray } from 'drizzle-orm';
import { extractEmailDomain } from '@balo/shared/domains';
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
import { partyDomainsRepository, type DomainCaptureResult } from './party-domains';

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
   * Find user with their company membership (for session hydration, excludes soft-deleted)
   */
  findWithCompany: async (id: string) => {
    return db.query.users.findFirst({
      where: and(eq(users.id, id), isNull(users.deletedAt)),
      with: {
        companyMemberships: {
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
    domainCapture: DomainCaptureResult;
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
        })
        .returning();
      if (membership === undefined) throw new Error('company_members insert returned no row');

      // 4. BAL-344: auto-capture the creator's VERIFIED corporate domain onto this
      // workspace (personal or not — do NOT gate on isPersonal). Gate strictly on
      // emailVerified === true; derive the domain from the email. Runs INSIDE this
      // tx, so a capture failure rolls the whole workspace creation back; `capture`
      // itself never throws on the conflict path (blocked/claimed are clean skips).
      let domainCapture: DomainCaptureResult = { outcome: 'not_applicable' };
      const domain = data.emailVerified === true ? extractEmailDomain(data.email) : null;
      if (domain !== null) {
        domainCapture = await partyDomainsRepository.capture(
          { partyType: 'company', partyId: company.id, domain, actorUserId: user.id },
          tx
        );
      }

      return { user, company, membership, domainCapture };
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
};
