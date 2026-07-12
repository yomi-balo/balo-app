import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { companies, companyMembers, auditEvents, partyDomains } from '../schema';
import {
  userFactory,
  companyFactory,
  companyMemberFactory,
  agencyFactory,
} from '../test/factories';
import { companiesRepository } from './companies';
import { auditEventsRepository } from './audit-events';

/** company.join_mode_changed audit rows for a company id (test-local helper). */
async function joinModeAuditsFor(companyId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'company'),
        eq(auditEvents.entityId, companyId),
        eq(auditEvents.action, 'company.join_mode_changed')
      )
    );
}

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

// ── companiesRepository.setDomainJoinMode (BAL-347 join-mode) ────────────

describe('companiesRepository.setDomainJoinMode', () => {
  it('changes the mode, bumps updatedAt, and writes a company.join_mode_changed audit', async () => {
    const admin = await userFactory();
    const company = await companyFactory({ domainJoinMode: 'auto' });

    const result = await companiesRepository.setDomainJoinMode(company.id, 'request', admin.id);

    expect(result).toEqual({ previous: 'auto', next: 'request', changed: true });

    const reread = await companiesRepository.findById(company.id);
    expect(reread?.domainJoinMode).toBe('request');

    const audits = await joinModeAuditsFor(company.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(admin.id);
    expect(audits[0]?.metadata).toEqual({ from: 'auto', to: 'request' });
  });

  it('is a no-op when the mode is unchanged — no write, no audit', async () => {
    const admin = await userFactory();
    const company = await companyFactory({ domainJoinMode: 'request' });

    const result = await companiesRepository.setDomainJoinMode(company.id, 'request', admin.id);

    expect(result).toEqual({ previous: 'request', next: 'request', changed: false });
    await expect(joinModeAuditsFor(company.id)).resolves.toHaveLength(0);
  });

  it('throws for an unknown company id', async () => {
    const admin = await userFactory();
    await expect(
      companiesRepository.setDomainJoinMode(randomUUID(), 'off', admin.id)
    ).rejects.toThrow(/Company not found/);
  });
});

// ── companiesRepository.promoteToOrganization (BAL-369 / ADR-1038) ───────

describe('companiesRepository.promoteToOrganization', () => {
  /** Live party_domains rows owned by a company party. */
  async function liveDomainsForCompany(
    companyId: string
  ): Promise<(typeof partyDomains.$inferSelect)[]> {
    return db
      .select()
      .from(partyDomains)
      .where(
        and(
          eq(partyDomains.partyType, 'company'),
          eq(partyDomains.partyId, companyId),
          isNull(partyDomains.deletedAt)
        )
      );
  }

  /** Audit rows for a given entity + action (test-local helper). */
  async function auditsFor(
    entityType: string,
    entityId: string,
    action: string
  ): Promise<(typeof auditEvents.$inferSelect)[]> {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, entityType),
          eq(auditEvents.entityId, entityId),
          eq(auditEvents.action, action)
        )
      );
  }

  /** Directly seed a competing live party_domains claim (bypasses capture). */
  async function seedClaim(
    partyType: 'company' | 'agency',
    partyId: string,
    domain: string,
    createdByUserId: string
  ): Promise<void> {
    await db
      .insert(partyDomains)
      .values({ partyType, partyId, domain, source: 'auto_captured', createdByUserId });
  }

  it('promotes an unowned corporate domain: flips is_personal, sets name, claims the domain, writes both audits', async () => {
    const actor = await userFactory();
    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    const result = await companiesRepository.promoteToOrganization({
      companyId: company.id,
      name: 'Acme',
      domain: 'acme.io',
      actorUserId: actor.id,
    });

    expect(result.outcome).toBe('promoted');
    if (result.outcome !== 'promoted') throw new Error('expected promoted outcome');
    expect(result.company.isPersonal).toBe(false);
    expect(result.company.name).toBe('Acme');

    // Persisted, not just reflected in the returned row.
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(false);
    expect(reread?.name).toBe('Acme');

    // Exactly one live party_domains row for this company, with the right source.
    const domains = await liveDomainsForCompany(company.id);
    expect(domains).toHaveLength(1);
    const [claim] = domains;
    if (claim === undefined) throw new Error('expected a domain claim');
    expect(claim.domain).toBe('acme.io');
    expect(claim.source).toBe('auto_captured');
    expect(claim.createdByUserId).toBe(actor.id);

    // BOTH audits: the capture audit (keyed on the party_domains row) AND the promote
    // audit (keyed on the company).
    const captureAudits = await auditsFor('party_domain', claim.id, 'party_domain.captured');
    expect(captureAudits).toHaveLength(1);

    const promoteAudits = await auditsFor(
      'company',
      company.id,
      'company.promoted_to_organization'
    );
    expect(promoteAudits).toHaveLength(1);
    const [promoteAudit] = promoteAudits;
    if (promoteAudit === undefined) throw new Error('expected a promote audit');
    expect(promoteAudit.actorUserId).toBe(actor.id);
    expect(promoteAudit.metadata).toEqual({ domain: 'acme.io', name: 'Acme' });
  });

  it('same-type collision (another company owns the domain) → domain_conflict_same_type, no write', async () => {
    const actor = await userFactory();
    const otherOwner = await userFactory();
    const otherCompany = await companyFactory();
    await seedClaim('company', otherCompany.id, 'acme.io', otherOwner.id);

    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    const result = await companiesRepository.promoteToOrganization({
      companyId: company.id,
      name: 'Acme',
      domain: 'acme.io',
      actorUserId: actor.id,
    });

    expect(result.outcome).toBe('domain_conflict_same_type');

    // The personal company is untouched.
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(true);
    expect(reread?.name).toBe('Personal WS');

    // No claim created for our company; no promote audit.
    await expect(liveDomainsForCompany(company.id)).resolves.toHaveLength(0);
    await expect(
      auditsFor('company', company.id, 'company.promoted_to_organization')
    ).resolves.toHaveLength(0);
  });

  it('other-type collision (an agency owns the domain) → domain_conflict_other_type, no write', async () => {
    const actor = await userFactory();
    const agencyOwner = await userFactory();
    const agency = await agencyFactory();
    await seedClaim('agency', agency.id, 'acme.io', agencyOwner.id);

    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    const result = await companiesRepository.promoteToOrganization({
      companyId: company.id,
      name: 'Acme',
      domain: 'acme.io',
      actorUserId: actor.id,
    });

    expect(result.outcome).toBe('domain_conflict_other_type');

    // The personal company is untouched; no claim; no promote audit.
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(true);
    expect(reread?.name).toBe('Personal WS');
    await expect(liveDomainsForCompany(company.id)).resolves.toHaveLength(0);
    await expect(
      auditsFor('company', company.id, 'company.promoted_to_organization')
    ).resolves.toHaveLength(0);
  });

  it('rolls the whole tx back when the audit insert throws (atomicity)', async () => {
    const actor = await userFactory();
    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    // The first record() call inside the tx is capture's party_domain.captured audit;
    // rejecting it must roll back the claim insert AND leave the company personal.
    const spy = vi
      .spyOn(auditEventsRepository, 'record')
      .mockRejectedValueOnce(new Error('audit boom'));

    await expect(
      companiesRepository.promoteToOrganization({
        companyId: company.id,
        name: 'Acme',
        domain: 'acme.io',
        actorUserId: actor.id,
      })
    ).rejects.toThrow('audit boom');

    spy.mockRestore();

    // Nothing persisted: no claim, company still personal with its original name.
    await expect(liveDomainsForCompany(company.id)).resolves.toHaveLength(0);
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(true);
    expect(reread?.name).toBe('Personal WS');
  });

  it('rolls the company UPDATE back too when the PROMOTE audit (step 4) throws (atomicity)', async () => {
    const actor = await userFactory();
    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    // Let capture's party_domain.captured audit (the 1st record() call) succeed, then
    // reject the promote audit (the 2nd call) — which fires AFTER the is_personal/name
    // UPDATE. This exercises the step-3→step-4 rollback path the first atomicity test
    // cannot reach: it proves the company UPDATE itself rolls back, not just the claim.
    const originalRecord = auditEventsRepository.record;
    const spy = vi
      .spyOn(auditEventsRepository, 'record')
      .mockImplementationOnce(originalRecord)
      .mockRejectedValueOnce(new Error('promote audit boom'));

    await expect(
      companiesRepository.promoteToOrganization({
        companyId: company.id,
        name: 'Acme',
        domain: 'acme.io',
        actorUserId: actor.id,
      })
    ).rejects.toThrow('promote audit boom');

    spy.mockRestore();

    // Whole tx rolled back: company reverted to personal + original name (the UPDATE
    // undone), the claim insert undone, and no promote audit persisted.
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(true);
    expect(reread?.name).toBe('Personal WS');
    await expect(liveDomainsForCompany(company.id)).resolves.toHaveLength(0);
    await expect(
      auditsFor('company', company.id, 'company.promoted_to_organization')
    ).resolves.toHaveLength(0);
  });

  it('is idempotent when the domain is already owned by THIS company → promoted', async () => {
    const actor = await userFactory();
    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });
    // Pre-seed the claim already owned by THIS company (capture will resolve
    // already_owned, and promote proceeds).
    await seedClaim('company', company.id, 'acme.io', actor.id);

    const result = await companiesRepository.promoteToOrganization({
      companyId: company.id,
      name: 'Acme',
      domain: 'acme.io',
      actorUserId: actor.id,
    });

    expect(result.outcome).toBe('promoted');
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(false);
    expect(reread?.name).toBe('Acme');

    // Still exactly one live claim (no duplicate insert on the idempotent path).
    await expect(liveDomainsForCompany(company.id)).resolves.toHaveLength(1);
    // The promote audit is written even on the idempotent claim path.
    await expect(
      auditsFor('company', company.id, 'company.promoted_to_organization')
    ).resolves.toHaveLength(1);
  });
});
