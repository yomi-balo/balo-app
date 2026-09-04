import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { companies, companyMembers, users, auditEvents, partyDomains } from '../schema';
import {
  userFactory,
  companyFactory,
  companyMemberFactory,
  agencyFactory,
} from '../test/factories';
import { companiesRepository } from './companies';
import { auditEventsRepository } from './audit-events';
import { partyDomainsRepository } from './party-domains';

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

// ── companiesRepository.findOwnerUserIdByCompanyId ───────────────────

describe('companiesRepository.findOwnerUserIdByCompanyId', () => {
  it("returns the owner's user id for a company with an owner membership", async () => {
    const companyId = await seedCompany();
    const owner = await userFactory();
    await db.insert(companyMembers).values({ companyId, userId: owner.id, role: 'owner' });

    const found = await companiesRepository.findOwnerUserIdByCompanyId(companyId);

    expect(found).toBe(owner.id);
  });

  it('returns undefined (does NOT throw) for a company with no live owner', async () => {
    const companyId = await seedCompany();

    await expect(
      companiesRepository.findOwnerUserIdByCompanyId(companyId)
    ).resolves.toBeUndefined();
  });

  it('excludes a soft-removed owner membership → undefined (BAL-345)', async () => {
    const companyId = await seedCompany();
    const owner = await userFactory();
    await companyMemberFactory({
      companyId,
      userId: owner.id,
      role: 'owner',
      deletedAt: new Date(),
      deletedByUserId: owner.id,
    });

    await expect(
      companiesRepository.findOwnerUserIdByCompanyId(companyId)
    ).resolves.toBeUndefined();
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

  it('transient race (owner freed mid-op) → domain_conflict_retryable, no write', async () => {
    const actor = await userFactory();
    const otherOwner = await userFactory();
    const otherCompany = await companyFactory();
    // A live competing claim makes capture() genuinely return skipped:already_claimed.
    await seedClaim('company', otherCompany.id, 'acme.io', otherOwner.id);

    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    // Simulate the cross-tx TOCTOU: the owner-resolution SELECT sees the slot freed by a
    // concurrent soft-delete → findActiveByDomain returns undefined exactly once. Same
    // in-file vi.spyOn pattern the atomicity tests use on auditEventsRepository.record;
    // documented so a future reader does not "fix" the spy — the branch is a real
    // cross-transaction race, not deterministically reproducible by data alone.
    const spy = vi
      .spyOn(partyDomainsRepository, 'findActiveByDomain')
      .mockResolvedValueOnce(undefined);

    const result = await companiesRepository.promoteToOrganization({
      companyId: company.id,
      name: 'Acme',
      domain: 'acme.io',
      actorUserId: actor.id,
    });

    spy.mockRestore();

    expect(result.outcome).toBe('domain_conflict_retryable');

    // Our company is untouched (still personal, original name); nothing was written.
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(true);
    expect(reread?.name).toBe('Personal WS');
    await expect(liveDomainsForCompany(company.id)).resolves.toHaveLength(0);
    await expect(
      auditsFor('company', company.id, 'company.promoted_to_organization')
    ).resolves.toHaveLength(0);
  });

  it('standing release/re-claim: a soft-deleted competing claim frees the slot → promote SUCCEEDS', async () => {
    const actor = await userFactory();
    const otherOwner = await userFactory();
    const otherCompany = await companyFactory();
    // A competing company claims acme.io first, then the claim is RELEASED (admin
    // removeDomain soft-deletes the mapping — modelled here by stamping deleted_at). The
    // partial-unique index is partial on `deleted_at IS NULL`, so the slot is now free.
    await seedClaim('company', otherCompany.id, 'acme.io', otherOwner.id);
    await db
      .update(partyDomains)
      .set({ deletedAt: new Date(), deletedByUserId: otherOwner.id })
      .where(eq(partyDomains.domain, 'acme.io'));

    const company = await companyFactory({ isPersonal: true, name: 'Personal WS' });

    const result = await companiesRepository.promoteToOrganization({
      companyId: company.id,
      name: 'Acme',
      domain: 'acme.io',
      actorUserId: actor.id,
    });

    // capture()'s onConflictDoNothing arbiter re-claims the freed slot automatically.
    expect(result.outcome).toBe('promoted');
    const reread = await companiesRepository.findById(company.id);
    expect(reread?.isPersonal).toBe(false);
    expect(reread?.name).toBe('Acme');

    // Exactly ONE live claim now, owned by OUR company (the soft-deleted one stays dead).
    const domains = await liveDomainsForCompany(company.id);
    expect(domains).toHaveLength(1);
    const [claim] = domains;
    if (claim === undefined) throw new Error('expected a domain claim');
    expect(claim.domain).toBe('acme.io');
    expect(claim.createdByUserId).toBe(actor.id);

    // The promote audit is written.
    await expect(
      auditsFor('company', company.id, 'company.promoted_to_organization')
    ).resolves.toHaveLength(1);
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

describe('companiesRepository.findNameById — the PROJECTED display read (BAL-388)', () => {
  it('returns exactly id + name, and nothing else from the row', async () => {
    const companyId = await seedCompany();

    const row = await companiesRepository.findNameById(companyId);

    if (row === undefined) throw new Error('expected a display row');
    expect(Object.keys(row).sort()).toEqual(['id', 'name']);
    expect(row.name).toBe('Acme Co');
  });

  it('returns undefined for an unknown id', async () => {
    await expect(companiesRepository.findNameById(randomUUID())).resolves.toBeUndefined();
  });
});

describe('companiesRepository.findSummariesByIds — the PROJECTED batch read (BAL-494)', () => {
  it('returns id + name + isPersonal for the requested subset, and nothing else', async () => {
    const alpha = await companyFactory({ name: 'Alpha Co', isPersonal: false });
    const beta = await companyFactory({ name: 'Beta Co', isPersonal: true });
    const unrequested = await companyFactory({ name: 'Gamma Co' });

    const rows = await companiesRepository.findSummariesByIds([alpha.id, beta.id]);

    expect(rows).toHaveLength(2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(alpha.id)).toEqual({ id: alpha.id, name: 'Alpha Co', isPersonal: false });
    expect(byId.get(beta.id)).toEqual({ id: beta.id, name: 'Beta Co', isPersonal: true });
    expect(byId.has(unrequested.id)).toBe(false);

    // The key SET is the invariant — this row is destined for the session cookie, so a
    // widening regression must fail here rather than leak billing columns silently.
    const [firstRow] = rows;
    if (firstRow === undefined) throw new Error('expected a summary row');
    expect(Object.keys(firstRow).sort()).toEqual(['id', 'isPersonal', 'name']);
    // BAL-522: `billingEmail` replaced `stripeCustomerId` / `creditBalance` here when those
    // two were dropped — a negative assertion on a column that no longer exists is
    // vacuously green and pins nothing, so the leak guard is retargeted at the LIVE billing
    // column that a widened `select()` would now carry.
    expect(firstRow).not.toHaveProperty('billingEmail');
    expect(firstRow).not.toHaveProperty('domain');
    expect(firstRow).not.toHaveProperty('logoUrl');
  });

  it('short-circuits empty input to [] without touching the DB (an empty inArray is a SQL error)', async () => {
    await expect(companiesRepository.findSummariesByIds([])).resolves.toEqual([]);
  });

  it('skips unknown ids rather than throwing', async () => {
    const known = await companyFactory({ name: 'Known Co' });

    const rows = await companiesRepository.findSummariesByIds([known.id, randomUUID()]);

    expect(rows.map((r) => r.id)).toEqual([known.id]);
  });

  it('orders name asc, then id asc — deterministic for the workspace list', async () => {
    const zulu = await companyFactory({ name: 'Zulu Co' });
    const alpha = await companyFactory({ name: 'Alpha Co' });
    const mike = await companyFactory({ name: 'Mike Co' });

    // Requested in a deliberately unsorted order.
    const rows = await companiesRepository.findSummariesByIds([zulu.id, mike.id, alpha.id]);

    expect(rows.map((r) => r.name)).toEqual(['Alpha Co', 'Mike Co', 'Zulu Co']);
  });

  it('breaks a name tie on id asc', async () => {
    const first = await companyFactory({ name: 'Tie Co' });
    const second = await companyFactory({ name: 'Tie Co' });
    const expected = [first.id, second.id].sort((a, b) => (a < b ? -1 : 1));

    const rows = await companiesRepository.findSummariesByIds([second.id, first.id]);

    expect(rows.map((r) => r.id)).toEqual(expected);
  });

  it('accepts a readonly array (the derivation passes one straight through)', async () => {
    const company = await companyFactory({ name: 'Readonly Co' });
    const ids: readonly string[] = [company.id];

    await expect(companiesRepository.findSummariesByIds(ids)).resolves.toEqual([
      { id: company.id, name: 'Readonly Co', isPersonal: false },
    ]);
  });
});

// ── BAL-522: the company billing email ──────────────────────────────────

/** audit_events rows for one company + action (test-local helper). */
async function billingAuditsFor(
  companyId: string,
  action: string
): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'company'),
        eq(auditEvents.entityId, companyId),
        eq(auditEvents.action, action)
      )
    );
}

/** The raw billing columns of one company, straight from the row. */
async function billingColumnsOf(companyId: string): Promise<{
  billingEmail: string | null;
  billingEmailSource: 'seeded' | 'set' | null;
  billingEmailSetByUserId: string | null;
  billingEmailSetAt: Date | null;
}> {
  const [row] = await db
    .select({
      billingEmail: companies.billingEmail,
      billingEmailSource: companies.billingEmailSource,
      billingEmailSetByUserId: companies.billingEmailSetByUserId,
      billingEmailSetAt: companies.billingEmailSetAt,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  if (row === undefined) throw new Error('expected a company row');
  return row;
}

/** A company plus one member of `role`, the standard fixture for the gate tests. */
async function companyWithMember(
  role: 'owner' | 'admin' | 'member',
  overrides: Parameters<typeof companyFactory>[0] = {}
): Promise<{ companyId: string; userId: string }> {
  const company = await companyFactory({ name: 'Northwind Industrial', ...overrides });
  const user = await userFactory();
  await companyMemberFactory({ companyId: company.id, userId: user.id, role });
  return { companyId: company.id, userId: user.id };
}

describe('companiesRepository.findBillingIdentityById — the PROJECTED billing read (BAL-522)', () => {
  it('projects exactly the seven billing-identity columns, and nothing else from the row', async () => {
    const company = await companyFactory({ name: 'Northwind Industrial', isPersonal: false });

    const row = await companiesRepository.findBillingIdentityById(company.id);

    if (row === undefined) throw new Error('expected a billing-identity row');
    // The key SET is the invariant: this projection feeds a Stripe Customer payload and the
    // billing-settings read, so a widening regression must fail loudly here.
    expect(Object.keys(row).sort()).toEqual([
      'billingEmail',
      'billingEmailSetAt',
      'billingEmailSetByUserId',
      'billingEmailSource',
      'id',
      'isPersonal',
      'name',
    ]);
    expect(row).not.toHaveProperty('domain');
    expect(row).not.toHaveProperty('domainJoinMode');
    expect(row.name).toBe('Northwind Industrial');
    expect(row.isPersonal).toBe(false);
    // Null until seeded — the seed condition.
    expect(row.billingEmail).toBeNull();
    expect(row.billingEmailSource).toBeNull();
    expect(row.billingEmailSetByUserId).toBeNull();
    expect(row.billingEmailSetAt).toBeNull();
  });

  it('returns the seeded value, source and attribution once set', async () => {
    const { companyId, userId } = await companyWithMember('owner');
    await companiesRepository.seedBillingEmail({
      companyId,
      email: 'dana@northwind.test',
      actorUserId: userId,
    });

    const row = await companiesRepository.findBillingIdentityById(companyId);

    expect(row?.billingEmail).toBe('dana@northwind.test');
    expect(row?.billingEmailSource).toBe('seeded');
    expect(row?.billingEmailSetByUserId).toBe(userId);
    expect(row?.billingEmailSetAt).toBeInstanceOf(Date);
  });

  it('returns undefined for an unknown id', async () => {
    await expect(
      companiesRepository.findBillingIdentityById(randomUUID())
    ).resolves.toBeUndefined();
  });
});

describe('companiesRepository.seedBillingEmail (BAL-522)', () => {
  it('seeds value + source + attribution and writes exactly one audit row, in one transaction', async () => {
    const { companyId, userId } = await companyWithMember('owner');

    const result = await companiesRepository.seedBillingEmail({
      companyId,
      email: 'dana@northwind.test',
      actorUserId: userId,
    });

    expect(result.seeded).toBe(true);
    expect(result.billingEmail).toBe('dana@northwind.test');

    const row = await billingColumnsOf(companyId);
    expect(row.billingEmail).toBe('dana@northwind.test');
    expect(row.billingEmailSource).toBe('seeded');
    expect(row.billingEmailSetByUserId).toBe(userId);
    expect(row.billingEmailSetAt).toBeInstanceOf(Date);

    const audits = await billingAuditsFor(companyId, 'company.billing_email_seeded');
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.metadata).toEqual({ email: 'dana@northwind.test', source: 'seeded' });
    // The result's audit id names the row that was actually written (same tx).
    if (!result.seeded) throw new Error('expected a seed');
    expect(result.auditEventId).toBe(audit?.id);
  });

  it('seeds for an admin too — the gate is the capability, not the literal owner role', async () => {
    const { companyId, userId } = await companyWithMember('admin');

    const result = await companiesRepository.seedBillingEmail({
      companyId,
      email: 'admin@northwind.test',
      actorUserId: userId,
    });

    expect(result.seeded).toBe(true);
    await expect(billingColumnsOf(companyId)).resolves.toMatchObject({
      billingEmail: 'admin@northwind.test',
    });
  });

  it('fails closed for a `member`-role actor — no write, no audit', async () => {
    const { companyId, userId } = await companyWithMember('member');

    const result = await companiesRepository.seedBillingEmail({
      companyId,
      email: 'member@northwind.test',
      actorUserId: userId,
    });

    expect(result).toEqual({ seeded: false, reason: 'no_capability', billingEmail: null });
    await expect(billingColumnsOf(companyId)).resolves.toEqual({
      billingEmail: null,
      billingEmailSource: null,
      billingEmailSetByUserId: null,
      billingEmailSetAt: null,
    });
    await expect(billingAuditsFor(companyId, 'company.billing_email_seeded')).resolves.toHaveLength(
      0
    );
  });

  it('fails closed for a SOFT-REMOVED owner membership (getMemberRole filters deleted_at)', async () => {
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const user = await userFactory();
    await companyMemberFactory({
      companyId: company.id,
      userId: user.id,
      role: 'owner',
      deletedAt: new Date(),
    });

    const result = await companiesRepository.seedBillingEmail({
      companyId: company.id,
      email: 'ghost@northwind.test',
      actorUserId: user.id,
    });

    expect(result).toEqual({ seeded: false, reason: 'no_capability', billingEmail: null });
    await expect(billingColumnsOf(company.id)).resolves.toMatchObject({ billingEmail: null });
  });

  it('fails closed for a NON-MEMBER actor — the platform-role case holds no membership', async () => {
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const staffer = await userFactory({ platformRole: 'super_admin' });

    const result = await companiesRepository.seedBillingEmail({
      companyId: company.id,
      email: 'staff@balo.test',
      actorUserId: staffer.id,
    });

    expect(result).toEqual({ seeded: false, reason: 'no_capability', billingEmail: null });
    await expect(billingColumnsOf(company.id)).resolves.toMatchObject({ billingEmail: null });
    await expect(
      billingAuditsFor(company.id, 'company.billing_email_seeded')
    ).resolves.toHaveLength(0);
  });

  it('never overwrites an address that is already set — returns the WINNER value, no audit', async () => {
    const { companyId, userId } = await companyWithMember('owner');
    await companiesRepository.seedBillingEmail({
      companyId,
      email: 'first@northwind.test',
      actorUserId: userId,
    });

    const second = await companiesRepository.seedBillingEmail({
      companyId,
      email: 'second@northwind.test',
      actorUserId: userId,
    });

    // The concurrent-seed loser's path: it gets the winner's address so its Stripe sync
    // still carries one.
    expect(second).toEqual({
      seeded: false,
      reason: 'already_set',
      billingEmail: 'first@northwind.test',
    });
    await expect(billingColumnsOf(companyId)).resolves.toMatchObject({
      billingEmail: 'first@northwind.test',
    });
    // Still exactly the ONE audit row from the winning seed.
    await expect(billingAuditsFor(companyId, 'company.billing_email_seeded')).resolves.toHaveLength(
      1
    );
  });

  it('returns company_not_found for an unknown company id (no throw — the caller is fail-soft)', async () => {
    const user = await userFactory();

    await expect(
      companiesRepository.seedBillingEmail({
        companyId: randomUUID(),
        email: 'nobody@nowhere.test',
        actorUserId: user.id,
      })
    ).resolves.toEqual({ seeded: false, reason: 'company_not_found', billingEmail: null });
  });
});

describe('companiesRepository.setBillingEmail (BAL-522)', () => {
  it('writes value + attribution + audit in ONE transaction and returns the previous state', async () => {
    const { companyId, userId } = await companyWithMember('owner');
    await companiesRepository.seedBillingEmail({
      companyId,
      email: 'seeded@northwind.test',
      actorUserId: userId,
    });
    const seededRow = await billingColumnsOf(companyId);

    const result = await companiesRepository.setBillingEmail({
      companyId,
      billingEmail: 'accounts@northwind.test',
      actorUserId: userId,
    });

    if (result.outcome !== 'changed') throw new Error(`expected changed, got ${result.outcome}`);
    expect(result.billingEmail).toBe('accounts@northwind.test');
    expect(result.previousEmail).toBe('seeded@northwind.test');
    expect(result.previousSource).toBe('seeded');
    expect(result.previousSetAt).toEqual(seededRow.billingEmailSetAt);
    expect(result.company).toEqual({ name: 'Northwind Industrial', isPersonal: false });

    const row = await billingColumnsOf(companyId);
    expect(row.billingEmail).toBe('accounts@northwind.test');
    expect(row.billingEmailSource).toBe('set');
    expect(row.billingEmailSetByUserId).toBe(userId);
    expect(row.billingEmailSetAt).toEqual(result.setAt);

    const audits = await billingAuditsFor(companyId, 'company.billing_email_changed');
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit?.actorUserId).toBe(userId);
    expect(audit?.metadata).toEqual({
      previous_email: 'seeded@northwind.test',
      new_email: 'accounts@northwind.test',
      previous_source: 'seeded',
    });
    expect(result.auditEventId).toBe(audit?.id);
  });

  it('sets a NEVER-seeded company, recording a null previous state', async () => {
    const { companyId, userId } = await companyWithMember('admin');

    const result = await companiesRepository.setBillingEmail({
      companyId,
      billingEmail: 'accounts@northwind.test',
      actorUserId: userId,
    });

    if (result.outcome !== 'changed') throw new Error(`expected changed, got ${result.outcome}`);
    expect(result.previousEmail).toBeNull();
    expect(result.previousSource).toBeNull();
    expect(result.previousSetAt).toBeNull();
    await expect(billingColumnsOf(companyId)).resolves.toMatchObject({
      billingEmail: 'accounts@northwind.test',
      billingEmailSource: 'set',
    });
  });

  it('is forbidden for a `member`-role actor — ZERO writes of either kind', async () => {
    const { companyId, userId } = await companyWithMember('member');

    const result = await companiesRepository.setBillingEmail({
      companyId,
      billingEmail: 'member@northwind.test',
      actorUserId: userId,
    });

    // The gate runs BEFORE any write: the row and the audit log are both untouched.
    expect(result).toEqual({ outcome: 'forbidden' });
    await expect(billingColumnsOf(companyId)).resolves.toEqual({
      billingEmail: null,
      billingEmailSource: null,
      billingEmailSetByUserId: null,
      billingEmailSetAt: null,
    });
    await expect(
      billingAuditsFor(companyId, 'company.billing_email_changed')
    ).resolves.toHaveLength(0);
  });

  it('is forbidden for a SOFT-REMOVED owner — the revoked-membership TOCTOU case', async () => {
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const user = await userFactory();
    await companyMemberFactory({
      companyId: company.id,
      userId: user.id,
      role: 'owner',
      deletedAt: new Date(),
    });

    await expect(
      companiesRepository.setBillingEmail({
        companyId: company.id,
        billingEmail: 'ghost@northwind.test',
        actorUserId: user.id,
      })
    ).resolves.toEqual({ outcome: 'forbidden' });
  });

  it('is a no-op when the value is identical — no write, no audit', async () => {
    const { companyId, userId } = await companyWithMember('owner');
    await companiesRepository.seedBillingEmail({
      companyId,
      email: 'accounts@northwind.test',
      actorUserId: userId,
    });
    const before = await billingColumnsOf(companyId);

    const result = await companiesRepository.setBillingEmail({
      companyId,
      billingEmail: 'accounts@northwind.test',
      actorUserId: userId,
    });

    expect(result).toEqual({
      outcome: 'unchanged',
      company: { name: 'Northwind Industrial', isPersonal: false },
      billingEmail: 'accounts@northwind.test',
      setAt: before.billingEmailSetAt,
    });
    // Source stays `seeded` — an unchanged value must not silently re-attribute the row.
    await expect(billingColumnsOf(companyId)).resolves.toEqual(before);
    await expect(
      billingAuditsFor(companyId, 'company.billing_email_changed')
    ).resolves.toHaveLength(0);
  });

  it('returns not_found for an unknown company id', async () => {
    const user = await userFactory();

    await expect(
      companiesRepository.setBillingEmail({
        companyId: randomUUID(),
        billingEmail: 'nobody@nowhere.test',
        actorUserId: user.id,
      })
    ).resolves.toEqual({ outcome: 'not_found' });
  });

  it('throws on a whitespace-only value — the structural "never blankable" backstop', async () => {
    const { companyId, userId } = await companyWithMember('owner');

    await expect(
      companiesRepository.setBillingEmail({
        companyId,
        billingEmail: '   ',
        actorUserId: userId,
      })
    ).rejects.toThrow(/non-empty/);
    // It throws BEFORE the transaction — nothing was written.
    await expect(billingColumnsOf(companyId)).resolves.toMatchObject({ billingEmail: null });
  });
});

describe('migration 0084 — the billing-email columns and the two drops (BAL-522)', () => {
  /** Column metadata for `companies`, keyed by column name. */
  async function companyColumns(): Promise<Map<string, Record<string, unknown>>> {
    const rows = await db.execute(sql`
      SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'companies'
    `);
    return new Map(rows.map((r) => [String(r.column_name), r]));
  }

  it('creates the billing_email_source enum with exactly {seeded, set}', async () => {
    const rows = await db.execute(sql`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'billing_email_source'
      ORDER BY e.enumsortorder
    `);

    expect(rows.map((r) => String(r.enumlabel))).toEqual(['seeded', 'set']);
  });

  it('adds the four billing columns, all nullable and all WITHOUT a default', async () => {
    const columns = await companyColumns();

    expect(columns.get('billing_email')).toMatchObject({
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
    });
    // The enum column carries NO default — `reference_enum_default_same_tx_migration_hazard`:
    // a default referencing a just-created enum breaks a from-scratch single-tx migration.
    expect(columns.get('billing_email_source')).toMatchObject({
      data_type: 'USER-DEFINED',
      udt_name: 'billing_email_source',
      is_nullable: 'YES',
      column_default: null,
    });
    expect(columns.get('billing_email_set_by_user_id')).toMatchObject({
      data_type: 'uuid',
      is_nullable: 'YES',
    });
    // TIMESTAMPTZ, never a bare timestamp (CLAUDE.md / drizzle-schema).
    expect(columns.get('billing_email_set_at')).toMatchObject({
      data_type: 'timestamp with time zone',
      is_nullable: 'YES',
    });
  });

  it('DROPS credit_balance and stripe_customer_id from companies', async () => {
    const columns = await companyColumns();

    expect(columns.has('credit_balance')).toBe(false);
    expect(columns.has('stripe_customer_id')).toBe(false);
    // Non-vacuity floor: the read really is looking at the companies table.
    expect(columns.has('is_personal')).toBe(true);
  });

  it('indexes the attribution FK column', async () => {
    const rows = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'companies'
        AND indexname = 'companies_billing_email_set_by_user_id_idx'
    `);

    expect(rows).toHaveLength(1);
  });

  it('degrades the attribution to NULL when the attributed user is hard-deleted (ON DELETE SET NULL)', async () => {
    // SET NULL, not RESTRICT: any MANAGE_BILLING holder may set the address, so a user
    // hard-delete must never be blocked by a billing-email attribution. The ADDRESS
    // survives — only the provenance name degrades (to the date-only form).
    const company = await companyFactory({ name: 'Northwind Industrial' });
    const user = await userFactory();
    await db
      .update(companies)
      .set({
        billingEmail: 'accounts@northwind.test',
        billingEmailSource: 'set',
        billingEmailSetByUserId: user.id,
        billingEmailSetAt: new Date(),
      })
      .where(eq(companies.id, company.id));

    await db.delete(users).where(eq(users.id, user.id));

    const row = await billingColumnsOf(company.id);
    expect(row.billingEmail).toBe('accounts@northwind.test');
    expect(row.billingEmailSource).toBe('set');
    expect(row.billingEmailSetByUserId).toBeNull();
    expect(row.billingEmailSetAt).toBeInstanceOf(Date);
  });
});
