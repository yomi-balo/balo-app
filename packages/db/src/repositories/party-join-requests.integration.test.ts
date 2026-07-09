import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { partyJoinRequests, companyMembers, auditEvents } from '../schema';
import { userFactory, companyFactory } from '../test/factories';
import {
  partyJoinRequestsRepository,
  isAllowedJoinRequestTransition,
  InvalidJoinRequestTransitionError,
} from './party-join-requests';

/**
 * Integration tests for party-join-requests (BAL-345). Real PG16, per-test tx
 * rollback. `approve` materialises a company_members row, so tests seed a real
 * company as the party.
 */

async function auditActionsForEntity(entityId: string): Promise<string[]> {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.entityId, entityId));
  return rows.map((r) => r.action);
}

async function seedCompanyAndRequester(): Promise<{ companyId: string; userId: string }> {
  const user = await userFactory();
  const company = await companyFactory();
  return { companyId: company.id, userId: user.id };
}

describe('isAllowedJoinRequestTransition (pure transition map)', () => {
  it('allows pending → approved/declined/withdrawn only', () => {
    expect(isAllowedJoinRequestTransition('pending', 'approved')).toBe(true);
    expect(isAllowedJoinRequestTransition('pending', 'declined')).toBe(true);
    expect(isAllowedJoinRequestTransition('pending', 'withdrawn')).toBe(true);
    expect(isAllowedJoinRequestTransition('pending', 'pending')).toBe(false);
  });

  it('treats approved/declined/withdrawn as terminal', () => {
    for (const from of ['approved', 'declined', 'withdrawn'] as const) {
      for (const to of ['pending', 'approved', 'declined', 'withdrawn'] as const) {
        expect(isAllowedJoinRequestTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('partyJoinRequestsRepository.findOrCreatePending', () => {
  it('creates a pending request + audit', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const result = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });
    expect(result.outcome).toBe('created');
    expect(result.request.status).toBe('pending');
    expect(await auditActionsForEntity(result.request.id)).toContain('party_join_request.created');
  });

  it('is idempotent — a repeat returns already_pending with no double audit', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const input = { partyType: 'company' as const, partyId: companyId, userId };
    const first = await partyJoinRequestsRepository.findOrCreatePending(input);
    const second = await partyJoinRequestsRepository.findOrCreatePending(input);
    expect(second).toEqual({ outcome: 'already_pending', request: first.request });
    expect(await auditActionsForEntity(first.request.id)).toHaveLength(1);
  });

  it('lets a fresh request through after the prior one is declined (terminal is outside the partial index)', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const admin = await userFactory();
    const input = { partyType: 'company' as const, partyId: companyId, userId };

    const first = await partyJoinRequestsRepository.findOrCreatePending(input);
    await partyJoinRequestsRepository.decline({
      requestId: first.request.id,
      actorUserId: admin.id,
    });

    const second = await partyJoinRequestsRepository.findOrCreatePending(input);
    expect(second.outcome).toBe('created');
    expect(second.request.id).not.toBe(first.request.id);
  });

  it('a SOFT-DELETED pending row does not wedge the slot', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const input = { partyType: 'company' as const, partyId: companyId, userId };

    const first = await partyJoinRequestsRepository.findOrCreatePending(input);
    await db
      .update(partyJoinRequests)
      .set({ deletedAt: new Date() })
      .where(eq(partyJoinRequests.id, first.request.id));

    const second = await partyJoinRequestsRepository.findOrCreatePending(input);
    expect(second.outcome).toBe('created');
    expect(second.request.id).not.toBe(first.request.id);
  });
});

describe('partyJoinRequestsRepository.approve', () => {
  it('advances pending → approved AND materialises the membership in one tx (both rows + audits)', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const admin = await userFactory();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });

    const { request, membership } = await partyJoinRequestsRepository.approve({
      requestId: created.request.id,
      actorUserId: admin.id,
    });

    expect(request.status).toBe('approved');
    expect(request.resolvedByUserId).toBe(admin.id);
    expect(request.resolvedAt).not.toBeNull();
    expect(membership.outcome).toBe('joined');

    // The membership row was materialised in the same tx.
    const [member] = await db
      .select()
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)));
    expect(member?.role).toBe('member');
    expect(member?.joinMethod).toBe('domain_match');

    // Both audits present: the request approval + the membership join.
    expect(await auditActionsForEntity(request.id)).toEqual(
      expect.arrayContaining(['party_join_request.created', 'party_join_request.approved'])
    );
    expect(await auditActionsForEntity(membership.membershipId)).toContain(
      'party_membership.domain_joined'
    );
  });

  it('throws InvalidJoinRequestTransitionError when the request is no longer pending', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const admin = await userFactory();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });
    await partyJoinRequestsRepository.decline({
      requestId: created.request.id,
      actorUserId: admin.id,
    });

    await expect(
      partyJoinRequestsRepository.approve({ requestId: created.request.id, actorUserId: admin.id })
    ).rejects.toThrow(InvalidJoinRequestTransitionError);
  });
});

describe('partyJoinRequestsRepository.decline / withdraw', () => {
  it('declines a pending request (+ audit, resolver stamped)', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const admin = await userFactory();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });

    const { request } = await partyJoinRequestsRepository.decline({
      requestId: created.request.id,
      actorUserId: admin.id,
    });
    expect(request.status).toBe('declined');
    expect(request.resolvedByUserId).toBe(admin.id);
    expect(await auditActionsForEntity(request.id)).toContain('party_join_request.declined');
  });

  it('withdraws a pending request by the requester (self) + audit', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });

    const { request } = await partyJoinRequestsRepository.withdraw({
      requestId: created.request.id,
      actorUserId: userId,
    });
    expect(request.status).toBe('withdrawn');
    expect(await auditActionsForEntity(request.id)).toContain('party_join_request.withdrawn');
  });

  it('throws InvalidJoinRequestTransitionError declining an already-withdrawn request', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const admin = await userFactory();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });
    await partyJoinRequestsRepository.withdraw({
      requestId: created.request.id,
      actorUserId: userId,
    });

    await expect(
      partyJoinRequestsRepository.decline({ requestId: created.request.id, actorUserId: admin.id })
    ).rejects.toThrow(InvalidJoinRequestTransitionError);
  });
});

describe('partyJoinRequestsRepository.findById', () => {
  it('returns the live request by id (any status) and undefined for a soft-deleted one', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });

    // Found regardless of status — used by the approve/decline gate to read partyType.
    await expect(partyJoinRequestsRepository.findById(created.request.id)).resolves.toMatchObject({
      id: created.request.id,
      partyType: 'company',
      partyId: companyId,
      userId,
    });

    // Unknown id → undefined.
    await expect(
      partyJoinRequestsRepository.findById('00000000-0000-4000-8000-000000000000')
    ).resolves.toBeUndefined();

    // Soft-deleted → excluded (isNull(deletedAt) filter).
    await db
      .update(partyJoinRequests)
      .set({ deletedAt: new Date() })
      .where(eq(partyJoinRequests.id, created.request.id));
    await expect(partyJoinRequestsRepository.findById(created.request.id)).resolves.toBeUndefined();
  });
});

describe('partyJoinRequestsRepository.findPendingByUserAndParty', () => {
  it('returns the live pending request and undefined once resolved', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });

    await expect(
      partyJoinRequestsRepository.findPendingByUserAndParty('company', companyId, userId)
    ).resolves.toMatchObject({ id: created.request.id });

    await partyJoinRequestsRepository.withdraw({
      requestId: created.request.id,
      actorUserId: userId,
    });

    await expect(
      partyJoinRequestsRepository.findPendingByUserAndParty('company', companyId, userId)
    ).resolves.toBeUndefined();
  });
});

// ── partyJoinRequestsRepository.listPendingByParty (BAL-347 admin queue) ──

describe('partyJoinRequestsRepository.listPendingByParty', () => {
  it('returns only live pending rows for the party, requester hydrated, oldest-first', async () => {
    const company = await companyFactory();
    const otherCompany = await companyFactory();
    const early = await userFactory({ email: 'early@northwind.com', firstName: 'Early' });
    const late = await userFactory({ email: 'late@northwind.com', firstName: 'Late' });
    const declinedUser = await userFactory({ email: 'declined@northwind.com' });
    const otherPartyUser = await userFactory({ email: 'other@acme.com' });
    const admin = await userFactory();

    const earlyReq = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: early.id,
    });
    const lateReq = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: late.id,
    });
    // Force a deterministic createdAt ordering (early before late).
    await db
      .update(partyJoinRequests)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(partyJoinRequests.id, earlyReq.request.id));
    await db
      .update(partyJoinRequests)
      .set({ createdAt: new Date('2020-06-01T00:00:00Z') })
      .where(eq(partyJoinRequests.id, lateReq.request.id));

    // A declined request on the same party must NOT appear.
    const declinedReq = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: declinedUser.id,
    });
    await partyJoinRequestsRepository.decline({
      requestId: declinedReq.request.id,
      actorUserId: admin.id,
    });

    // A pending request on ANOTHER party must NOT appear.
    await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: otherCompany.id,
      userId: otherPartyUser.id,
    });

    const rows = await partyJoinRequestsRepository.listPendingByParty('company', company.id);

    expect(rows.map((r) => r.requester.email)).toEqual([
      'early@northwind.com',
      'late@northwind.com',
    ]);
    const [firstRow] = rows;
    if (firstRow === undefined) throw new Error('expected a pending row');
    expect(firstRow.requester.firstName).toBe('Early');
    expect(firstRow.requester.id).toBe(early.id);
  });

  it('excludes a soft-deleted pending row', async () => {
    const { companyId, userId } = await seedCompanyAndRequester();
    const created = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: companyId,
      userId,
    });
    await db
      .update(partyJoinRequests)
      .set({ deletedAt: new Date() })
      .where(eq(partyJoinRequests.id, created.request.id));

    await expect(
      partyJoinRequestsRepository.listPendingByParty('company', companyId)
    ).resolves.toEqual([]);
  });
});

// ── partyJoinRequestsRepository.listResolvedByParty (BAL-347 history) ─────

describe('partyJoinRequestsRepository.listResolvedByParty', () => {
  it('includes approved/declined/withdrawn, populates the resolver, orders resolved_at DESC', async () => {
    const company = await companyFactory();
    const admin = await userFactory({ firstName: 'Admin', lastName: 'Boss' });
    const approvedUser = await userFactory({ email: 'appr@northwind.com' });
    const declinedUser = await userFactory({ email: 'decl@northwind.com' });
    const withdrawUser = await userFactory({ email: 'wd@northwind.com' });

    const approvedReq = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: approvedUser.id,
    });
    await partyJoinRequestsRepository.approve({
      requestId: approvedReq.request.id,
      actorUserId: admin.id,
    });

    const declinedReq = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: declinedUser.id,
    });
    await partyJoinRequestsRepository.decline({
      requestId: declinedReq.request.id,
      actorUserId: admin.id,
    });

    const withdrawnReq = await partyJoinRequestsRepository.findOrCreatePending({
      partyType: 'company',
      partyId: company.id,
      userId: withdrawUser.id,
    });
    await partyJoinRequestsRepository.withdraw({
      requestId: withdrawnReq.request.id,
      actorUserId: withdrawUser.id,
    });

    // Deterministic resolved_at order: approved (newest) → declined → withdrawn.
    await db
      .update(partyJoinRequests)
      .set({ resolvedAt: new Date('2020-03-03T00:00:00Z') })
      .where(eq(partyJoinRequests.id, approvedReq.request.id));
    await db
      .update(partyJoinRequests)
      .set({ resolvedAt: new Date('2020-02-02T00:00:00Z') })
      .where(eq(partyJoinRequests.id, declinedReq.request.id));
    await db
      .update(partyJoinRequests)
      .set({ resolvedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(partyJoinRequests.id, withdrawnReq.request.id));

    const rows = await partyJoinRequestsRepository.listResolvedByParty('company', company.id);

    expect(rows.map((r) => r.status)).toEqual(['approved', 'declined', 'withdrawn']);
    // The admin resolver is hydrated for the approved row.
    const [approvedRow] = rows;
    if (approvedRow === undefined) throw new Error('expected the approved row');
    expect(approvedRow.requester.email).toBe('appr@northwind.com');
    expect(approvedRow.resolver).toEqual({ firstName: 'Admin', lastName: 'Boss' });
  });

  it('returns a null resolver when resolved_by_user_id is unset (admin later SET NULL)', async () => {
    const company = await companyFactory();
    const requester = await userFactory({ email: 'orphan@northwind.com' });

    // Directly seed a declined row with no resolver (the SET-NULL-after-delete shape).
    const [row] = await db
      .insert(partyJoinRequests)
      .values({
        partyType: 'company',
        partyId: company.id,
        userId: requester.id,
        status: 'declined',
        resolvedByUserId: null,
        resolvedAt: new Date('2020-01-01T00:00:00Z'),
      })
      .returning();
    if (row === undefined) throw new Error('failed to seed the declined row');

    const rows = await partyJoinRequestsRepository.listResolvedByParty('company', company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('declined');
    expect(rows[0]?.resolver).toBeNull();
  });

  it('respects the limit', async () => {
    const company = await companyFactory();
    const admin = await userFactory();

    for (const email of ['a@nw.com', 'b@nw.com', 'c@nw.com']) {
      const user = await userFactory({ email });
      const req = await partyJoinRequestsRepository.findOrCreatePending({
        partyType: 'company',
        partyId: company.id,
        userId: user.id,
      });
      await partyJoinRequestsRepository.decline({
        requestId: req.request.id,
        actorUserId: admin.id,
      });
    }

    const rows = await partyJoinRequestsRepository.listResolvedByParty('company', company.id, 2);
    expect(rows).toHaveLength(2);
  });
});
