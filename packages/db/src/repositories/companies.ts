import { eq, and, isNull, sql } from 'drizzle-orm';
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
};
