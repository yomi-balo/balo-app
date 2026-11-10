import { describe, it, expect } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  agencyMembers,
  auditEvents,
  companyMembers,
  partyDomains,
  partyJoinRequests,
} from '../schema';
import { agencyFactory, companyFactory, expertDraftFactory, userFactory } from '../test/factories';
import { caseEngagementsRepository } from './case-engagements';
import { expertsRepository } from './experts';
import { partyJoinRepository } from './party-join';
import { partyJoinRequestsRepository } from './party-join-requests';
import { partyMembershipsRepository } from './party-memberships';
import { partyJoinOptoutsRepository } from './party-join-optouts';

/**
 * Integration tests for the escape-hatch orchestrator (BAL-345 §2.6). Verifies
 * the request-vs-auto branch, idempotent no-op, and ATOMICITY (an outer-tx failure
 * rolls back BOTH the removal/withdrawal and the opt-out).
 */

describe('partyJoinRepository.leaveDomainParty — request path', () => {
  it('withdraws a live pending request and records the opt-out', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
    });

    const result = await partyJoinRepository.leaveDomainParty({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
    });
    expect(result).toEqual({ path: 'request', changed: true, soloAgencyId: null });

    // The request is withdrawn (no longer pending) and the opt-out exists.
    await expect(
      partyJoinRequestsRepository.findPendingByUserAndParty('company', company.id, user.id)
    ).resolves.toBeUndefined();
    expect(await partyJoinOptoutsRepository.exists('company', company.id, user.id)).toBe(true);
    // Sanity: the seeded request row is now 'withdrawn'.
    const [row] = await db
      .select({ status: partyJoinRequests.status })
      .from(partyJoinRequests)
      .where(eq(partyJoinRequests.id, created.request.id));
    expect(row?.status).toBe('withdrawn');
  });
});

describe('partyJoinRepository.leaveDomainParty — auto path', () => {
  it('soft-removes the live domain_match membership and records the opt-out', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const joined = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });

    const result = await partyJoinRepository.leaveDomainParty({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
    });
    expect(result).toEqual({ path: 'auto', changed: true, soloAgencyId: null });

    const [member] = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.id, joined.membershipId));
    expect(member?.deletedAt).not.toBeNull();
    expect(await partyJoinOptoutsRepository.exists('company', company.id, user.id)).toBe(true);
  });
});

describe('partyJoinRepository.leaveDomainParty — no-op double submit', () => {
  it('reports changed:false when nothing is pending/joined, but still records the opt-out', async () => {
    const user = await userFactory();
    const company = await companyFactory();

    const result = await partyJoinRepository.leaveDomainParty({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
    });
    expect(result).toEqual({ path: 'auto', changed: false, soloAgencyId: null });
    expect(await partyJoinOptoutsRepository.exists('company', company.id, user.id)).toBe(true);

    // A second submit is still a clean no-op.
    const again = await partyJoinRepository.leaveDomainParty({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
    });
    expect(again).toEqual({ path: 'auto', changed: false, soloAgencyId: null });
  });
});

describe('partyJoinRepository.leaveDomainParty — atomicity', () => {
  it('rolls back BOTH the soft-remove and the opt-out when the surrounding tx throws', async () => {
    const user = await userFactory();
    const company = await companyFactory();
    const joined = await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
      actorUserId: user.id,
    });

    await expect(
      db.transaction(async (tx) => {
        const r = await partyJoinRepository.leaveDomainParty(
          { partyType: 'company', partyId: company.id, userId: user.id },
          tx
        );
        expect(r).toEqual({ path: 'auto', changed: true, soloAgencyId: null });
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    // Neither the removal nor the opt-out survived the rollback.
    const [member] = await db
      .select()
      .from(companyMembers)
      .where(and(eq(companyMembers.id, joined.membershipId)));
    expect(member?.deletedAt).toBeNull();
    expect(await partyJoinOptoutsRepository.exists('company', company.id, user.id)).toBe(false);
  });
});

/** An expert whose profile links agency X and who holds a live `domain_match` membership in X. */
async function seedAgencyLeaver() {
  const agency = await agencyFactory();
  const profile = await expertDraftFactory();
  await expertsRepository.linkAgency(profile.id, agency.id);
  await partyMembershipsRepository.findOrCreateDomainMembership({
    partyType: 'agency',
    partyId: agency.id,
    userId: profile.userId,
    actorUserId: profile.userId,
  });
  return { agency, profile };
}

function leaveAgency(agencyId: string, userId: string) {
  return {
    partyType: 'agency' as const,
    partyId: agencyId,
    userId,
    soloAgencyName: 'Dana Smith',
  };
}

async function agencyCount(): Promise<number> {
  const [row] = await db.select({ total: count() }).from(agencies);
  return row?.total ?? 0;
}

describe('partyJoinRepository.leaveDomainParty — leaving the agency the profile links', () => {
  it('repoints the profile to a fresh agency-of-one owned by the leaver, leaving X untouched', async () => {
    const { agency, profile } = await seedAgencyLeaver();
    const [before] = await db.select().from(agencies).where(eq(agencies.id, agency.id));

    const result = await partyJoinRepository.leaveDomainParty(
      leaveAgency(agency.id, profile.userId)
    );

    expect(result.path).toBe('auto');
    expect(result.changed).toBe(true);
    const soloAgencyId = result.soloAgencyId;
    if (soloAgencyId === null) throw new Error('expected an agency-of-one');
    expect(soloAgencyId).not.toBe(agency.id);

    expect((await expertsRepository.findProfileById(profile.id))?.agencyId).toBe(soloAgencyId);

    const [solo] = await db.select().from(agencies).where(eq(agencies.id, soloAgencyId));
    expect(solo?.name).toBe('Dana Smith');
    const soloMembers = await db
      .select({ userId: agencyMembers.userId, role: agencyMembers.role })
      .from(agencyMembers)
      .where(and(eq(agencyMembers.agencyId, soloAgencyId), isNull(agencyMembers.deletedAt)));
    expect(soloMembers).toEqual([{ userId: profile.userId, role: 'owner' }]);

    const created = await db
      .select({ actorUserId: auditEvents.actorUserId })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agency.created'), eq(auditEvents.entityId, soloAgencyId)));
    expect(created).toEqual([{ actorUserId: profile.userId }]);

    const domains = await db
      .select({ id: partyDomains.id })
      .from(partyDomains)
      .where(eq(partyDomains.partyId, soloAgencyId));
    expect(domains).toEqual([]);

    // The left agency itself is unchanged; only the leaver's membership in it ended.
    const [after] = await db.select().from(agencies).where(eq(agencies.id, agency.id));
    expect(after).toEqual(before);
    const liveInX = await db
      .select({ id: agencyMembers.id })
      .from(agencyMembers)
      .where(
        and(
          eq(agencyMembers.agencyId, agency.id),
          eq(agencyMembers.userId, profile.userId),
          isNull(agencyMembers.deletedAt)
        )
      );
    expect(liveInX).toEqual([]);
  });

  it('pins an engagement created after the leave to the agency-of-one, not X', async () => {
    const { agency, profile } = await seedAgencyLeaver();
    const company = await companyFactory();

    const { soloAgencyId } = await partyJoinRepository.leaveDomainParty(
      leaveAgency(agency.id, profile.userId)
    );
    const created = await caseEngagementsRepository.create({
      companyId: company.id,
      expertProfileId: profile.id,
      title: 'After leaving',
      description: '<p>x</p>',
    });

    expect(soloAgencyId).not.toBeNull();
    expect(created.deliveringAgencyId).toBe(soloAgencyId);
    expect(created.deliveringAgencyId).not.toBe(agency.id);
  });

  it('a double submit creates no second agency', async () => {
    const { agency, profile } = await seedAgencyLeaver();

    const first = await partyJoinRepository.leaveDomainParty(
      leaveAgency(agency.id, profile.userId)
    );
    const afterFirst = await agencyCount();
    const second = await partyJoinRepository.leaveDomainParty(
      leaveAgency(agency.id, profile.userId)
    );

    expect(second).toEqual({ path: 'auto', changed: false, soloAgencyId: null });
    expect(await agencyCount()).toBe(afterFirst);
    expect((await expertsRepository.findProfileById(profile.id))?.agencyId).toBe(
      first.soloAgencyId
    );
  });

  it('creates nothing when the profile already links another agency', async () => {
    const agency = await agencyFactory();
    const elsewhere = await agencyFactory();
    const profile = await expertDraftFactory();
    await expertsRepository.linkAgency(profile.id, elsewhere.id);
    await partyMembershipsRepository.findOrCreateDomainMembership({
      partyType: 'agency',
      partyId: agency.id,
      userId: profile.userId,
      actorUserId: profile.userId,
    });
    const agenciesBefore = await agencyCount();

    const result = await partyJoinRepository.leaveDomainParty(
      leaveAgency(agency.id, profile.userId)
    );

    expect(result).toEqual({ path: 'auto', changed: true, soloAgencyId: null });
    expect(await agencyCount()).toBe(agenciesBefore);
    expect((await expertsRepository.findProfileById(profile.id))?.agencyId).toBe(elsewhere.id);
  });

  it('throws without soloAgencyName and rolls the whole leave back', async () => {
    const { agency, profile } = await seedAgencyLeaver();
    const agenciesBefore = await agencyCount();

    await expect(
      partyJoinRepository.leaveDomainParty({
        partyType: 'agency',
        partyId: agency.id,
        userId: profile.userId,
      })
    ).rejects.toThrow(/soloAgencyName/);

    expect(await agencyCount()).toBe(agenciesBefore);
    expect((await expertsRepository.findProfileById(profile.id))?.agencyId).toBe(agency.id);
    expect(await partyJoinOptoutsRepository.exists('agency', agency.id, profile.userId)).toBe(
      false
    );
  });

  it('rolls back the removal, opt-out, new agency and repoint when the surrounding tx throws', async () => {
    const { agency, profile } = await seedAgencyLeaver();
    const agenciesBefore = await agencyCount();

    await expect(
      db.transaction(async (tx) => {
        const r = await partyJoinRepository.leaveDomainParty(
          leaveAgency(agency.id, profile.userId),
          tx
        );
        expect(r.soloAgencyId).not.toBeNull();
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');

    const live = await db
      .select({ id: agencyMembers.id })
      .from(agencyMembers)
      .where(
        and(
          eq(agencyMembers.agencyId, agency.id),
          eq(agencyMembers.userId, profile.userId),
          isNull(agencyMembers.deletedAt)
        )
      );
    expect(live).toHaveLength(1);
    expect((await expertsRepository.findProfileById(profile.id))?.agencyId).toBe(agency.id);
    expect(await agencyCount()).toBe(agenciesBefore);
    expect(await partyJoinOptoutsRepository.exists('agency', agency.id, profile.userId)).toBe(
      false
    );
  });
});
