import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { partyDomains } from '../schema';
import { userFactory, companyFactory, companyMemberFactory } from '../test/factories';
import { usersRepository } from './users';

describe('usersRepository.setPhoneVerified', () => {
  it('writes phone and phoneVerifiedAt atomically', async () => {
    const user = await userFactory();
    const phone = '+61412345678';
    const verifiedAt = new Date('2026-01-15T10:00:00Z');

    const result = await usersRepository.setPhoneVerified(user.id, phone, verifiedAt);

    expect(result.id).toBe(user.id);
    expect(result.phone).toBe(phone);
    expect(result.phoneVerifiedAt).toEqual(verifiedAt);
  });

  it('bumps updatedAt', async () => {
    const user = await userFactory();
    const before = user.updatedAt;

    const result = await usersRepository.setPhoneVerified(user.id, '+61400000000', new Date());

    expect(result.updatedAt!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
  });

  it('returns undefined for a non-existent userId', async () => {
    const nonExistentId = randomUUID();

    const result = await usersRepository.setPhoneVerified(
      nonExistentId,
      '+61412345678',
      new Date()
    );

    expect(result).toBeUndefined();
  });
});

describe('usersRepository.update', () => {
  it('updates country and countryCode fields', async () => {
    const user = await userFactory({ country: 'Australia', countryCode: 'AU' });

    const updated = await usersRepository.update(user.id, {
      country: 'United States',
      countryCode: 'US',
    });

    expect(updated.id).toBe(user.id);
    expect(updated.country).toBe('United States');
    expect(updated.countryCode).toBe('US');
  });

  it('sets countryCode to null when explicitly passed', async () => {
    const user = await userFactory({ country: 'Australia', countryCode: 'AU' });
    expect(user.countryCode).toBe('AU');

    const updated = await usersRepository.update(user.id, { countryCode: null });

    expect(updated.countryCode).toBeNull();
  });

  it('does not affect unrelated fields when not passed', async () => {
    const user = await userFactory({
      firstName: 'Alice',
      lastName: 'Smith',
      country: 'Australia',
      countryCode: 'AU',
    });

    const updated = await usersRepository.update(user.id, { country: 'Germany' });

    expect(updated.country).toBe('Germany');
    // Unrelated fields should remain unchanged
    expect(updated.email).toBe(user.email);
    expect(updated.firstName).toBe('Alice');
    expect(updated.lastName).toBe('Smith');
    expect(updated.countryCode).toBe('AU');
  });

  it('returns undefined (cast as User) for a non-existent userId', async () => {
    const nonExistentId = randomUUID();

    // The repository does `return user!` which is a TS-only assertion.
    // At runtime, destructuring an empty array gives undefined.
    const result = await usersRepository.update(nonExistentId, { country: 'Germany' });

    expect(result).toBeUndefined();
  });
});

describe('usersRepository.findIdsByPlatformRoles', () => {
  it('returns ids for users whose platformRole matches', async () => {
    const admin = await userFactory({ platformRole: 'admin' });
    const superAdmin = await userFactory({ platformRole: 'super_admin' });
    // Plain user (default role) must be excluded.
    await userFactory({ platformRole: 'user' });

    const ids = await usersRepository.findIdsByPlatformRoles(['admin', 'super_admin']);

    expect(ids.sort()).toEqual([admin.id, superAdmin.id].sort());
  });

  it('excludes soft-deleted users', async () => {
    const liveAdmin = await userFactory({ platformRole: 'admin' });
    const deletedAdmin = await userFactory({ platformRole: 'admin' });
    await usersRepository.softDelete(deletedAdmin.id);

    const ids = await usersRepository.findIdsByPlatformRoles(['admin']);

    expect(ids).toEqual([liveAdmin.id]);
    expect(ids).not.toContain(deletedAdmin.id);
  });

  it('returns [] when no user matches the requested roles', async () => {
    await userFactory({ platformRole: 'user' });

    const ids = await usersRepository.findIdsByPlatformRoles(['super_admin']);

    expect(ids).toEqual([]);
  });

  it('returns [] for an empty roles array (empty-input guard)', async () => {
    // An admin exists, but an empty roles filter must short-circuit to [].
    await userFactory({ platformRole: 'admin' });

    const ids = await usersRepository.findIdsByPlatformRoles([]);

    expect(ids).toEqual([]);
  });
});

describe('usersRepository.findWithCompany (BAL-345 deterministic session read)', () => {
  it('orders companyMemberships owner-first and excludes soft-deleted', async () => {
    const user = await userFactory();
    const personal = await companyFactory({ isPersonal: true });
    const shared = await companyFactory({ isPersonal: false });
    const removed = await companyFactory({ isPersonal: false });

    // Domain-match member seeded first; personal-workspace owner second; a
    // soft-removed owner third. Deterministic read must surface personal first.
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
    await companyMemberFactory({
      companyId: removed.id,
      userId: user.id,
      role: 'owner',
      deletedAt: new Date(),
      deletedByUserId: user.id,
    });

    const result = await usersRepository.findWithCompany(user.id);
    const memberships = result?.companyMemberships ?? [];

    // Soft-deleted membership excluded → exactly the two live rows.
    expect(memberships).toHaveLength(2);
    // The personal-workspace owner row is [0] — the session lands here.
    expect(memberships[0]?.companyId).toBe(personal.id);
    expect(memberships[0]?.role).toBe('owner');
    expect(memberships.map((m) => m.companyId)).not.toContain(removed.id);
  });
});

describe('usersRepository.createWithWorkspace domain capture (BAL-344)', () => {
  /** Live party_domains rows for a company party. */
  async function liveDomainsForCompany(companyId: string): Promise<string[]> {
    const rows = await db
      .select()
      .from(partyDomains)
      .where(and(eq(partyDomains.partyId, companyId), isNull(partyDomains.deletedAt)));
    return rows.map((r) => r.domain);
  }

  it('captures the verified corporate domain onto the new workspace', async () => {
    const suffix = randomUUID().slice(0, 8);
    const result = await usersRepository.createWithWorkspace({
      workosId: `wos-${suffix}`,
      email: `founder@corp-${suffix}.com`,
      firstName: 'Founder',
      lastName: 'One',
      emailVerified: true,
      activeMode: 'client',
    });

    expect(result.domainCapture).toEqual({
      outcome: 'captured',
      partyType: 'company',
      source: 'auto_captured',
    });
    await expect(liveDomainsForCompany(result.company.id)).resolves.toEqual([`corp-${suffix}.com`]);
  });

  it('does not capture when the email is unverified (not_applicable, no row)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const result = await usersRepository.createWithWorkspace({
      workosId: `wos-${suffix}`,
      email: `founder@corp-${suffix}.com`,
      firstName: 'Founder',
      lastName: 'Two',
      emailVerified: false,
      activeMode: 'client',
    });

    expect(result.domainCapture).toEqual({ outcome: 'not_applicable' });
    await expect(liveDomainsForCompany(result.company.id)).resolves.toEqual([]);
  });

  it('skips a verified freemail domain (blocked_domain, no row)', async () => {
    const suffix = randomUUID().slice(0, 8);
    const result = await usersRepository.createWithWorkspace({
      workosId: `wos-${suffix}`,
      email: `person-${suffix}@gmail.com`,
      firstName: 'Person',
      lastName: 'Three',
      emailVerified: true,
      activeMode: 'client',
    });

    expect(result.domainCapture).toEqual({ outcome: 'skipped', reason: 'blocked_domain' });
    await expect(liveDomainsForCompany(result.company.id)).resolves.toEqual([]);
  });
});

describe('usersRepository.findNamesByIds', () => {
  it('projects id/firstName/lastName only for the requested subset', async () => {
    const ada = await userFactory({ firstName: 'Ada', lastName: 'Lovelace' });
    const grace = await userFactory({ firstName: 'Grace', lastName: 'Hopper' });
    const unrequested = await userFactory({ firstName: 'Not', lastName: 'Wanted' });

    const rows = await usersRepository.findNamesByIds([ada.id, grace.id]);

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ada.id)).toEqual({ id: ada.id, firstName: 'Ada', lastName: 'Lovelace' });
    expect(byId.get(grace.id)).toEqual({ id: grace.id, firstName: 'Grace', lastName: 'Hopper' });
    expect(byId.has(unrequested.id)).toBe(false);

    // The projection carries NO PII columns (email / workosId).
    const [firstRow] = rows;
    if (firstRow === undefined) throw new Error('expected a row');
    expect(Object.keys(firstRow).sort()).toEqual(['firstName', 'id', 'lastName']);
  });

  it('excludes soft-deleted users', async () => {
    const live = await userFactory();
    const deleted = await userFactory();
    await usersRepository.softDelete(deleted.id);

    const rows = await usersRepository.findNamesByIds([live.id, deleted.id]);
    expect(rows.map((r) => r.id)).toEqual([live.id]);
  });

  it('returns an empty array for empty input (no query)', async () => {
    await expect(usersRepository.findNamesByIds([])).resolves.toEqual([]);
  });
});
