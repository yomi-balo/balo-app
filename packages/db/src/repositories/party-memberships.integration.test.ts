import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { companyMembers, agencyMembers, auditEvents } from '../schema';
import {
  userFactory,
  companyFactory,
  companyMemberFactory,
  agencyFactory,
  agencyMemberFactory,
} from '../test/factories';
import { partyMembershipsRepository } from './party-memberships';

/**
 * Integration tests for party-memberships (BAL-345). Uses the in-harness `db`
 * (per-test transaction, auto-rolled-back). Repo methods self-wrap `db.transaction`
 * → SAVEPOINTs inside the outer test tx.
 */

async function auditRowsForEntity(entityId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId));
}

describe('partyMembershipsRepository.getPartyJoinSettings', () => {
  it('returns settings + isPersonal for a company', async () => {
    const company = await companyFactory({
      isPersonal: true,
      domainJoinMode: 'request',
      membershipAuthority: 'directory',
    });
    const settings = await partyMembershipsRepository.getPartyJoinSettings('company', company.id);
    expect(settings).toEqual({
      domainJoinMode: 'request',
      membershipAuthority: 'directory',
      isPersonal: true,
    });
  });

  it('returns isPersonal:false for an agency and reads its mode', async () => {
    const agency = await agencyFactory({ domainJoinMode: 'off' });
    const settings = await partyMembershipsRepository.getPartyJoinSettings('agency', agency.id);
    expect(settings).toEqual({
      domainJoinMode: 'off',
      membershipAuthority: 'balo',
      isPersonal: false,
    });
  });

  it('returns undefined for an absent party (engine must treat as no_match)', async () => {
    await expect(
      partyMembershipsRepository.getPartyJoinSettings('company', randomUUID())
    ).resolves.toBeUndefined();
  });
});

describe('partyMembershipsRepository.findOrCreateDomainMembership', () => {
  it('joins a company as a base member (role member, joinMethod domain_match) + audit', async () => {
    const user = await userFactory();
    const company = await companyFactory();

    const result = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });
    expect(result.outcome).toBe('joined');

    const [row] = await db
      .select()
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, company.id), eq(companyMembers.userId, user.id)));
    if (row === undefined) throw new Error('expected a company membership');
    expect(row.role).toBe('member');
    expect(row.joinMethod).toBe('domain_match');
    expect(row.deletedAt).toBeNull();

    const audits = await auditRowsForEntity(result.membershipId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('party_membership.domain_joined');
    expect(audits[0]?.entityType).toBe('company_member');
    expect(audits[0]?.metadata).toMatchObject({ joinMethod: 'domain_match', userId: user.id });
  });

  it('is idempotent — a repeat returns already_member with no double audit', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const input = {
      partyType: 'company' as const,
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    };

    const first = await partyMembershipsRepository.findOrCreateDomainMembership(input);
    const second = await partyMembershipsRepository.findOrCreateDomainMembership(input);
    expect(second).toEqual({ outcome: 'already_member', membershipId: first.membershipId });

    const audits = await auditRowsForEntity(first.membershipId);
    expect(audits).toHaveLength(1); // no double audit
  });

  it('returns already_member when a personal_workspace membership already exists (any join_method)', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const existing = await companyMemberFactory({
      companyId: company.id,
      userId: user.id,
      role: 'owner',
      joinMethod: 'personal_workspace',
    });

    const result = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });
    expect(result).toEqual({ outcome: 'already_member', membershipId: existing.id });
    // No domain_joined audit was written (the row already existed).
    const audits = await auditRowsForEntity(existing.id);
    expect(audits).toHaveLength(0);
  });

  it('joins an agency as an expert (base role expert)', async () => {
    const user = await userFactory();
    const agency = await agencyFactory();

    const result = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'agency',
      partyId: agency.id,
      userId: user.id,
      actorUserId: user.id,
    });
    expect(result.outcome).toBe('joined');

    const [row] = await db
      .select()
      .from(agencyMembers)
      .where(and(eq(agencyMembers.agencyId, agency.id), eq(agencyMembers.userId, user.id)));
    expect(row?.role).toBe('expert');
    expect(row?.joinMethod).toBe('domain_match');
    const audits = await auditRowsForEntity(result.membershipId);
    expect(audits[0]?.entityType).toBe('agency_member');
  });
});

describe('partyMembershipsRepository.softRemoveDomainMembership', () => {
  it('removes only a domain_match membership + audit', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const joined = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });

    const removed = await partyMembershipsRepository.softRemoveDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });
    expect(removed).toEqual({ outcome: 'removed' });

    const [row] = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.id, joined.membershipId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedByUserId).toBe(user.id);

    const audits = await auditRowsForEntity(joined.membershipId);
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('party_membership.domain_removed');
  });

  it('never removes a personal_workspace membership → not_found, row stays live', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const personal = await companyMemberFactory({
      companyId: company.id,
      userId: user.id,
      role: 'owner',
      joinMethod: 'personal_workspace',
    });

    const result = await partyMembershipsRepository.softRemoveDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });
    expect(result).toEqual({ outcome: 'not_found' });

    const [row] = await db.select().from(companyMembers).where(eq(companyMembers.id, personal.id));
    expect(row?.deletedAt).toBeNull(); // untouched
  });
});

describe('partyMembershipsRepository.getMemberRole', () => {
  it('returns the live role, and undefined once the membership is soft-removed', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const admin = await companyMemberFactory({
      companyId: company.id,
      userId: user.id,
      role: 'admin',
      joinMethod: 'invite',
    });

    await expect(
      partyMembershipsRepository.getMemberRole('company', company.id, user.id)
    ).resolves.toBe('admin');

    // Soft-remove → the seam must deny (undefined), never return 'admin'.
    await db
      .update(companyMembers)
      .set({ deletedAt: new Date(), deletedByUserId: user.id })
      .where(eq(companyMembers.id, admin.id));

    await expect(
      partyMembershipsRepository.getMemberRole('company', company.id, user.id)
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a non-member', async () => {
    const company = await companyFactory();
    await expect(
      partyMembershipsRepository.getMemberRole('company', company.id, randomUUID())
    ).resolves.toBeUndefined();
  });
});

describe('partyMembershipsRepository.listAdminUserIds', () => {
  it('returns only owner/admin (MANAGE_MEMBERS) live members, excluding member + soft-deleted', async () => {
    const company = await companyFactory();
    const owner = await userFactory();
    const adminUser = await userFactory();
    const memberUser = await userFactory();
    const removedAdmin = await userFactory();

    await companyMemberFactory({ companyId: company.id, userId: owner.id, role: 'owner' });
    await companyMemberFactory({ companyId: company.id, userId: adminUser.id, role: 'admin' });
    await companyMemberFactory({
      companyId: company.id,
      userId: memberUser.id,
      role: 'member',
      joinMethod: 'domain_match',
    });
    await companyMemberFactory({
      companyId: company.id,
      userId: removedAdmin.id,
      role: 'admin',
      deletedAt: new Date(),
      deletedByUserId: owner.id,
    });

    const adminIds = await partyMembershipsRepository.listAdminUserIds('company', company.id);
    expect(adminIds.slice().sort()).toEqual([owner.id, adminUser.id].sort());
    expect(adminIds).not.toContain(memberUser.id);
    expect(adminIds).not.toContain(removedAdmin.id);
  });

  it('resolves agency admins (owner/admin), excluding the base expert role', async () => {
    const agency = await agencyFactory();
    const owner = await userFactory();
    const expertUser = await userFactory();
    await agencyMemberFactory({ agencyId: agency.id, userId: owner.id, role: 'owner' });
    await agencyMemberFactory({ agencyId: agency.id, userId: expertUser.id, role: 'expert' });

    const adminIds = await partyMembershipsRepository.listAdminUserIds('agency', agency.id);
    expect(adminIds).toEqual([owner.id]);
  });
});

describe('partyMembershipsRepository.listBillingUserIds (BAL-380 — MANAGE_BILLING fan-out)', () => {
  it('returns only owner/admin (MANAGE_BILLING) live company members, excluding member + soft-removed', async () => {
    const company = await companyFactory();
    const owner = await userFactory();
    const adminUser = await userFactory();
    const memberUser = await userFactory();
    const removedAdmin = await userFactory();

    await companyMemberFactory({ companyId: company.id, userId: owner.id, role: 'owner' });
    await companyMemberFactory({ companyId: company.id, userId: adminUser.id, role: 'admin' });
    await companyMemberFactory({
      companyId: company.id,
      userId: memberUser.id,
      role: 'member',
      joinMethod: 'domain_match',
    });
    await companyMemberFactory({
      companyId: company.id,
      userId: removedAdmin.id,
      role: 'admin',
      deletedAt: new Date(),
      deletedByUserId: owner.id,
    });

    const billingIds = await partyMembershipsRepository.listBillingUserIds(company.id);
    expect(billingIds.slice().sort()).toEqual([owner.id, adminUser.id].sort());
    expect(billingIds).not.toContain(memberUser.id);
    expect(billingIds).not.toContain(removedAdmin.id);
  });

  it('returns [] for a company whose only member holds the base (member) role', async () => {
    const company = await companyFactory();
    const memberUser = await userFactory();
    await companyMemberFactory({
      companyId: company.id,
      userId: memberUser.id,
      role: 'member',
      joinMethod: 'domain_match',
    });

    await expect(partyMembershipsRepository.listBillingUserIds(company.id)).resolves.toEqual([]);
  });

  it('returns [] for an empty company (no members at all → dispatcher skips the fan-out)', async () => {
    const company = await companyFactory();
    await expect(partyMembershipsRepository.listBillingUserIds(company.id)).resolves.toEqual([]);
  });
});
