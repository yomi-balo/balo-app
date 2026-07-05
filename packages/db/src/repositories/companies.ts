import { eq, and, sql } from 'drizzle-orm';
import { db } from '../client';
import { companies, companyMembers, type Company, type User } from '../schema';

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
   * Get user's company (for session - users have exactly one company)
   */
  findByUserId: async (userId: string) => {
    const membership = await db.query.companyMembers.findFirst({
      where: eq(companyMembers.userId, userId),
      with: { company: true },
    });
    return membership?.company;
  },

  /**
   * The owner user of a company. Ownership is role-based (company_members.role =
   * 'owner'), written at workspace creation. Throws if the company has no owner —
   * a structural invariant violation, so fail loud.
   */
  findOwnerByCompanyId: async (companyId: string): Promise<User> => {
    const membership = await db.query.companyMembers.findFirst({
      where: and(eq(companyMembers.companyId, companyId), eq(companyMembers.role, 'owner')),
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
};
