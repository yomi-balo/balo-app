import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  users,
  companies,
  companyMembers,
  expertProfiles,
  type User,
  type NewUser,
} from '../schema';

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
  createWithWorkspace: async (data: NewUser) => {
    return db.transaction(async (tx) => {
      // 1. Create user
      const [user] = await tx.insert(users).values(data).returning();

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

      // 3. Add user as owner
      const [membership] = await tx
        .insert(companyMembers)
        .values({
          companyId: company!.id,
          userId: user!.id,
          role: 'owner',
        })
        .returning();

      return { user: user!, company: company!, membership: membership! };
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
   * Update last active timestamp
   */
  touch: async (id: string): Promise<void> => {
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, id));
  },
};
