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
    expect(row.proposalRequestedAt).toBeNull();
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
    expect(updated.proposalRequestedAt).toBeNull();
  });

  it('derives the parent request status on transition (BAL-295)', async () => {
    // Factory seeds the request at `requested` (default) + relationship `invited`.
    // Advancing the relationship to `eoi_submitted` derives the request rollup.
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory();

    const before = await projectRequestsRepository.findById(projectRequestId);
    expect(before?.status).toBe('requested');

    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'eoi_submitted',
    });

    const after = await projectRequestsRepository.findById(projectRequestId);
    expect(after?.status).toBe('eoi_submitted');
  });

  it('does NOT regress the request when a relationship declines (BAL-295)', async () => {
    // Seed the request already at `eoi_submitted` + relationship `eoi_submitted`,
    // then decline the relationship. The rollup must not drop the request below
    // its current floor (declined contributes nothing).
    const request = await projectRequestFactory({ status: 'eoi_submitted' });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'eoi_submitted' },
    });

    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'declined',
    });

    const after = await projectRequestsRepository.findById(request.id);
    expect(after?.status).toBe('eoi_submitted');
  });

  it('sets declinedAt when transitioning to declined', async () => {
    const { relationship } = await requestExpertRelationshipFactory();

    const updated = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'declined',
    });

    expect(updated.status).toBe('declined');
    expect(updated.declinedAt).toBeInstanceOf(Date);
    // The decline stamp must not touch the proposal-request stamp.
    expect(updated.proposalRequestedAt).toBeNull();
  });

  it('sets proposalRequestedAt when transitioning to proposal_requested', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });

    const updated = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'proposal_requested',
      expectedFrom: 'eoi_submitted',
    });

    expect(updated.status).toBe('proposal_requested');
    expect(updated.proposalRequestedAt).toBeInstanceOf(Date);
    expect(updated.declinedAt).toBeNull();

    // Persisted on disk (not just returned).
    const [raw] = await db
      .select()
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationship.id));
    expect(raw?.proposalRequestedAt).toBeInstanceOf(Date);
  });

  it('advances invited → proposal_requested directly with no expectedFrom (admin full bypass, BAL-315)', async () => {
    // Factory seeds the request at `requested` (default) + relationship `invited`.
    // The admin path passes NO expectedFrom, so the widened transition map permits
    // the direct `invited → proposal_requested` move (no client EOI required).
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory();

    const updated = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'proposal_requested',
    });

    expect(updated.status).toBe('proposal_requested');
    expect(updated.proposalRequestedAt).toBeInstanceOf(Date);
    expect(updated.declinedAt).toBeNull();

    // The parent request rolls up directly to `proposal_requested` (deriveRequestStatus
    // writes the max-progress aggregate; it never has to step through eoi_submitted).
    const after = await projectRequestsRepository.findById(projectRequestId);
    expect(after?.status).toBe('proposal_requested');
  });

  it('rejects proposal_requested from a disallowed source state (proposal_submitted) — BAL-315 bypass is bounded', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });

    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'proposal_requested',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

    // Status untouched on disk.
    const [raw] = await db
      .select()
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationship.id));
    expect(raw?.status).toBe('proposal_submitted');
  });

  it('rejects proposal_requested from a terminal declined source — BAL-315 bypass is bounded', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'declined' },
    });

    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'proposal_requested',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);
  });

  it('rejects a double proposal request (expectedFrom race) without re-stamping', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });

    const first = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'proposal_requested',
      expectedFrom: 'eoi_submitted',
    });

    // Second request (stale tab / double-click): the expectedFrom guard throws
    // and the original stamp survives untouched.
    await expect(
      requestExpertRelationshipsRepository.transitionStatus({
        id: relationship.id,
        to: 'proposal_requested',
        expectedFrom: 'eoi_submitted',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

    const [raw] = await db
      .select()
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.id, relationship.id));
    expect(raw?.status).toBe('proposal_requested');
    expect(raw?.proposalRequestedAt?.getTime()).toBe(first.proposalRequestedAt?.getTime());
  });

  it('preserves proposalRequestedAt across a later transition (the point of the column)', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });

    const requested = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'proposal_requested',
      expectedFrom: 'eoi_submitted',
    });
    if (requested.proposalRequestedAt === null) {
      throw new Error('expected proposal_requested transition to stamp proposalRequestedAt');
    }

    // A later transition overwrites `updatedAt` — the stamp must survive.
    const declined = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'declined',
    });

    expect(declined.status).toBe('declined');
    expect(declined.declinedAt).toBeInstanceOf(Date);
    expect(declined.proposalRequestedAt?.getTime()).toBe(requested.proposalRequestedAt.getTime());
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
