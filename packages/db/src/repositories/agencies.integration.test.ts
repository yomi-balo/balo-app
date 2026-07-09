import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import { agencyMembers, partyDomains, auditEvents } from '../schema';
import {
  userFactory,
  agencyFactory,
  agencyMemberFactory,
  expertDraftFactory,
} from '../test/factories';
import { agenciesRepository, AgencyDomainCaptureConflictError } from './agencies';
import { expertsRepository } from './experts';
import { partyDomainsRepository } from './party-domains';

/**
 * Integration tests for agenciesRepository (BAL-356 / ADR-1034). Uses the in-harness
 * `db` (per-test transaction, auto-rolled-back). Repo methods self-wrap
 * `db.transaction` → SAVEPOINTs inside the outer test tx, so a `provision`
 * capture-conflict throw rolls back its own savepoint while the outer test tx
 * survives (rollback-isolation assertions rely on this).
 */

async function auditRowsForEntity(entityId: string): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db.select().from(auditEvents).where(eq(auditEvents.entityId, entityId));
}

async function liveOwnerRows(agencyId: string): Promise<(typeof agencyMembers.$inferSelect)[]> {
  return db
    .select()
    .from(agencyMembers)
    .where(
      and(
        eq(agencyMembers.agencyId, agencyId),
        eq(agencyMembers.role, 'owner'),
        isNull(agencyMembers.deletedAt)
      )
    );
}

// ── getSummaryById ──────────────────────────────────────────────────

describe('agenciesRepository.getSummaryById', () => {
  it('returns id/name and counts only LIVE members', async () => {
    const agency = await agencyFactory({ name: 'Acme Consulting' });
    const u1 = await userFactory();
    const u2 = await userFactory();
    const u3 = await userFactory();
    await agencyMemberFactory({ agencyId: agency.id, userId: u1.id, role: 'owner' });
    await agencyMemberFactory({ agencyId: agency.id, userId: u2.id, role: 'expert' });
    // Soft-removed — must NOT be counted.
    await agencyMemberFactory({
      agencyId: agency.id,
      userId: u3.id,
      role: 'expert',
      deletedAt: new Date(),
      deletedByUserId: u1.id,
    });

    const summary = await agenciesRepository.getSummaryById(agency.id);
    expect(summary).toEqual({ id: agency.id, name: 'Acme Consulting', memberCount: 2 });
  });

  it('returns memberCount 0 for an agency with no members', async () => {
    const agency = await agencyFactory();
    const summary = await agenciesRepository.getSummaryById(agency.id);
    expect(summary).toEqual({ id: agency.id, name: agency.name, memberCount: 0 });
  });

  it('returns undefined for an absent agency', async () => {
    await expect(agenciesRepository.getSummaryById(randomUUID())).resolves.toBeUndefined();
  });
});

// ── joinExisting ────────────────────────────────────────────────────

describe('agenciesRepository.joinExisting', () => {
  it('joins fresh: expert membership (role expert, domain_match) + links agencyId + audit', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });
    const agency = await agencyFactory();

    const result = await agenciesRepository.joinExisting({
      agencyId: agency.id,
      userId: user.id,
      expertProfileId: draft.id,
      actorUserId: user.id,
    });

    expect(result.outcome).toBe('joined');
    expect(result.agencyId).toBe(agency.id);

    const [membership] = await db
      .select()
      .from(agencyMembers)
      .where(and(eq(agencyMembers.agencyId, agency.id), eq(agencyMembers.userId, user.id)));
    if (membership === undefined) throw new Error('expected an agency membership');
    expect(membership.role).toBe('expert');
    expect(membership.joinMethod).toBe('domain_match');
    expect(membership.deletedAt).toBeNull();
    expect(membership.id).toBe(result.membershipId);

    const linked = await expertsRepository.findProfileById(draft.id);
    expect(linked?.agencyId).toBe(agency.id);

    const audits = await auditRowsForEntity(result.membershipId);
    expect(audits.map((a) => a.action)).toContain('party_membership.domain_joined');
  });

  it('is idempotent — already_member when a live membership exists, still links agencyId, no double audit', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });
    const agency = await agencyFactory();
    const existing = await agencyMemberFactory({
      agencyId: agency.id,
      userId: user.id,
      role: 'expert',
      joinMethod: 'personal_workspace',
    });

    const result = await agenciesRepository.joinExisting({
      agencyId: agency.id,
      userId: user.id,
      expertProfileId: draft.id,
      actorUserId: user.id,
    });

    expect(result.outcome).toBe('already_member');
    expect(result.membershipId).toBe(existing.id);

    const linked = await expertsRepository.findProfileById(draft.id);
    expect(linked?.agencyId).toBe(agency.id);

    // No domain_joined audit was written (the membership already existed).
    const audits = await auditRowsForEntity(existing.id);
    expect(audits).toHaveLength(0);
  });
});

// ── provision ───────────────────────────────────────────────────────

describe('agenciesRepository.provision', () => {
  it('creates an owner agency, captures the domain, links agencyId + audits', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });

    const result = await agenciesRepository.provision({
      name: 'Provision Corp',
      domain: 'provision-corp.com',
      userId: user.id,
      expertProfileId: draft.id,
      actorUserId: user.id,
    });

    // Owner membership: role owner, joinMethod owner, live.
    const owners = await liveOwnerRows(result.agencyId);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(user.id);
    expect(owners[0]?.joinMethod).toBe('owner');
    expect(owners[0]?.id).toBe(result.ownerMembershipId);

    // party_domains row: partyType agency, source auto_captured.
    const owner = await partyDomainsRepository.findActiveByDomain('provision-corp.com');
    expect(owner?.partyType).toBe('agency');
    expect(owner?.partyId).toBe(result.agencyId);
    expect(owner?.source).toBe('auto_captured');

    // Expert profile linked.
    const linked = await expertsRepository.findProfileById(draft.id);
    expect(linked?.agencyId).toBe(result.agencyId);

    // Audits: agency.created (entityId = agencyId) + party_domain.captured.
    const agencyAudits = await auditRowsForEntity(result.agencyId);
    expect(agencyAudits.map((a) => a.action)).toContain('agency.created');
    if (owner === undefined) throw new Error('expected a captured domain');
    const domainAudits = await auditRowsForEntity(owner.id);
    expect(domainAudits.map((a) => a.action)).toContain('party_domain.captured');
  });

  it('throws AgencyDomainCaptureConflictError and rolls back the whole tx when the domain is already owned', async () => {
    const provisionUser = await userFactory();
    const draft = await expertDraftFactory({ userId: provisionUser.id });

    // A DIFFERENT agency already owns the contested domain.
    const rivalAgency = await agencyFactory();
    const rivalUser = await userFactory();
    const preCapture = await partyDomainsRepository.capture(
      {
        partyType: 'agency',
        partyId: rivalAgency.id,
        domain: 'contested-domain.com',
        actorUserId: rivalUser.id,
        source: 'auto_captured',
      },
      db
    );
    expect(preCapture.outcome).toBe('captured');

    await expect(
      agenciesRepository.provision({
        name: 'Contested Co',
        domain: 'contested-domain.com',
        userId: provisionUser.id,
        expertProfileId: draft.id,
        actorUserId: provisionUser.id,
      })
    ).rejects.toBeInstanceOf(AgencyDomainCaptureConflictError);

    // Rollback: no owner membership for the provisioning user anywhere.
    const strandedOwner = await db
      .select()
      .from(agencyMembers)
      .where(
        and(
          eq(agencyMembers.userId, provisionUser.id),
          eq(agencyMembers.role, 'owner'),
          isNull(agencyMembers.deletedAt)
        )
      );
    expect(strandedOwner).toHaveLength(0);

    // Rollback: the draft was never linked.
    const profile = await expertsRepository.findProfileById(draft.id);
    expect(profile?.agencyId).toBeNull();

    // The domain is still owned by the rival (no new capture persisted).
    const stillOwner = await partyDomainsRepository.findActiveByDomain('contested-domain.com');
    expect(stillOwner?.partyId).toBe(rivalAgency.id);
  });
});

// ── provisionSolo ───────────────────────────────────────────────────

describe('agenciesRepository.provisionSolo', () => {
  it('creates an owner agency and links agencyId WITHOUT capturing a domain', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });

    const result = await agenciesRepository.provisionSolo({
      name: 'Independent Expert',
      userId: user.id,
      expertProfileId: draft.id,
      actorUserId: user.id,
    });

    const owners = await liveOwnerRows(result.agencyId);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(user.id);
    expect(owners[0]?.joinMethod).toBe('owner');

    // NO party_domains row for a solo agency.
    const domainRows = await db
      .select()
      .from(partyDomains)
      .where(eq(partyDomains.partyId, result.agencyId));
    expect(domainRows).toHaveLength(0);

    const linked = await expertsRepository.findProfileById(draft.id);
    expect(linked?.agencyId).toBe(result.agencyId);

    const audits = await auditRowsForEntity(result.agencyId);
    expect(audits.map((a) => a.action)).toContain('agency.created');
  });
});

// ── agency_owner_unique_idx ─────────────────────────────────────────

describe('agency_owner_unique_idx', () => {
  it('rejects a second live owner for the same agency', async () => {
    const agency = await agencyFactory();
    const owner1 = await userFactory();
    const owner2 = await userFactory();
    await agencyMemberFactory({
      agencyId: agency.id,
      userId: owner1.id,
      role: 'owner',
      joinMethod: 'owner',
    });

    // Wrapped in a SAVEPOINT (nested tx) so the unique violation rolls back only
    // this insert, leaving the outer test transaction usable.
    await expect(
      db.transaction((tx) =>
        tx.insert(agencyMembers).values({
          agencyId: agency.id,
          userId: owner2.id,
          role: 'owner',
          joinMethod: 'owner',
        })
      )
    ).rejects.toThrow();

    // Still exactly one live owner.
    expect(await liveOwnerRows(agency.id)).toHaveLength(1);
  });
});

// ── transferOwnership ───────────────────────────────────────────────

describe('agenciesRepository.transferOwnership', () => {
  it('demotes the current owner and promotes the target, leaving exactly one live owner + audit', async () => {
    const agency = await agencyFactory();
    const fromUser = await userFactory();
    const toUser = await userFactory();
    await agencyMemberFactory({
      agencyId: agency.id,
      userId: fromUser.id,
      role: 'owner',
      joinMethod: 'owner',
    });
    await agencyMemberFactory({
      agencyId: agency.id,
      userId: toUser.id,
      role: 'expert',
      joinMethod: 'domain_match',
    });

    await agenciesRepository.transferOwnership({
      agencyId: agency.id,
      fromUserId: fromUser.id,
      toUserId: toUser.id,
      actorUserId: fromUser.id,
    });

    const owners = await liveOwnerRows(agency.id);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(toUser.id);

    const [fromRow] = await db
      .select()
      .from(agencyMembers)
      .where(and(eq(agencyMembers.agencyId, agency.id), eq(agencyMembers.userId, fromUser.id)));
    expect(fromRow?.role).toBe('admin');

    const audits = await auditRowsForEntity(agency.id);
    const transfer = audits.find((a) => a.action === 'agency.ownership_transferred');
    expect(transfer).toBeDefined();
    expect(transfer?.metadata).toMatchObject({
      fromUserId: fromUser.id,
      toUserId: toUser.id,
    });
  });

  it('throws when there is no live owner to demote', async () => {
    const agency = await agencyFactory();
    const someUser = await userFactory();
    const target = await userFactory();
    await agencyMemberFactory({ agencyId: agency.id, userId: target.id, role: 'expert' });

    await expect(
      agenciesRepository.transferOwnership({
        agencyId: agency.id,
        fromUserId: someUser.id,
        toUserId: target.id,
        actorUserId: someUser.id,
      })
    ).rejects.toThrow(/no live owner/i);
  });

  it('throws when the target is not a live member', async () => {
    const agency = await agencyFactory();
    const fromUser = await userFactory();
    await agencyMemberFactory({
      agencyId: agency.id,
      userId: fromUser.id,
      role: 'owner',
      joinMethod: 'owner',
    });

    await expect(
      agenciesRepository.transferOwnership({
        agencyId: agency.id,
        fromUserId: fromUser.id,
        toUserId: randomUUID(),
        actorUserId: fromUser.id,
      })
    ).rejects.toThrow(/no live membership/i);
  });
});
