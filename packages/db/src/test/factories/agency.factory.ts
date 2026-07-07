import { db } from '../../client';
import { agencies, agencyMembers } from '../../schema';
import type { Agency, AgencyMember, NewAgency } from '../../schema';

let seq = 0;

/** Seeds a bare `agencies` row (BAL-345 agency-symmetry tests). */
export async function agencyFactory(overrides: Partial<NewAgency> = {}): Promise<Agency> {
  seq++;
  const [agency] = await db
    .insert(agencies)
    .values({ name: `Test Agency ${seq}`, ...overrides })
    .returning();
  if (agency === undefined) throw new Error('agency insert failed');
  return agency;
}

/**
 * Seeds a single `agency_members` row. `role` defaults to 'expert' (the agency
 * base role), `joinMethod` to 'personal_workspace'.
 */
export async function agencyMemberFactory(input: {
  agencyId: string;
  userId: string;
  role?: 'owner' | 'admin' | 'expert';
  joinMethod?: 'personal_workspace' | 'invite' | 'domain_match' | 'owner';
  joinedAt?: Date;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
}): Promise<AgencyMember> {
  const [member] = await db
    .insert(agencyMembers)
    .values({
      agencyId: input.agencyId,
      userId: input.userId,
      role: input.role ?? 'expert',
      joinMethod: input.joinMethod ?? 'personal_workspace',
      ...(input.joinedAt !== undefined ? { joinedAt: input.joinedAt } : {}),
      deletedAt: input.deletedAt ?? null,
      deletedByUserId: input.deletedByUserId ?? null,
    })
    .returning();
  if (member === undefined) throw new Error('agency member insert failed');
  return member;
}
