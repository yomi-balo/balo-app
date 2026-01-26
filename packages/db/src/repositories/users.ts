import { eq } from 'drizzle-orm';
import { db } from '../client';
import { users, companies, companyMembers, type User, type NewUser } from '../schema';

export const usersRepository = {
  /**
   * Find user by internal UUID
   */
  findById: async (id: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.id, id),
    });
  },

  /**
   * Find user by WorkOS ID (used in auth callback)
   */
  findByWorkosId: async (workosId: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.workosId, workosId),
    });
  },

  /**
   * Find user by email
   */
  findByEmail: async (email: string): Promise<User | undefined> => {
    return db.query.users.findFirst({
      where: eq(users.email, email),
    });
  },

  /**
   * Find user with their company membership (for session hydration)
   */
  findWithCompany: async (id: string) => {
    return db.query.users.findFirst({
      where: eq(users.id, id),
      with: {
        companyMemberships: {
          with: { company: true },
        },
      },
    });
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
