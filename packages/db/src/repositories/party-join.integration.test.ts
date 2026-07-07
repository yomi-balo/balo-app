import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { companyMembers, partyJoinRequests } from '../schema';
import { userFactory, companyFactory } from '../test/factories';
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
    expect(result).toEqual({ path: 'request', changed: true });

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
    expect(result).toEqual({ path: 'auto', changed: true });

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
    expect(result).toEqual({ path: 'auto', changed: false });
    expect(await partyJoinOptoutsRepository.exists('company', company.id, user.id)).toBe(true);

    // A second submit is still a clean no-op.
    const again = await partyJoinRepository.leaveDomainParty({
      partyType: 'company',
      partyId: company.id,
      userId: user.id,
    });
    expect(again).toEqual({ path: 'auto', changed: false });
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
        expect(r).toEqual({ path: 'auto', changed: true });
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
