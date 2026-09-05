import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import { auditEvents, proposals, projectRequests, requestExpertRelationships } from '../schema';
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
  type RelationshipStatus,
} from './request-expert-relationships';
import { projectRequestsRepository } from './project-requests';
import { projectsInboxRepository } from './projects-inbox';

/**
 * BAL-540 — `declineTrack`: the client says no to ONE expert, or Balo says it on their behalf.
 *
 * ⚠ THIS PR SHIPS THE FIRST PRODUCTION WRITER OF RELATIONSHIP `declined` AT ALL (resolver O5).
 * `withdraw-eoi` soft-deletes the EOI and `remove-invited-expert` soft-deletes the row —
 * neither transitions status — so every downstream `declined` consequence goes live here and
 * has never run against real data. §5 exercises that sweep deliberately rather than trusting it.
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

// ── §1 — every open stage declines, with full attribution + one audit row ───────────────

describe('declineTrack — §1 declines from every open stage', () => {
  const OPEN_STAGES: RelationshipStatus[] = [
    'invited',
    'eoi_submitted',
    'proposal_requested',
    'proposal_submitted',
  ];

  it.each(OPEN_STAGES)('declines from %s, stamping WHO / WHY / WHEN together', async (from) => {
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory({
      values: { status: from },
    });
    const actorUserId = await seedActorId();

    const result = await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: relationship.id,
      actorUserId,
      reason: 'client_declined',
    });

    expect(result.previousStatus).toBe(from);
    expect(result.relationship.status).toBe('declined');
    expect(result.declineAuditId).toEqual(expect.any(String));
    expect(result.hadOpenProposal).toBe(false);

    const row = await readRelationship(relationship.id);
    expect(row?.status).toBe('declined');
    // ⚠ ALL THREE ATTRIBUTION COLUMNS. Dropping `declinedByUserId` / `declineReason` from the
    // `→ declined` `.set()` turns this red — the house rule that an attribution column ships
    // WITH its writer, made mechanical.
    expect(row?.declinedAt).toBeInstanceOf(Date);
    expect(row?.declinedByUserId).toBe(actorUserId);
    expect(row?.declineReason).toBe('client_declined');

    // Exactly ONE audit row, carrying the full transition and the reason.
    const audits = await declineAudits(relationship.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(actorUserId);
    expect(audits[0]?.entityType).toBe('request_expert_relationship');
    expect(audits[0]?.metadata).toMatchObject({
      projectRequestId,
      from,
      to: 'declined',
      declineReason: 'client_declined',
    });
    // The audit row id IS the notification correlationId — per WRITE, and colon-free so the
    // BullMQ dispatcher (which builds its jobId from the RAW value) accepts it.
    expect(audits[0]?.id).toBe(result.declineAuditId);
    expect(result.declineAuditId).not.toContain(':');
  });

  it('records balo_declined when Balo declines on the client’s behalf', async () => {
    const { relationship } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });

    await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: relationship.id,
      actorUserId: await seedActorId(),
      reason: 'balo_declined',
    });

    expect((await readRelationship(relationship.id))?.declineReason).toBe('balo_declined');
  });
});

// ── §2 — the proposal arm ───────────────────────────────────────────────────────────────

describe('declineTrack — §2 ends the track’s OPEN proposals, and only those', () => {
  it('flips a submitted proposal to declined', async () => {
    const seeded = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });
    const { proposal } = await proposalFactory({
      relationship: seeded,
      values: { status: 'submitted' },
    });

    const result = await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: seeded.relationship.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    expect(result.hadOpenProposal).toBe(true);
    expect(result.declinedProposalIds).toEqual([proposal.id]);

    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    // ⚠ `declined`, NOT `withdrawn`. The CLIENT judged this track and said no. The close
    // cascade writes `withdrawn` for the same rows because there nobody judged anything.
    expect(row?.status).toBe('declined');
  });

  it('leaves a TERMINAL proposal (accepted / withdrawn / resubmitted) untouched', async () => {
    // Seed the track at `proposal_submitted` with a terminal `withdrawn` proposal: it is not
    // in the open set, so the decline must not attempt (and fail) a transition on it.
    const seeded = await requestExpertRelationshipFactory({
      values: { status: 'proposal_submitted' },
    });
    const { proposal } = await proposalFactory({
      relationship: seeded,
      values: { status: 'withdrawn' },
    });

    const result = await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: seeded.relationship.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    expect(result.declinedProposalIds).toEqual([]);
    expect(result.hadOpenProposal).toBe(false);
    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(row?.status).toBe('withdrawn');
  });
});

// ── §3 — the derivation, through the real locked path ───────────────────────────────────

describe('declineTrack — §3 the request follows its furthest LIVE track (D2)', () => {
  it('declining the FURTHEST track LOWERS the request to its furthest live track', async () => {
    // Request at proposal_submitted because expert A got there; expert B is still at
    // eoi_submitted. Declining A must drop the request to eoi_submitted — the kanban
    // requirement, and the behaviour change BAL-540 makes to `deriveRequestStatus`.
    const request = await projectRequestFactory({ status: 'proposal_submitted' });
    const { relationship: furthest } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'proposal_submitted' },
    });
    const behindExpert = await expertDraftFactory();
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: behindExpert.id,
      values: { status: 'eoi_submitted' },
    });

    await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: furthest.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    expect((await projectRequestsRepository.findById(request.id))?.status).toBe('eoi_submitted');
  });

  it('declining a NON-furthest track moves nothing', async () => {
    const request = await projectRequestFactory({ status: 'proposal_submitted' });
    await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'proposal_submitted' },
    });
    const behindExpert = await expertDraftFactory();
    const { relationship: behind } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: behindExpert.id,
      values: { status: 'eoi_submitted' },
    });

    await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: behind.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    expect((await projectRequestsRepository.findById(request.id))?.status).toBe(
      'proposal_submitted'
    );
  });

  it('declining the ONLY track leaves the request where it was (empty contributing set)', async () => {
    // Closing is a separate, deliberate act — a decline never closes a request.
    const request = await projectRequestFactory({ status: 'eoi_submitted' });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'eoi_submitted' },
    });

    await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: relationship.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    const row = await projectRequestsRepository.findById(request.id);
    expect(row?.status).toBe('eoi_submitted');
    expect(row?.closedAt).toBeNull();
  });
});

// ── §4 — refusal from a terminal track ──────────────────────────────────────────────────

describe('declineTrack — §4 refuses a terminal track, writing nothing', () => {
  it.each(['accepted', 'declined'] as const)(
    'refuses from %s with InvalidRelationshipTransitionError',
    async (from) => {
      const { relationship } = await requestExpertRelationshipFactory({
        values: { status: from },
      });

      await expect(
        requestExpertRelationshipsRepository.declineTrack({
          relationshipId: relationship.id,
          actorUserId: await seedActorId(),
          reason: 'client_declined',
        })
      ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

      const row = await readRelationship(relationship.id);
      expect(row?.status).toBe(from);
      // The whole transaction rolled back — no attribution, no audit row.
      expect(row?.declinedByUserId).toBeNull();
      expect(row?.declineReason).toBeNull();
      expect(await declineAudits(relationship.id)).toHaveLength(0);
    }
  );

  it('rolls back the PROPOSAL arm too when the relationship transition is refused', async () => {
    // The proposals are locked FIRST (lock order), so a refusal at step 2 must leave them
    // untouched — proving the whole method really is one transaction.
    const seeded = await requestExpertRelationshipFactory({
      values: { status: 'accepted' },
    });
    const { proposal } = await proposalFactory({
      relationship: seeded,
      values: { status: 'submitted' },
    });

    await expect(
      requestExpertRelationshipsRepository.declineTrack({
        relationshipId: seeded.relationship.id,
        actorUserId: await seedActorId(),
        reason: 'client_declined',
      })
    ).rejects.toBeInstanceOf(InvalidRelationshipTransitionError);

    const [row] = await db.select().from(proposals).where(eq(proposals.id, proposal.id));
    expect(row?.status).toBe('submitted');
  });
});

// ── §5 — the downstream `declined` sweep (O5) ───────────────────────────────────────────

describe('declineTrack — §5 the first-ever `declined` sweep, exercised deliberately', () => {
  it('the expert portfolio drops the track while the request is LIVE…', async () => {
    const { relationship, expertProfileId } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });

    expect(await projectsInboxRepository.listInvitationsByExpert(expertProfileId)).toHaveLength(1);

    await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: relationship.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    expect(await projectsInboxRepository.listInvitationsByExpert(expertProfileId)).toEqual([]);
  });

  it('…but a CLOSED request keeps its declined tracks visible, so the "Closed" group is not empty', async () => {
    // BAL-540's widening of `listInvitationsByExpert`: the close cascade declines every track
    // it closes, so the plain `status <> 'declined'` filter would make the expert's Closed
    // group permanently empty. Reverting that `or(...)` turns this red.
    const request = await projectRequestFactory({ status: 'eoi_submitted' });
    const { relationship, expertProfileId } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'eoi_submitted' },
    });
    expect(relationship.status).toBe('eoi_submitted');

    await projectRequestsRepository.close({
      requestId: request.id,
      actorUserId: await seedActorId(),
      actorKind: 'client',
      reason: 'withdrawn',
      note: null,
    });

    const rows = await projectsInboxRepository.listInvitationsByExpert(expertProfileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestStatus).toBe('closed');
    expect(rows[0]?.relationshipStatus).toBe('declined');
  });

  it('the admin portfolio can EXCLUDE closed requests in SQL', async () => {
    // BAL-540's `excludeStatuses` predicate: the admin kanban must never hydrate a terminal
    // request's whole child graph just to drop it in JavaScript afterwards.
    const live = await projectRequestFactory({ status: 'requested' });
    const doomed = await projectRequestFactory({ status: 'requested' });
    await projectRequestsRepository.close({
      requestId: doomed.id,
      actorUserId: await seedActorId(),
      actorKind: 'client',
      reason: 'withdrawn',
      note: null,
    });

    const all = await projectsInboxRepository.listAll();
    expect(all.map((row) => row.id)).toEqual(expect.arrayContaining([live.id, doomed.id]));

    const boarded = await projectsInboxRepository.listAll({ excludeStatuses: ['closed'] });
    const ids = boarded.map((row) => row.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(doomed.id);
  });

  it('an empty excludeStatuses list is a no-op, not a SQL error', async () => {
    const request = await projectRequestFactory({ status: 'requested' });
    const rows = await projectsInboxRepository.listAll({ excludeStatuses: [] });
    expect(rows.map((row) => row.id)).toContain(request.id);
  });

  it('the declined track’s parent request row still names the request (no cascade delete)', async () => {
    // Defensive: `declined` is a status, never a delete. The row must remain readable so
    // ADR-1048's historical-read (`resolveRequestTrackFileAccess` → `{kind:'closed'}`) has
    // `status` / `declined_at` to key off — that flip is proved as a unit test in
    // `packages/shared`, and this is its data-layer precondition.
    const { relationship, projectRequestId } = await requestExpertRelationshipFactory({
      values: { status: 'eoi_submitted' },
    });
    await requestExpertRelationshipsRepository.declineTrack({
      relationshipId: relationship.id,
      actorUserId: await seedActorId(),
      reason: 'client_declined',
    });

    const row = await readRelationship(relationship.id);
    expect(row?.deletedAt).toBeNull();
    expect(row?.declinedAt).toBeInstanceOf(Date);

    const [request] = await db
      .select()
      .from(projectRequests)
      .where(eq(projectRequests.id, projectRequestId));
    expect(request?.id).toBe(projectRequestId);
  });
});
