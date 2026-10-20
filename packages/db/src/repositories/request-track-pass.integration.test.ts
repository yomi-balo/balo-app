import { describe, it, expect, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  PASSABLE_RELATIONSHIP_STATUSES,
  type PassableRelationshipStatus,
} from '@balo/shared/project-requests';
import { db } from '../client';
import { auditEvents, proposals, requestExpertRelationships } from '../schema';
import {
  expertDraftFactory,
  projectRequestFactory,
  proposalFactory,
  requestExpertRelationshipFactory,
  userFactory,
} from '../test/factories';
import {
  InvalidRelationshipTransitionError,
  requestExpertRelationshipsRepository,
} from './request-expert-relationships';
import { projectRequestsRepository } from './project-requests';
import { projectsInboxRepository } from './projects-inbox';
import { advanceProposalStatus } from './proposals';

// `advanceProposalStatus` stays the REAL implementation by default; wrapping it lets §5 fail the
// LAST write `passTrack` makes and prove the whole transaction rolls back with it.
vi.mock('./proposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proposals')>();
  return { ...actual, advanceProposalStatus: vi.fn(actual.advanceProposalStatus) };
});

/**
 * BAL-604 — `passTrack`: the delivering expert passes on a project. The same locked core as
 * `declineTrack` (`request-track-decline.integration.test.ts`), with three differences pinned
 * here: the reason is `expert_declined`, only the PASSABLE stages are accepted, and an open
 * proposal is `withdrawn` rather than `declined`.
 */

async function seedActorId(): Promise<string> {
  return (await userFactory()).id;
}

async function readRelationship(id: string) {
  const [row] = await db
    .select()
    .from(requestExpertRelationships)
    .where(eq(requestExpertRelationships.id, id));
  return row;
}

async function readProposalStatus(id: string) {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, id));
  return row?.status;
}

async function declineAudits(relationshipId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityId, relationshipId),
        eq(auditEvents.action, 'request_expert_relationship.declined')
      )
    );
}

/** A request whose furthest live track is `proposal_requested`, with a second track behind it. */
async function seedTwoTrackRequest() {
  const request = await projectRequestFactory({ status: 'proposal_requested' });
  const furthestSeed = await requestExpertRelationshipFactory({
    projectRequestId: request.id,
    expertProfileId: request.expertProfileId ?? undefined,
    values: { status: 'proposal_requested' },
  });
  const behindExpert = await expertDraftFactory();
  const { relationship: behind } = await requestExpertRelationshipFactory({
    projectRequestId: request.id,
    expertProfileId: behindExpert.id,
    values: { status: 'eoi_submitted' },
  });
  return { requestId: request.id, furthestSeed, furthest: furthestSeed.relationship, behind };
}

// ── §1 — every passable stage, with full attribution + one audit row ────────────────────

describe('passTrack — §1 passes from every passable stage', () => {
  it.each(PASSABLE_RELATIONSHIP_STATUSES)(
    'passes from %s, stamping WHO / WHY (expert_declined) / WHEN together',
    async (from: PassableRelationshipStatus) => {
      const { relationship, projectRequestId } = await requestExpertRelationshipFactory({
        values: { status: from },
      });
      const actorUserId = await seedActorId();

      const result = await requestExpertRelationshipsRepository.passTrack({
        relationshipId: relationship.id,
        actorUserId,
      });

      expect(result.previousStatus).toBe(from);
      expect(result.relationship.status).toBe('declined');
      expect(result.withdrawnProposalIds).toEqual([]);

      const row = await readRelationship(relationship.id);
      expect(row?.status).toBe('declined');
      expect(row?.declinedAt).toBeInstanceOf(Date);
      expect(row?.declinedByUserId).toBe(actorUserId);
      expect(row?.declineReason).toBe('expert_declined');
      // A pass is a status change, never a delete.
      expect(row?.deletedAt).toBeNull();

      const audits = await declineAudits(relationship.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actorUserId).toBe(actorUserId);
      expect(audits[0]?.entityType).toBe('request_expert_relationship');
      expect(audits[0]?.metadata).toMatchObject({
        projectRequestId,
        from,
        to: 'declined',
        declineReason: 'expert_declined',
      });
      // The audit row id IS the notification correlationId — per WRITE, and colon-free.
      expect(audits[0]?.id).toBe(result.auditId);
      expect(result.auditId).not.toContain(':');
    }
  );
});

// ── §2 — the proposal arm: WITHDRAWN, not declined ──────────────────────────────────────

describe('passTrack — §2 withdraws the track’s OPEN proposals, and only those', () => {
  it('moves a draft proposal to withdrawn', async () => {
    const seeded = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const { proposal } = await proposalFactory({
      relationship: seeded,
      values: { status: 'draft' },
    });

    const result = await requestExpertRelationshipsRepository.passTrack({
      relationshipId: seeded.relationship.id,
      actorUserId: await seedActorId(),
    });

    expect(result.withdrawnProposalIds).toEqual([proposal.id]);
    // ⚠ `withdrawn`, NOT `declined`: nobody on the client side judged this proposal.
    expect(await readProposalStatus(proposal.id)).toBe('withdrawn');
  });

  it('leaves a TERMINAL proposal untouched', async () => {
    const seeded = await requestExpertRelationshipFactory({
      values: { status: 'proposal_requested' },
    });
    const { proposal } = await proposalFactory({
      relationship: seeded,
      values: { status: 'resubmitted' },
    });

    const result = await requestExpertRelationshipsRepository.passTrack({
      relationshipId: seeded.relationship.id,
      actorUserId: await seedActorId(),
    });

    expect(result.withdrawnProposalIds).toEqual([]);
    expect(await readProposalStatus(proposal.id)).toBe('resubmitted');
  });
});

// ── §3 — the derivation, through the real locked path ───────────────────────────────────

describe('passTrack — §3 the request follows its furthest LIVE track', () => {
  it('passing the FURTHEST track lowers the request to its furthest live track', async () => {
    const { requestId, furthest } = await seedTwoTrackRequest();

    await requestExpertRelationshipsRepository.passTrack({
      relationshipId: furthest.id,
      actorUserId: await seedActorId(),
    });

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('eoi_submitted');
  });

  it('passing a NON-furthest track moves nothing', async () => {
    const { requestId, behind } = await seedTwoTrackRequest();

    await requestExpertRelationshipsRepository.passTrack({
      relationshipId: behind.id,
      actorUserId: await seedActorId(),
    });

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe(
      'proposal_requested'
    );
  });
});

// ── §4 — refusal outside the passable stages ────────────────────────────────────────────

describe('passTrack — §4 refuses a non-passable track, writing nothing', () => {
  it.each(['proposal_submitted', 'accepted', 'declined'] as const)(
    'refuses from %s with InvalidRelationshipTransitionError',
    async (from) => {
      const seeded = await requestExpertRelationshipFactory({ values: { status: from } });
      const { proposal } = await proposalFactory({
        relationship: seeded,
        values: { status: 'submitted' },
      });

      await expect(
        requestExpertRelationshipsRepository.passTrack({
          relationshipId: seeded.relationship.id,
          actorUserId: await seedActorId(),
        })
      ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

      const row = await readRelationship(seeded.relationship.id);
      expect(row?.status).toBe(from);
      expect(row?.declinedByUserId).toBeNull();
      expect(row?.declineReason).toBeNull();
      expect(await declineAudits(seeded.relationship.id)).toHaveLength(0);
      expect(await readProposalStatus(proposal.id)).toBe('submitted');
    }
  );

  it('refuses a soft-deleted relationship as not found', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted', deletedAt: new Date() },
    });

    await expect(
      requestExpertRelationshipsRepository.passTrack({
        relationshipId: relationship.id,
        actorUserId: await seedActorId(),
      })
    ).rejects.toThrow('Request expert relationship not found');

    expect((await readRelationship(relationship.id))?.status).toBe('eoi_submitted');
  });
});

// ── §5 — all-or-nothing ─────────────────────────────────────────────────────────────────

describe('passTrack — §5 one transaction', () => {
  it('a failure on the proposal write rolls back the relationship, request and audit row', async () => {
    const { requestId, furthestSeed, furthest } = await seedTwoTrackRequest();
    const { proposal } = await proposalFactory({
      relationship: furthestSeed,
      values: { status: 'draft' },
    });
    vi.mocked(advanceProposalStatus).mockRejectedValueOnce(new Error('proposal write failed'));

    await expect(
      requestExpertRelationshipsRepository.passTrack({
        relationshipId: furthest.id,
        actorUserId: await seedActorId(),
      })
    ).rejects.toThrow('proposal write failed');

    const row = await readRelationship(furthest.id);
    expect(row?.status).toBe('proposal_requested');
    expect(row?.declinedAt).toBeNull();
    expect(row?.declinedByUserId).toBeNull();
    expect(row?.declineReason).toBeNull();
    expect(await declineAudits(furthest.id)).toHaveLength(0);
    // The relationship advance had already lowered the request before the proposal write
    // failed — the rollback must restore it too.
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe(
      'proposal_requested'
    );
    expect(await readProposalStatus(proposal.id)).toBe('draft');
  });
});

// ── §6 — the expert's inbox (AC1) ───────────────────────────────────────────────────────

describe('passTrack — §6 the request leaves the expert’s projects inbox', () => {
  it('drops the track from listInvitationsByExpert while the request is live', async () => {
    const { relationship, expertProfileId } = await requestExpertRelationshipFactory({
      values: { status: 'invited' },
    });
    const before = await projectsInboxRepository.listInvitationsByExpert(expertProfileId);
    expect(before.map((row) => row.relationshipId)).toContain(relationship.id);

    await requestExpertRelationshipsRepository.passTrack({
      relationshipId: relationship.id,
      actorUserId: await seedActorId(),
    });

    const after = await projectsInboxRepository.listInvitationsByExpert(expertProfileId);
    expect(after.map((row) => row.relationshipId)).not.toContain(relationship.id);
  });
});
