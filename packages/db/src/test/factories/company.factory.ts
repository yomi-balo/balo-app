import { db } from '../../client';
import { companies, companyMembers } from '../../schema';
import type { Company, CompanyMember, NewCompany } from '../../schema';

let seq = 0;

/**
 * Seeds a bare `companies` row (BAL-345 tests). Defaults to a NON-personal
 * (shared-org) company so the match-engine settings tests are not accidentally
 * short-circuited by the isPersonal stand-down; pass `{ isPersonal: true }` to
 * exercise that guard. `domainJoinMode` / `membershipAuthority` fall to their
 * schema defaults ('auto' / 'balo') unless overridden.
 */
export async function companyFactory(overrides: Partial<NewCompany> = {}): Promise<Company> {
  seq++;
  const [company] = await db
    .insert(companies)
    .values({ name: `Test Company ${seq}`, isPersonal: false, ...overrides })
    .returning();
  if (company === undefined) throw new Error('company insert failed');
  return company;
}

/**
 * Seeds a single `company_members` row. `role` defaults to 'member', `joinMethod`
 * to 'personal_workspace'. Pass `deletedAt` to seed a soft-removed membership (for
 * the soft-delete-exclusion tests).
 */
export async function companyMemberFactory(input: {
  companyId: string;
  userId: string;
  role?: 'owner' | 'admin' | 'member';
  joinMethod?: 'personal_workspace' | 'invite' | 'domain_match' | 'owner';
  joinedAt?: Date;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
}): Promise<CompanyMember> {
  const [member] = await db
    .insert(companyMembers)
    .values({
      companyId: input.companyId,
      userId: input.userId,
      role: input.role ?? 'member',
      joinMethod: input.joinMethod ?? 'personal_workspace',
      ...(input.joinedAt !== undefined ? { joinedAt: input.joinedAt } : {}),
      deletedAt: input.deletedAt ?? null,
      deletedByUserId: input.deletedByUserId ?? null,
    })
    .returning();
  if (member === undefined) throw new Error('company member insert failed');
  return member;
}
