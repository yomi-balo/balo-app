import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import { companies, companyMembers } from '../schema';
import { userFactory } from '../test/factories';
import { companiesRepository } from './companies';

/** Inserts a bare company row and returns its id. */
async function seedCompany(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }
  return company.id;
}

// ── companiesRepository.findOwnerByCompanyId ─────────────────────────

describe('companiesRepository.findOwnerByCompanyId', () => {
  it('returns the owner User for a company with an owner membership', async () => {
    const companyId = await seedCompany();
    const owner = await userFactory();
    await db.insert(companyMembers).values({ companyId, userId: owner.id, role: 'owner' });

    const found = await companiesRepository.findOwnerByCompanyId(companyId);

    expect(found.id).toBe(owner.id);
    // Full user shape hydrates (not a bare membership row).
    expect(found.email).toBe(owner.email);
    expect(found.firstName).toBe(owner.firstName);
  });

  it('throws a descriptive error when the company has no members', async () => {
    const companyId = await seedCompany();

    await expect(companiesRepository.findOwnerByCompanyId(companyId)).rejects.toThrow(
      `No owner found for company: ${companyId}`
    );
  });

  it('throws when the company has only a non-owner member (role filter, not any membership)', async () => {
    const companyId = await seedCompany();
    const member = await userFactory();
    await db.insert(companyMembers).values({ companyId, userId: member.id, role: 'member' });

    await expect(companiesRepository.findOwnerByCompanyId(companyId)).rejects.toThrow(
      `No owner found for company: ${companyId}`
    );
  });

  it('returns the owner even when the company also has a non-owner member', async () => {
    const companyId = await seedCompany();
    const owner = await userFactory();
    const member = await userFactory(); // distinct user — company_members.userId is globally unique
    await db.insert(companyMembers).values([
      { companyId, userId: owner.id, role: 'owner' },
      { companyId, userId: member.id, role: 'member' },
    ]);

    const found = await companiesRepository.findOwnerByCompanyId(companyId);

    expect(found.id).toBe(owner.id);
  });

  it('throws for an unknown company id', async () => {
    await expect(companiesRepository.findOwnerByCompanyId(randomUUID())).rejects.toThrow(
      /No owner found for company/
    );
  });
});
