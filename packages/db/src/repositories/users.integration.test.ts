import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { partyDomains, auditEvents } from '../schema';
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

describe('usersRepository.relinkWorkosId (BAL-360)', () => {
  /** Live audit rows recording a workos re-link for a given user id. */
  async function relinkAuditRows(userId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'user'),
          eq(auditEvents.entityId, userId),
          eq(auditEvents.action, 'user.workos_relinked')
        )
      );
  }

  it('re-links the workosId and writes the audit row atomically', async () => {
    // BAL-362: the existing row must be verified for the in-tx existing-row guard to
    // pass (the factory default is emailVerified: false).
    const user = await userFactory({ workosId: 'W1', emailVerified: true });

    const relinked = await usersRepository.relinkWorkosId(user.id, 'W2', {
      actorUserId: user.id,
      oldWorkosId: 'W1',
      email: user.email,
      emailVerified: true,
    });

    // The returned row carries the NEW identity.
    expect(relinked.id).toBe(user.id);
    expect(relinked.workosId).toBe('W2');

    // The live lookup follows the new identity; the old one no longer resolves.
    await expect(usersRepository.findByWorkosId('W2')).resolves.toMatchObject({ id: user.id });
    await expect(usersRepository.findByWorkosId('W1')).resolves.toBeUndefined();

    // Exactly one audit row, committed in the SAME unit as the update.
    const rows = await relinkAuditRows(user.id);
    expect(rows).toHaveLength(1);
    const [auditRow] = rows;
    if (auditRow === undefined) throw new Error('expected an audit row');
    expect(auditRow.actorUserId).toBe(user.id);
    expect(auditRow.action).toBe('user.workos_relinked');
    expect(auditRow.entityType).toBe('user');
    expect(auditRow.entityId).toBe(user.id);
    expect(auditRow.metadata).toMatchObject({
      oldWorkosId: 'W1',
      newWorkosId: 'W2',
      email: user.email,
    });
  });

  it('throws and writes NO audit row when the target is soft-deleted', async () => {
    const user = await userFactory({ workosId: 'W1' });
    await usersRepository.softDelete(user.id);

    await expect(
      usersRepository.relinkWorkosId(user.id, 'W2', {
        actorUserId: user.id,
        oldWorkosId: 'W1',
        email: user.email,
        emailVerified: true,
      })
    ).rejects.toThrow('relinkWorkosId: user row not found');

    // The guard fires before the audit write, and the failed tx rolls back —
    // nothing was recorded for this entity.
    await expect(relinkAuditRows(user.id)).resolves.toHaveLength(0);
  });

  it('throws for an unknown userId', async () => {
    await expect(
      usersRepository.relinkWorkosId(randomUUID(), 'W2', {
        actorUserId: randomUUID(),
        oldWorkosId: 'W1',
        email: 'nobody@test.com',
        emailVerified: true,
      })
    ).rejects.toThrow('relinkWorkosId: user row not found');
  });

  it('throws and writes NO audit row when the INCOMING emailVerified is not true', async () => {
    const user = await userFactory({ workosId: 'W1', emailVerified: true });

    await expect(
      usersRepository.relinkWorkosId(user.id, 'W2', {
        actorUserId: user.id,
        oldWorkosId: 'W1',
        email: user.email,
        emailVerified: false,
      })
    ).rejects.toThrow(/refusing to re-link an unverified identity/);

    // Fail closed: the guard fires before the tx opens, so the identity is
    // UNCHANGED (still resolves under the old workosId) and NOTHING is written.
    await expect(usersRepository.findByWorkosId('W1')).resolves.toMatchObject({ id: user.id });
    await expect(usersRepository.findByWorkosId('W2')).resolves.toBeUndefined();
    await expect(relinkAuditRows(user.id)).resolves.toHaveLength(0);
  });

  it('throws and writes NO audit row when the EXISTING row is unverified (BAL-362)', async () => {
    // Incoming identity IS verified (pre-tx guard passes), but the existing row is
    // NOT (factory default emailVerified: false) — the in-tx existing-row guard must
    // fire and roll the whole tx back.
    const user = await userFactory({ workosId: 'W1' });

    await expect(
      usersRepository.relinkWorkosId(user.id, 'W2', {
        actorUserId: user.id,
        oldWorkosId: 'W1',
        email: user.email,
        emailVerified: true,
      })
    ).rejects.toThrow(/refusing to re-link onto an unverified existing row/);

    // Fail closed: the guard throws AFTER the update loads the row but BEFORE the
    // audit write, so the tx rolls back — the workosId is UNCHANGED (still resolves
    // under the old identity) and NO audit row is written.
    await expect(usersRepository.findByWorkosId('W1')).resolves.toMatchObject({ id: user.id });
    await expect(usersRepository.findByWorkosId('W2')).resolves.toBeUndefined();
    await expect(relinkAuditRows(user.id)).resolves.toHaveLength(0);
  });
});

describe('users partial unique indexes (BAL-360)', () => {
  it('reuses an email freed by a soft-deleted user', async () => {
    const email = `reuse-${randomUUID()}@test.com`;
    const first = await usersRepository.create({
      workosId: `wos-${randomUUID()}`,
      email,
      firstName: 'First',
      lastName: 'Owner',
    });
    await usersRepository.softDelete(first.id);

    // The email slot is freed because the unique index is partial on
    // deleted_at IS NULL — a fresh live row may reuse it.
    const second = await usersRepository.create({
      workosId: `wos-${randomUUID()}`,
      email,
      firstName: 'Second',
      lastName: 'Owner',
    });

    expect(second.id).not.toBe(first.id);
    expect(second.email).toBe(email);
    expect(second.deletedAt).toBeNull();
  });

  it('reuses a workosId freed by a soft-deleted user', async () => {
    const workosId = `wos-${randomUUID()}`;
    const first = await usersRepository.create({
      workosId,
      email: `first-${randomUUID()}@test.com`,
      firstName: 'First',
      lastName: 'Identity',
    });
    await usersRepository.softDelete(first.id);

    const second = await usersRepository.create({
      workosId,
      email: `second-${randomUUID()}@test.com`,
      firstName: 'Second',
      lastName: 'Identity',
    });

    expect(second.id).not.toBe(first.id);
    expect(second.workosId).toBe(workosId);
    expect(second.deletedAt).toBeNull();
  });

  it('still rejects a duplicate email among LIVE users', async () => {
    const email = `live-${randomUUID()}@test.com`;
    await usersRepository.create({
      workosId: `wos-${randomUUID()}`,
      email,
      firstName: 'Live',
      lastName: 'One',
    });

    // Both rows live → the partial unique index still enforces uniqueness.
    await expect(
      usersRepository.create({
        workosId: `wos-${randomUUID()}`,
        email,
        firstName: 'Live',
        lastName: 'Two',
      })
    ).rejects.toThrow();
  });

  it('still rejects a duplicate workosId among LIVE users', async () => {
    const workosId = `wos-${randomUUID()}`;
    await usersRepository.create({
      workosId,
      email: `livea-${randomUUID()}@test.com`,
      firstName: 'Live',
      lastName: 'Alpha',
    });

    await expect(
      usersRepository.create({
        workosId,
        email: `liveb-${randomUUID()}@test.com`,
        firstName: 'Live',
        lastName: 'Beta',
      })
    ).rejects.toThrow();
  });
});
