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
