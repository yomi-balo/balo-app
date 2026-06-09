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

    expect(row.id).toBeDefined();
    expect(row.projectRequestId).toBe(request.id);
    expect(row.expertProfileId).toBe(expertId);
    expect(row.invitedByUserId).toBe(admin.id);
    expect(row.status).toBe('invited'); // default
    expect(row.invitedAt).toBeInstanceOf(Date);
    expect(row.declinedAt).toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  it('rejects a duplicate invite for the same (request, expert) — unique index', async () => {
    const { projectRequestId, expertProfileId, invitedByUserId } =
      await requestExpertRelationshipFactory();

    await expect(
      requestExpertRelationshipsRepository.invite({
        projectRequestId,
        expertProfileId,
        invitedByUserId,
      })
    ).rejects.toThrow();
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
