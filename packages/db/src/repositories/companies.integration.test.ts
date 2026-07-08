import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../client';
import { companies, companyMembers } from '../schema';
import { userFactory, companyFactory, companyMemberFactory } from '../test/factories';
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
    const member = await userFactory(); // distinct user — one live membership per (company, user)
    await db.insert(companyMembers).values([
      { companyId, userId: owner.id, role: 'owner' },
      { companyId, userId: member.id, role: 'member' },
    ]);

    const found = await companiesRepository.findOwnerByCompanyId(companyId);

    expect(found.id).toBe(owner.id);
  });

  it('excludes a soft-removed owner membership (BAL-345)', async () => {
    const companyId = await seedCompany();
    const owner = await userFactory();
    await companyMemberFactory({
      companyId,
      userId: owner.id,
      role: 'owner',
      deletedAt: new Date(),
      deletedByUserId: owner.id,
    });

    await expect(companiesRepository.findOwnerByCompanyId(companyId)).rejects.toThrow(
      /No owner found for company/
    );
  });

  it('throws for an unknown company id', async () => {
    await expect(companiesRepository.findOwnerByCompanyId(randomUUID())).rejects.toThrow(
      /No owner found for company/
    );
  });
});

// ── companiesRepository.findByUserId (BAL-345 multi-membership) ──────────

describe('companiesRepository.findByUserId', () => {
  it('returns the personal-workspace owner company deterministically across multiple live memberships', async () => {
    const user = await userFactory();
    const personal = await companyFactory({ isPersonal: true, name: 'Personal WS' });
    const shared = await companyFactory({ isPersonal: false, name: 'Shared Org' });
    // Seed the domain-match member FIRST (earlier joinedAt) to prove role, not
    // insertion order, decides: native pg enum `role` sorts owner before member.
    await companyMemberFactory({
      companyId: shared.id,
      userId: user.id,
      role: 'member',
      joinMethod: 'domain_match',
    });
    await companyMemberFactory({
      companyId: personal.id,
      userId: user.id,
      role: 'owner',
      joinMethod: 'personal_workspace',
    });

    const company = await companiesRepository.findByUserId(user.id);
    expect(company?.id).toBe(personal.id);
  });

  it('excludes a soft-deleted membership', async () => {
    const user = await userFactory();
    const personal = await companyFactory({ isPersonal: true });
    const shared = await companyFactory({ isPersonal: false });
    // The owner membership is soft-removed → only the live member membership remains.
    await companyMemberFactory({
      companyId: personal.id,
      userId: user.id,
      role: 'owner',
      deletedAt: new Date(),
      deletedByUserId: user.id,
    });
    await companyMemberFactory({
      companyId: shared.id,
      userId: user.id,
      role: 'member',
      joinMethod: 'domain_match',
    });

    const company = await companiesRepository.findByUserId(user.id);
    expect(company?.id).toBe(shared.id);
  });

  it('returns undefined for a user with no live membership', async () => {
    const user = await userFactory();
    await expect(companiesRepository.findByUserId(user.id)).resolves.toBeUndefined();
  });
});

// ── companiesRepository.updateName (BAL-350 onboarding rename) ───────────
//
// NOTE: the `companies` table has NO `deleted_at` column (only `company_members`
// is soft-deletable — see schema/companies.ts), so there is no soft-delete
// "resurrection" case to assert here: the not-found guard is the only liveness
// check this table admits, and it is covered below.

describe('companiesRepository.updateName', () => {
  it('renames the company, bumps updatedAt, and returns the updated row', async () => {
    const company = await companyFactory({
      name: 'Old Name',
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const updated = await companiesRepository.updateName(company.id, 'New Name');

    expect(updated.id).toBe(company.id);
    expect(updated.name).toBe('New Name');
    // updatedAt is bumped past the seeded value.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime()
    );

    // The rename is persisted, not just reflected in the returned row.
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.name).toBe('New Name');
  });

  it('throws for an unknown company id', async () => {
    await expect(companiesRepository.updateName(randomUUID(), 'Whatever')).rejects.toThrow(
      /Company not found/
    );
  });

  it('scopes the rename to the target id and leaves other companies untouched', async () => {
    const target = await companyFactory({ name: 'Target Co' });
    const other = await companyFactory({ name: 'Bystander Co' });

    await companiesRepository.updateName(target.id, 'Renamed Co');

    const otherAfter = await companiesRepository.findById(other.id);
    expect(otherAfter?.name).toBe('Bystander Co');
  });
});
