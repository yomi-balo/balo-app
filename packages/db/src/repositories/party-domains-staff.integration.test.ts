import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, partyDomains } from '../schema';
import {
  agencyFactory,
  agencyMemberFactory,
  companyFactory,
  companyMemberFactory,
  userFactory,
} from '../test/factories';
import { auditEventsRepository } from './audit-events';
import { partyDomainsRepository } from './party-domains';
import { PARTY_DOMAIN_STAFF_AUDIT, partyDomainsStaffRepository } from './party-domains-staff';

/**
 * Integration tests for the Balo-staff domain writers and reads (BAL-594). Runs inside
 * the per-test transaction; the self-wrapping `db.transaction` becomes a savepoint, so a
 * thrown error inside a writer rolls back to it exactly as production rolls back the tx.
 */

const REASON = 'Customer asked support to move it';

afterEach(() => {
  vi.restoreAllMocks();
});

async function liveRows(domain: string): Promise<(typeof partyDomains.$inferSelect)[]> {
  return db
    .select()
    .from(partyDomains)
    .where(and(eq(partyDomains.domain, domain), isNull(partyDomains.deletedAt)));
}

async function auditsFor(
  entityId: string,
  action?: string
): Promise<(typeof auditEvents.$inferSelect)[]> {
  const rows = await db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId));
  return action === undefined ? rows : rows.filter((r) => r.action === action);
}

async function allStaffAudits(): Promise<(typeof auditEvents.$inferSelect)[]> {
  const rows = await db.select().from(auditEvents);
  return rows.filter((r) => r.action.startsWith('party_domain.staff_'));
}

async function seedOwned(
  partyType: 'company' | 'agency',
  partyId: string,
  domain: string,
  actorUserId: string
): Promise<string> {
  const result = await partyDomainsRepository.capture(
    { partyType, partyId, domain, actorUserId },
    db
  );
  expect(result.outcome).toBe('captured');
  const [row] = await liveRows(domain);
  if (row === undefined) throw new Error('seed failed');
  return row.id;
}

describe('partyDomainsStaffRepository.addDomain', () => {
  it('adds a normalised admin_added row with a staff_added audit row carrying the reason', async () => {
    const staff = await userFactory();
    const company = await companyFactory();

    const result = await partyDomainsStaffRepository.addDomain({
      partyType: 'company',
      partyId: company.id,
      domain: ' @ACME.co.nz ',
      actorUserId: staff.id,
      reason: REASON,
    });

    expect(result.outcome).toBe('added');
    const [row] = await liveRows('acme.co.nz');
    if (row === undefined) throw new Error('expected a live row');
    expect(row.source).toBe('admin_added');
    expect(row.createdByUserId).toBe(staff.id);
    if (result.outcome === 'added') expect(result.domainId).toBe(row.id);

    const audits = await auditsFor(row.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe(PARTY_DOMAIN_STAFF_AUDIT.ADDED);
    expect(audits[0]?.actorUserId).toBe(staff.id);
    expect(audits[0]?.metadata).toEqual({
      partyType: 'company',
      partyId: company.id,
      domain: 'acme.co.nz',
      source: 'admin_added',
      reason: REASON,
    });
  });

  it('adds to an agency', async () => {
    const staff = await userFactory();
    const agency = await agencyFactory();
    const result = await partyDomainsStaffRepository.addDomain({
      partyType: 'agency',
      partyId: agency.id,
      domain: 'agency.io',
      actorUserId: staff.id,
      reason: REASON,
    });
    expect(result.outcome).toBe('added');
  });

  it('returns already_on_party when the same party already owns it, writing nothing more', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    await seedOwned('company', company.id, 'dup.com', staff.id);

    const result = await partyDomainsStaffRepository.addDomain({
      partyType: 'company',
      partyId: company.id,
      domain: 'DUP.com',
      actorUserId: staff.id,
      reason: REASON,
    });

    expect(result).toEqual({ outcome: 'already_on_party' });
    await expect(allStaffAudits()).resolves.toHaveLength(0);
  });

  it('returns owned_by_other naming the live owner, writing nothing', async () => {
    const staff = await userFactory();
    const owner = await companyFactory();
    const target = await companyFactory();
    const ownerRowId = await seedOwned('company', owner.id, 'taken.com', staff.id);

    const result = await partyDomainsStaffRepository.addDomain({
      partyType: 'company',
      partyId: target.id,
      domain: 'taken.com',
      actorUserId: staff.id,
      reason: REASON,
    });

    expect(result).toEqual({
      outcome: 'owned_by_other',
      ownerDomainId: ownerRowId,
      ownerPartyType: 'company',
      ownerPartyId: owner.id,
    });
    await expect(liveRows('taken.com')).resolves.toHaveLength(1);
    await expect(allStaffAudits()).resolves.toHaveLength(0);
  });

  it('rejects a blocked domain, an empty domain, a personal workspace and an unknown party', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    const personal = await companyFactory({ isPersonal: true });
    const base = { actorUserId: staff.id, reason: REASON };

    await expect(
      partyDomainsStaffRepository.addDomain({
        ...base,
        partyType: 'company',
        partyId: company.id,
        domain: 'gmail.com',
      })
    ).resolves.toEqual({ outcome: 'blocked_domain' });
    await expect(
      partyDomainsStaffRepository.addDomain({
        ...base,
        partyType: 'company',
        partyId: company.id,
        domain: '   ',
      })
    ).resolves.toEqual({ outcome: 'not_applicable' });
    await expect(
      partyDomainsStaffRepository.addDomain({
        ...base,
        partyType: 'company',
        partyId: personal.id,
        domain: 'personal.com',
      })
    ).resolves.toEqual({ outcome: 'personal_workspace' });
    await expect(
      partyDomainsStaffRepository.addDomain({
        ...base,
        partyType: 'company',
        partyId: randomUUID(),
        domain: 'ghost.com',
      })
    ).resolves.toEqual({ outcome: 'party_not_found' });
    await expect(
      partyDomainsStaffRepository.addDomain({
        ...base,
        partyType: 'agency',
        partyId: randomUUID(),
        domain: 'ghost.com',
      })
    ).resolves.toEqual({ outcome: 'party_not_found' });

    await expect(liveRows('personal.com')).resolves.toHaveLength(0);
    await expect(liveRows('ghost.com')).resolves.toHaveLength(0);
    await expect(allStaffAudits()).resolves.toHaveLength(0);
  });

  it('leaves no row when the audit write rejects', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    vi.spyOn(auditEventsRepository, 'record').mockRejectedValueOnce(new Error('audit down'));

    await expect(
      partyDomainsStaffRepository.addDomain({
        partyType: 'company',
        partyId: company.id,
        domain: 'atomic.com',
        actorUserId: staff.id,
        reason: REASON,
      })
    ).rejects.toThrow('audit down');

    await expect(liveRows('atomic.com')).resolves.toHaveLength(0);
  });

  it('can add a domain a removed row freed', async () => {
    const staff = await userFactory();
    const first = await companyFactory();
    const second = await companyFactory();
    const rowId = await seedOwned('company', first.id, 'reuse.com', staff.id);
    await partyDomainsStaffRepository.removeDomain({
      domainId: rowId,
      partyType: 'company',
      partyId: first.id,
      actorUserId: staff.id,
      reason: REASON,
    });

    const result = await partyDomainsStaffRepository.addDomain({
      partyType: 'company',
      partyId: second.id,
      domain: 'reuse.com',
      actorUserId: staff.id,
      reason: REASON,
    });
    expect(result.outcome).toBe('added');
  });
});

describe('partyDomainsStaffRepository.removeDomain', () => {
  it('soft-deletes the row with the actor and writes a staff_removed audit row with the reason', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    const rowId = await seedOwned('company', company.id, 'bye.com', staff.id);

    const result = await partyDomainsStaffRepository.removeDomain({
      domainId: rowId,
      partyType: 'company',
      partyId: company.id,
      actorUserId: staff.id,
      reason: REASON,
    });

    expect(result).toEqual({ outcome: 'removed', domain: 'bye.com', source: 'auto_captured' });
    await expect(liveRows('bye.com')).resolves.toHaveLength(0);
    const [row] = await db.select().from(partyDomains).where(eq(partyDomains.id, rowId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedByUserId).toBe(staff.id);

    const audits = await auditsFor(rowId, PARTY_DOMAIN_STAFF_AUDIT.REMOVED);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({
      partyType: 'company',
      partyId: company.id,
      domain: 'bye.com',
      source: 'auto_captured',
      reason: REASON,
    });
  });

  it('returns not_found for a wrong party, an unknown id and an already-removed row', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    const other = await companyFactory();
    const rowId = await seedOwned('company', company.id, 'scoped.com', staff.id);
    const base = { actorUserId: staff.id, reason: REASON };

    await expect(
      partyDomainsStaffRepository.removeDomain({
        ...base,
        domainId: rowId,
        partyType: 'company',
        partyId: other.id,
      })
    ).resolves.toEqual({ outcome: 'not_found' });
    await expect(
      partyDomainsStaffRepository.removeDomain({
        ...base,
        domainId: randomUUID(),
        partyType: 'company',
        partyId: company.id,
      })
    ).resolves.toEqual({ outcome: 'not_found' });

    const okInput = {
      ...base,
      domainId: rowId,
      partyType: 'company',
      partyId: company.id,
    } as const;
    await expect(partyDomainsStaffRepository.removeDomain(okInput)).resolves.toMatchObject({
      outcome: 'removed',
    });
    await expect(partyDomainsStaffRepository.removeDomain(okInput)).resolves.toEqual({
      outcome: 'not_found',
    });
    await expect(auditsFor(rowId, PARTY_DOMAIN_STAFF_AUDIT.REMOVED)).resolves.toHaveLength(1);
  });

  it('keeps the row live when the audit write rejects', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    const rowId = await seedOwned('company', company.id, 'keep.com', staff.id);
    vi.spyOn(auditEventsRepository, 'record').mockRejectedValueOnce(new Error('audit down'));

    await expect(
      partyDomainsStaffRepository.removeDomain({
        domainId: rowId,
        partyType: 'company',
        partyId: company.id,
        actorUserId: staff.id,
        reason: REASON,
      })
    ).rejects.toThrow('audit down');

    await expect(liveRows('keep.com')).resolves.toHaveLength(1);
  });
});

describe('partyDomainsStaffRepository.reassignDomain', () => {
  it('moves the domain, writing two audit rows linked by reassignedFrom / reassignedTo', async () => {
    const staff = await userFactory();
    const from = await companyFactory();
    const to = await agencyFactory();
    const oldId = await seedOwned('company', from.id, 'move.com', staff.id);

    const result = await partyDomainsStaffRepository.reassignDomain({
      expected: { domainId: oldId, partyType: 'company', partyId: from.id },
      to: { partyType: 'agency', partyId: to.id },
      actorUserId: staff.id,
      reason: REASON,
    });

    if (result.outcome !== 'reassigned') throw new Error(`unexpected ${result.outcome}`);
    expect(result.removedDomainId).toBe(oldId);
    expect(result.domain).toBe('move.com');
    expect(result.removedSource).toBe('auto_captured');

    const live = await liveRows('move.com');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(result.addedDomainId);
    expect(live[0]?.partyType).toBe('agency');
    expect(live[0]?.partyId).toBe(to.id);
    expect(live[0]?.source).toBe('admin_added');

    const [removedAudit] = await auditsFor(oldId, PARTY_DOMAIN_STAFF_AUDIT.REMOVED);
    expect(removedAudit?.metadata).toEqual({
      partyType: 'company',
      partyId: from.id,
      domain: 'move.com',
      source: 'auto_captured',
      reason: REASON,
      reassignedTo: { partyType: 'agency', partyId: to.id },
    });
    const [addedAudit] = await auditsFor(result.addedDomainId, PARTY_DOMAIN_STAFF_AUDIT.ADDED);
    expect(addedAudit?.metadata).toEqual({
      partyType: 'agency',
      partyId: to.id,
      domain: 'move.com',
      source: 'admin_added',
      reason: REASON,
      reassignedFrom: { partyType: 'company', partyId: from.id },
    });
    await expect(allStaffAudits()).resolves.toHaveLength(2);
  });

  it('returns stale, writing nothing, when the expected party is wrong', async () => {
    const staff = await userFactory();
    const owner = await companyFactory();
    const wrong = await companyFactory();
    const target = await companyFactory();
    const rowId = await seedOwned('company', owner.id, 'wrongowner.com', staff.id);

    const result = await partyDomainsStaffRepository.reassignDomain({
      expected: { domainId: rowId, partyType: 'company', partyId: wrong.id },
      to: { partyType: 'company', partyId: target.id },
      actorUserId: staff.id,
      reason: REASON,
    });

    expect(result).toEqual({ outcome: 'stale' });
    const live = await liveRows('wrongowner.com');
    expect(live).toHaveLength(1);
    expect(live[0]?.partyId).toBe(owner.id);
    await expect(allStaffAudits()).resolves.toHaveLength(0);
  });

  it('returns stale for a removed row and for a second sequential reassign of the same row', async () => {
    const staff = await userFactory();
    const owner = await companyFactory();
    const b = await companyFactory();
    const c = await companyFactory();
    const removedId = await seedOwned('company', owner.id, 'removed.com', staff.id);
    await partyDomainsStaffRepository.removeDomain({
      domainId: removedId,
      partyType: 'company',
      partyId: owner.id,
      actorUserId: staff.id,
      reason: REASON,
    });
    await expect(
      partyDomainsStaffRepository.reassignDomain({
        expected: { domainId: removedId, partyType: 'company', partyId: owner.id },
        to: { partyType: 'company', partyId: b.id },
        actorUserId: staff.id,
        reason: REASON,
      })
    ).resolves.toEqual({ outcome: 'stale' });

    const movedId = await seedOwned('company', owner.id, 'twice.com', staff.id);
    const expected = { domainId: movedId, partyType: 'company', partyId: owner.id } as const;
    await expect(
      partyDomainsStaffRepository.reassignDomain({
        expected,
        to: { partyType: 'company', partyId: b.id },
        actorUserId: staff.id,
        reason: REASON,
      })
    ).resolves.toMatchObject({ outcome: 'reassigned' });
    await expect(
      partyDomainsStaffRepository.reassignDomain({
        expected,
        to: { partyType: 'company', partyId: c.id },
        actorUserId: staff.id,
        reason: REASON,
      })
    ).resolves.toEqual({ outcome: 'stale' });

    const live = await liveRows('twice.com');
    expect(live).toHaveLength(1);
    expect(live[0]?.partyId).toBe(b.id);
  });

  it('rejects same_party, a personal target and a missing target without touching the row', async () => {
    const staff = await userFactory();
    const owner = await companyFactory();
    const personal = await companyFactory({ isPersonal: true });
    const rowId = await seedOwned('company', owner.id, 'stay.com', staff.id);
    const expected = { domainId: rowId, partyType: 'company', partyId: owner.id } as const;
    const base = { expected, actorUserId: staff.id, reason: REASON };

    await expect(
      partyDomainsStaffRepository.reassignDomain({
        ...base,
        to: { partyType: 'company', partyId: owner.id },
      })
    ).resolves.toEqual({ outcome: 'same_party' });
    await expect(
      partyDomainsStaffRepository.reassignDomain({
        ...base,
        to: { partyType: 'company', partyId: personal.id },
      })
    ).resolves.toEqual({ outcome: 'personal_workspace' });
    await expect(
      partyDomainsStaffRepository.reassignDomain({
        ...base,
        to: { partyType: 'agency', partyId: randomUUID() },
      })
    ).resolves.toEqual({ outcome: 'party_not_found' });

    const live = await liveRows('stay.com');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(rowId);
    await expect(allStaffAudits()).resolves.toHaveLength(0);
  });

  it('rolls everything back when the second audit write rejects', async () => {
    const staff = await userFactory();
    const from = await companyFactory();
    const to = await companyFactory();
    const rowId = await seedOwned('company', from.id, 'atomic.io', staff.id);
    const realRecord = auditEventsRepository.record;
    vi.spyOn(auditEventsRepository, 'record')
      .mockImplementationOnce((input, exec) => realRecord(input, exec))
      .mockRejectedValueOnce(new Error('audit down'));

    await expect(
      partyDomainsStaffRepository.reassignDomain({
        expected: { domainId: rowId, partyType: 'company', partyId: from.id },
        to: { partyType: 'company', partyId: to.id },
        actorUserId: staff.id,
        reason: REASON,
      })
    ).rejects.toThrow('audit down');

    const live = await liveRows('atomic.io');
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(rowId);
    expect(live[0]?.partyId).toBe(from.id);
    await expect(allStaffAudits()).resolves.toHaveLength(0);
  });
});

describe('partyDomainsStaffRepository reads', () => {
  it('getPartyForStaff returns name, personal flag and the live member count', async () => {
    const company = await companyFactory({ name: 'Northwind', isPersonal: false });
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const [u1, u2, u3] = await Promise.all([userFactory(), userFactory(), userFactory()]);
    await companyMemberFactory({ companyId: company.id, userId: u1.id, role: 'owner' });
    await companyMemberFactory({ companyId: company.id, userId: u2.id });
    await companyMemberFactory({ companyId: company.id, userId: u3.id, deletedAt: new Date() });
    await agencyMemberFactory({ agencyId: agency.id, userId: u1.id, role: 'owner' });

    await expect(
      partyDomainsStaffRepository.getPartyForStaff('company', company.id)
    ).resolves.toEqual({
      partyType: 'company',
      partyId: company.id,
      name: 'Northwind',
      isPersonal: false,
      memberCount: 2,
    });
    await expect(
      partyDomainsStaffRepository.getPartyForStaff('agency', agency.id)
    ).resolves.toEqual({
      partyType: 'agency',
      partyId: agency.id,
      name: 'CloudPeak',
      isPersonal: false,
      memberCount: 1,
    });
    await expect(
      partyDomainsStaffRepository.getPartyForStaff('company', randomUUID())
    ).resolves.toBeUndefined();
    await expect(
      partyDomainsStaffRepository.getPartyForStaff('agency', randomUUID())
    ).resolves.toBeUndefined();
  });

  it('getPartyForStaff flags a personal company', async () => {
    const personal = await companyFactory({ isPersonal: true });
    const party = await partyDomainsStaffRepository.getPartyForStaff('company', personal.id);
    expect(party?.isPersonal).toBe(true);
    expect(party?.memberCount).toBe(0);
  });

  it('listForStaff labels signup, staff-added and legacy party-admin rows and carries the reason', async () => {
    const signup = await userFactory({ firstName: 'Dana', lastName: 'Lee' });
    const staff = await userFactory({ firstName: 'Sam', lastName: 'Staff' });
    const legacy = await userFactory({ firstName: 'Lou', lastName: 'Legacy' });
    const company = await companyFactory();
    const other = await companyFactory();

    await seedOwned('company', company.id, 'a-signup.com', signup.id);
    await partyDomainsStaffRepository.addDomain({
      partyType: 'company',
      partyId: company.id,
      domain: 'b-staff.com',
      actorUserId: staff.id,
      reason: REASON,
    });
    await seedOwned('company', company.id, 'c-legacy.com', legacy.id);
    await db
      .update(partyDomains)
      .set({ source: 'admin_added' })
      .where(eq(partyDomains.domain, 'c-legacy.com'));
    await seedOwned('company', other.id, 'z-other.com', signup.id);
    const goneId = await seedOwned('company', company.id, 'd-gone.com', signup.id);
    await partyDomainsStaffRepository.removeDomain({
      domainId: goneId,
      partyType: 'company',
      partyId: company.id,
      actorUserId: staff.id,
      reason: REASON,
    });

    // Rows created in one transaction share `now()`; pin the order explicitly.
    for (const [i, domain] of ['a-signup.com', 'b-staff.com', 'c-legacy.com'].entries()) {
      await db
        .update(partyDomains)
        .set({ createdAt: new Date(Date.UTC(2026, i, 1)) })
        .where(eq(partyDomains.domain, domain));
    }

    const rows = await partyDomainsStaffRepository.listForStaff('company', company.id);
    expect(rows.map((r) => [r.domain, r.addedVia, r.reason])).toEqual([
      ['a-signup.com', 'signup', null],
      ['b-staff.com', 'balo', REASON],
      ['c-legacy.com', 'party_admin', null],
    ]);
    expect(rows[0]?.createdBy).toEqual({ firstName: 'Dana', lastName: 'Lee' });
    expect(rows[1]?.createdBy).toEqual({ firstName: 'Sam', lastName: 'Staff' });
    expect(rows[2]?.source).toBe('admin_added');
  });

  it('listForStaff returns [] for a party with no live domains', async () => {
    await expect(partyDomainsStaffRepository.listForStaff('agency', randomUUID())).resolves.toEqual(
      []
    );
  });

  it('findLiveOwnerForStaff resolves the owner with party header, normalising input', async () => {
    const creator = await userFactory({ firstName: 'Dana', lastName: 'Lee' });
    const agency = await agencyFactory({ name: 'CloudPeak' });
    const member = await userFactory();
    await agencyMemberFactory({ agencyId: agency.id, userId: member.id, role: 'owner' });
    const rowId = await seedOwned('agency', agency.id, 'cloudpeak.io', creator.id);

    const owner = await partyDomainsStaffRepository.findLiveOwnerForStaff('@CloudPeak.io');
    expect(owner).toMatchObject({
      domainId: rowId,
      domain: 'cloudpeak.io',
      partyType: 'agency',
      partyId: agency.id,
      partyName: 'CloudPeak',
      memberCount: 1,
      source: 'auto_captured',
      createdBy: { firstName: 'Dana', lastName: 'Lee' },
    });
  });

  it('findLiveOwnerForStaff computes addedVia for signup, staff-added and legacy party-admin rows', async () => {
    const signup = await userFactory();
    const staff = await userFactory();
    const company = await companyFactory();
    await seedOwned('company', company.id, 'own-signup.com', signup.id);
    await partyDomainsStaffRepository.addDomain({
      partyType: 'company',
      partyId: company.id,
      domain: 'own-staff.com',
      actorUserId: staff.id,
      reason: REASON,
    });
    await seedOwned('company', company.id, 'own-legacy.com', signup.id);
    await db
      .update(partyDomains)
      .set({ source: 'admin_added' })
      .where(eq(partyDomains.domain, 'own-legacy.com'));

    const via = async (domain: string): Promise<string | undefined> =>
      (await partyDomainsStaffRepository.findLiveOwnerForStaff(domain))?.addedVia;
    await expect(via('own-signup.com')).resolves.toBe('signup');
    await expect(via('own-staff.com')).resolves.toBe('balo');
    await expect(via('own-legacy.com')).resolves.toBe('party_admin');
  });

  it('findLiveOwnerForStaff is undefined for unowned, removed and empty domains', async () => {
    const staff = await userFactory();
    const company = await companyFactory();
    const rowId = await seedOwned('company', company.id, 'soon-gone.com', staff.id);
    await partyDomainsStaffRepository.removeDomain({
      domainId: rowId,
      partyType: 'company',
      partyId: company.id,
      actorUserId: staff.id,
      reason: REASON,
    });

    await expect(
      partyDomainsStaffRepository.findLiveOwnerForStaff('soon-gone.com')
    ).resolves.toBeUndefined();
    await expect(
      partyDomainsStaffRepository.findLiveOwnerForStaff('nobody.com')
    ).resolves.toBeUndefined();
    await expect(partyDomainsStaffRepository.findLiveOwnerForStaff('  ')).resolves.toBeUndefined();
  });

  it('findLiveOwnerForStaff is undefined when the owning party no longer exists', async () => {
    const staff = await userFactory();
    await db.insert(partyDomains).values({
      partyType: 'agency',
      partyId: randomUUID(),
      domain: 'orphan.com',
      source: 'auto_captured',
      createdByUserId: staff.id,
    });
    await expect(
      partyDomainsStaffRepository.findLiveOwnerForStaff('orphan.com')
    ).resolves.toBeUndefined();
  });
});
