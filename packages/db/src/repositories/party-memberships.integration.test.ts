import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { CAPABILITIES, rolesWithCapability } from '@balo/shared/authz';
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

describe('partyMembershipsRepository.listCapabilityEligibleCompanies (BAL-400 D1a)', () => {
  it('returns every LIVE company membership holding CONSUME_CREDITS (owner/admin/member)', async () => {
    const user = await userFactory();
    const owned = await companyFactory({ name: 'Aardvark Pty' });
    const administered = await companyFactory({ name: 'Borealis Ltd' });
    const joined = await companyFactory({ name: 'Cygnet Co' });
    await companyMemberFactory({ companyId: owned.id, userId: user.id, role: 'owner' });
    await companyMemberFactory({ companyId: administered.id, userId: user.id, role: 'admin' });
    await companyMemberFactory({
      companyId: joined.id,
      userId: user.id,
      role: 'member',
      joinMethod: 'domain_match',
    });

    const eligible = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.CONSUME_CREDITS
    );

    // CONSUME_CREDITS is a BASE member capability — the wallet is drawn down by every
    // company member, not only by billing admins.
    expect(eligible.map((c) => c.id)).toEqual([owned.id, administered.id, joined.id]);
  });

  it('projects NAMES ONLY — no billingEmail, no isPersonal, no other company column', async () => {
    const user = await userFactory();
    const company = await companyFactory({ name: 'Narrow Co', logoUrl: 'https://cdn/x.png' });
    await companyMemberFactory({ companyId: company.id, userId: user.id, role: 'owner' });

    const [eligible] = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.CONSUME_CREDITS
    );

    // The `EligibleCompany` shape, exactly. A widened projection is how company internals
    // reach a client-bound picker.
    expect(eligible).toEqual({
      id: company.id,
      name: 'Narrow Co',
      logoUrl: 'https://cdn/x.png',
    });
  });

  it('EXCLUDES a soft-removed membership', async () => {
    const user = await userFactory();
    const owner = await userFactory();
    const live = await companyFactory({ name: 'Live Co' });
    const removed = await companyFactory({ name: 'Removed Co' });
    await companyMemberFactory({ companyId: live.id, userId: user.id, role: 'member' });
    await companyMemberFactory({
      companyId: removed.id,
      userId: user.id,
      role: 'owner',
      deletedAt: new Date(),
      deletedByUserId: owner.id,
    });

    const eligible = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.CONSUME_CREDITS
    );
    expect(eligible.map((c) => c.id)).toEqual([live.id]);
  });

  it('EXCLUDES agency memberships entirely — a wallet is company-scoped', async () => {
    // ⚠ `rolesWithCapability(CONSUME_CREDITS)` genuinely contains the AGENCY-only label
    // `expert` (it shares the base-member bundle). If the intersection with
    // `companyRoleEnum.enumValues` were dropped, this call would raise
    // `22P02 invalid input value for enum company_role` at the database — not return [].
    expect(rolesWithCapability(CAPABILITIES.CONSUME_CREDITS)).toContain('expert');

    const user = await userFactory();
    const agency = await agencyFactory();
    await agencyMemberFactory({ agencyId: agency.id, userId: user.id, role: 'owner' });

    await expect(
      partyMembershipsRepository.listCapabilityEligibleCompanies(
        user.id,
        CAPABILITIES.CONSUME_CREDITS
      )
    ).resolves.toEqual([]);
  });

  it('honours a NARROWER capability — MANAGE_BILLING drops the base member', async () => {
    const user = await userFactory();
    const owned = await companyFactory({ name: 'Owned Co' });
    const joined = await companyFactory({ name: 'Joined Co' });
    await companyMemberFactory({ companyId: owned.id, userId: user.id, role: 'owner' });
    await companyMemberFactory({ companyId: joined.id, userId: user.id, role: 'member' });

    const consume = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.CONSUME_CREDITS
    );
    const billing = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.MANAGE_BILLING
    );

    // The role set is DERIVED from `@balo/shared/authz`, never a hardcoded role literal —
    // so a capability change moves this read without editing it.
    expect(consume.map((c) => c.id).sort()).toEqual([owned.id, joined.id].sort());
    expect(billing.map((c) => c.id)).toEqual([owned.id]);
  });

  it('returns [] for a user with no company memberships at all', async () => {
    const user = await userFactory();
    await expect(
      partyMembershipsRepository.listCapabilityEligibleCompanies(
        user.id,
        CAPABILITIES.CONSUME_CREDITS
      )
    ).resolves.toEqual([]);
  });

  it('is DETERMINISTIC — ordered by name, then id, and stable across calls', async () => {
    const user = await userFactory();
    const a = await companyFactory({ name: 'Same Name' });
    const b = await companyFactory({ name: 'Same Name' });
    const z = await companyFactory({ name: 'Zebra Co' });
    for (const company of [a, b, z]) {
      await companyMemberFactory({ companyId: company.id, userId: user.id, role: 'member' });
    }

    const tiedIds = [a.id, b.id].sort((x, y) => (x < y ? -1 : 1));
    const expected = [...tiedIds, z.id];

    const first = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.CONSUME_CREDITS
    );
    const second = await partyMembershipsRepository.listCapabilityEligibleCompanies(
      user.id,
      CAPABILITIES.CONSUME_CREDITS
    );
    expect(first.map((c) => c.id)).toEqual(expected);
    expect(second.map((c) => c.id)).toEqual(expected);
  });
});
