import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { requestExpertRelationships } from '../schema';
import {
  userFactory,
  expertDraftFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
} from '../test/factories';
import {
  requestExpertRelationshipsRepository,
  InvalidRelationshipTransitionError,
} from './request-expert-relationships';
import { projectRequestsRepository } from './project-requests';

describe('requestExpertRelationshipsRepository.invite', () => {
  it('creates an invited relationship row', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const admin = await userFactory({ platformRole: 'admin' });
    const expertId = request.expertProfileId;
    if (expertId === null) throw new Error('seeded request has no expert');

    const row = await requestExpertRelationshipsRepository.invite({
      projectRequestId: request.id,
      expertProfileId: expertId,
      invitedByUserId: admin.id,
    });

    expect(row).toBeDefined();
    if (row === undefined) throw new Error('expected invite to create a row');
    expect(row.id).toBeDefined();
    expect(row.projectRequestId).toBe(request.id);
    expect(row.expertProfileId).toBe(expertId);
    expect(row.invitedByUserId).toBe(admin.id);
    expect(row.status).toBe('invited'); // default
    expect(row.invitedAt).toBeInstanceOf(Date);
    expect(row.declinedAt).toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  it('returns undefined for a duplicate LIVE invite (idempotent skip, not a throw)', async () => {
    const { projectRequestId, expertProfileId, invitedByUserId } =
      await requestExpertRelationshipFactory();

    // The partial unique index is the ON CONFLICT arbiter → DO NOTHING → undefined.
    const dup = await requestExpertRelationshipsRepository.invite({
      projectRequestId,
      expertProfileId,
      invitedByUserId,
    });

    expect(dup).toBeUndefined();
  });

  it('re-invites a previously removed (soft-deleted) expert as a fresh live row', async () => {
    const { relationship, projectRequestId, expertProfileId, invitedByUserId } =
      await requestExpertRelationshipFactory();

    // Remove (soft-delete), then invite the same (request, expert) again.
    await requestExpertRelationshipsRepository.softDelete(relationship.id);

    const reinvited = await requestExpertRelationshipsRepository.invite({
      projectRequestId,
      expertProfileId,
      invitedByUserId,
    });

    // A fresh row, not the removed one — the soft-deleted row is outside the
    // partial unique index, so the insert no longer conflicts.
    expect(reinvited).toBeDefined();
    expect(reinvited?.id).not.toBe(relationship.id);
    expect(reinvited?.status).toBe('invited');
    expect(reinvited?.deletedAt).toBeNull();

    // Exactly one LIVE relationship for the pair (the new one).
    const live = await requestExpertRelationshipsRepository.listByRequest(projectRequestId);
    const liveForExpert = live.filter((r) => r.expertProfileId === expertProfileId);
    expect(liveForExpert).toHaveLength(1);
    expect(liveForExpert[0]?.id).toBe(reinvited?.id);
  });

  it('throws on a non-existent projectRequestId (FK)', async () => {
    const expert = await expertDraftFactory();
    const admin = await userFactory({ platformRole: 'admin' });

    await expect(
      requestExpertRelationshipsRepository.invite({
        projectRequestId: randomUUID(),
        expertProfileId: expert.id,
        invitedByUserId: admin.id,
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent expertProfileId (FK)', async () => {
    const request = await projectRequestFactory();
    const admin = await userFactory({ platformRole: 'admin' });

    await expect(
      requestExpertRelationshipsRepository.invite({
        projectRequestId: request.id,
        expertProfileId: randomUUID(),
        invitedByUserId: admin.id,
      })
    ).rejects.toThrow();
  });

  it('throws on a non-existent invitedByUserId (FK)', async () => {
    const request = await projectRequestFactory();
    const expertId = request.expertProfileId;
    if (expertId === null) throw new Error('seeded request has no expert');

    await expect(
      requestExpertRelationshipsRepository.invite({
        projectRequestId: request.id,
        expertProfileId: expertId,
        invitedByUserId: randomUUID(),
      })
    ).rejects.toThrow();
  });
});

describe('requestExpertRelationshipsRepository.findById', () => {
  it('returns a live relationship', async () => {
    const { relationship } = await requestExpertRelationshipFactory();
    const found = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(found?.id).toBe(relationship.id);
  });

  it('returns undefined for a soft-deleted relationship', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { deletedAt: new Date() },
    });
    const found = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(found).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    const found = await requestExpertRelationshipsRepository.findById(randomUUID());
    expect(found).toBeUndefined();
  });
});

describe('requestExpertRelationshipsRepository.softDelete', () => {
  it('sets deletedAt (and touches updatedAt) on a live relationship and returns the row', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    const removed = await requestExpertRelationshipsRepository.softDelete(relationship.id);

    expect(removed).toBeDefined();
    expect(removed?.id).toBe(relationship.id);
    expect(removed?.deletedAt).toBeInstanceOf(Date);

    // Persisted on disk (not just returned).
    const [raw] = await db
      .select()
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationship.id));
    expect(raw?.deletedAt).toBeInstanceOf(Date);
  });

  it('removes the relationship from listByRequest', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    const live = await requestExpertRelationshipFactory({ projectRequestId: request.id });
    const toRemove = await requestExpertRelationshipFactory({ projectRequestId: request.id });

    await requestExpertRelationshipsRepository.softDelete(toRemove.relationship.id);

    const rows = await requestExpertRelationshipsRepository.listByRequest(request.id);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(live.relationship.id);
    expect(ids).not.toContain(toRemove.relationship.id);
  });

  it('removes the relationship from findByIdWithRelations', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });
    if (request.expertProfileId === null) {
      throw new Error('expected a direct request with a target expert');
    }
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId,
    });

    await requestExpertRelationshipsRepository.softDelete(relationship.id);

    const found = await projectRequestsRepository.findByIdWithRelations(request.id);
    expect(found?.relationships).toHaveLength(0);
  });

  it('is idempotent — re-removing an already-removed row returns undefined', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { deletedAt: new Date() },
    });

    const removed = await requestExpertRelationshipsRepository.softDelete(relationship.id);

    expect(removed).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    const removed = await requestExpertRelationshipsRepository.softDelete(randomUUID());

    expect(removed).toBeUndefined();
  });
});

describe('requestExpertRelationshipsRepository.listByRequest', () => {
  it('lists live relationships for a request, newest-invited first, excluding soft-deleted', async () => {
    const request = await projectRequestFactory({ status: 'experts_invited' });

    // Two live experts + one soft-deleted, all under the same request.
    const first = await requestExpertRelationshipFactory({ projectRequestId: request.id });
    const second = await requestExpertRelationshipFactory({ projectRequestId: request.id });
    const deleted = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      values: { deletedAt: new Date() },
    });

    const rows = await requestExpertRelationshipsRepository.listByRequest(request.id);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(first.relationship.id);
    expect(ids).toContain(second.relationship.id);
    expect(ids).not.toContain(deleted.relationship.id);
    // Ordering: descending invitedAt — every row's invitedAt >= the next.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.invitedAt.getTime()).toBeGreaterThanOrEqual(rows[i]!.invitedAt.getTime());
    }
  });
});

describe('requestExpertRelationshipsRepository.transitionStatus', () => {
  it('advances through a legal transition', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    const updated = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'eoi_submitted',
    });

    expect(updated.status).toBe('eoi_submitted');
    expect(updated.declinedAt).toBeNull();
  });

  it('sets declinedAt when transitioning to declined', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    const updated = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'declined',
    });

    expect(updated.status).toBe('declined');
    expect(updated.declinedAt).toBeInstanceOf(Date);
  });

  it('throws InvalidRelationshipTransitionError on an illegal transition, row unchanged', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    await expect(
      // invited → accepted is illegal.
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'accepted',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

    const reloaded = await requestExpertRelationshipsRepository.findById(relationship.id);
    expect(reloaded?.status).toBe('invited');
  });

  it('throws when expectedFrom mismatches', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'eoi_submitted',
        expectedFrom: 'proposal_requested',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);
  });

  it('rejects any out-edge from a terminal status', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'accepted' },
    });

    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'declined',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);
  });

  it('throws for an unknown id', async () => {
    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: randomUUID(),
        to: 'eoi_submitted',
      })
    ).rejects.toThrow();
  });

  it('throws for a soft-deleted relationship', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { deletedAt: new Date() },
    });

    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'eoi_submitted',
      })
    ).rejects.toThrow();

    // Status untouched on disk.
    const [raw] = await db
      .select()
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationship.id));
    expect(raw?.status).toBe('invited');
  });
});
