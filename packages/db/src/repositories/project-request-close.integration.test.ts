import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import {
  auditEvents,
  consultations,
  creditSessions,
  meetings,
  projectRequests,
  representations,
  requestExpertRelationships,
} from '../schema';
import {
  expertDraftFactory,
  projectRequestFactory,
  representationFactory,
  requestExpertRelationshipFactory,
  userFactory,
} from '../test/factories';
import {
  InvalidStatusTransitionError,
  projectRequestsRepository,
  type CloseRequestResult,
  type ProjectRequestStatus,
} from './project-requests';
import { meetingsRepository } from './meetings';
import { proposalsRepository } from './proposals';
import {
  requestExpertRelationshipsRepository,
  RequestClosedError,
  type RelationshipStatus,
} from './request-expert-relationships';

/**
 * BAL-540 / ADR-1025 Amendment 1 — THE CLOSE CASCADE, end to end against real Postgres.
 *
 * This suite is the stand-in for the coherence CHECK that migration 0085 CANNOT carry:
 * `status = 'closed' ⟺ closed_at IS NOT NULL` names a label added by `ALTER TYPE … ADD VALUE`
 * in that same migration, so it is a documented FOLLOW-UP (orchestrator D6). Until it lands,
 * coherence is the repository path's job and §1 below is what pins it.
 *
 * ⚠ WHAT THIS SUITE STRUCTURALLY CANNOT CATCH, stated so nobody reads a green run as more
 * than it is: the nested-transaction hazard (D4). The harness swaps the base `db` for the
 * outer transaction (`test/setup-integration.ts`), so a `close()` that called
 * `meetingsRepository.cancel` instead of `cancelMeetingTx` would run as a SAVEPOINT and PASS
 * here while taking a second pooled connection in production. That is guarded by
 * `invariants/close-cascade-opens-one-transaction.test.ts` and by review — never by this file.
 * The same harness (`max: 1`, one transaction per test) makes a genuine cascade-vs-advance
 * RACE inexpressible; the lock order is argued by inspection in `close()`'s docblock.
 */

const HOUR_MS = 3_600_000;

/** A window an hour out, matching `meetingFactory`'s default shape. */
function schedule(): { scheduledStart: Date; scheduledEnd: Date } {
  const now = Date.now();
  return { scheduledStart: new Date(now + HOUR_MS), scheduledEnd: new Date(now + 2 * HOUR_MS) };
}

/** The actor every close in this suite is attributed to. */
async function seedActorId(): Promise<string> {
  return (await userFactory({ platformRole: 'admin' })).id;
}

interface Seeded {
  requestId: string;
  companyId: string;
  relationshipId: string;
  expertProfileId: string;
}

/** A live request with ONE relationship at the given pair of statuses. */
async function seedRequestWithTrack(values: {
  requestStatus: ProjectRequestStatus;
  relationshipStatus: RelationshipStatus;
}): Promise<Seeded> {
  const request = await projectRequestFactory({ status: values.requestStatus });
  const { relationship } = await requestExpertRelationshipFactory({
    projectRequestId: request.id,
    expertProfileId: request.expertProfileId ?? undefined,
    values: { status: values.relationshipStatus },
  });
  return {
    requestId: request.id,
    companyId: request.companyId,
    relationshipId: relationship.id,
    expertProfileId: relationship.expertProfileId,
  };
}

/** A second live track on an existing request, for a DISTINCT expert. */
async function addTrack(
  requestId: string,
  status: RelationshipStatus
): Promise<{ relationshipId: string; expertProfileId: string }> {
  const expert = await expertDraftFactory();
  const { relationship } = await requestExpertRelationshipFactory({
    projectRequestId: requestId,
    expertProfileId: expert.id,
    values: { status },
  });
  return { relationshipId: relationship.id, expertProfileId: relationship.expertProfileId };
}

async function closeAsBalo(
  requestId: string,
  note: string | null = 'Client went with an internal team.'
): Promise<CloseRequestResult> {
  return projectRequestsRepository.close({
    requestId,
    actorUserId: await seedActorId(),
    actorKind: 'balo',
    reason: 'unfilled',
    note,
  });
}

async function readRequest(id: string) {
  const [row] = await db.select().from(projectRequests).where(eq(projectRequests.id, id));
  return row;
}

async function readRelationship(id: string) {
  const [row] = await db
    .select()
    .from(requestExpertRelationships)
    .where(eq(requestExpertRelationships.id, id));
  return row;
}

async function readCloseAudit(requestId: string) {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.entityId, requestId), eq(auditEvents.action, 'project_request.closed'))
    );
}

// ── §1 — coherence: the CHECK's stand-in ────────────────────────────────────────────────

describe('close() — §1 coherence: every closable stage sets all four columns', () => {
  const CLOSABLE: ProjectRequestStatus[] = [
    'draft',
    'requested',
    'exploratory_meeting_requested',
    'experts_invited',
    'eoi_submitted',
    'proposal_requested',
    'proposal_submitted',
  ];

  it.each(CLOSABLE)(
    'closes from %s and stamps status/closed_at/closed_by/close_reason',
    async (from) => {
      const request = await projectRequestFactory({ status: from });
      const actorUserId = await seedActorId();

      const result = await projectRequestsRepository.close({
        requestId: request.id,
        actorUserId,
        actorKind: 'balo',
        reason: 'superseded',
        note: 'Replaced by a bigger programme of work.',
      });

      expect(result.previousStatus).toBe(from);

      const row = await readRequest(request.id);
      expect(row?.status).toBe('closed');
      // The coherence biconditional, both halves, on disk.
      expect(row?.closedAt).toBeInstanceOf(Date);
      expect(row?.closedByUserId).toBe(actorUserId);
      expect(row?.closeReason).toBe('superseded');
      expect(row?.closeNote).toBe('Replaced by a bigger programme of work.');
    }
  );

  it('a client-arm close stores a NULL note and the withdrawn reason', async () => {
    const request = await projectRequestFactory({ status: 'requested' });
    await projectRequestsRepository.close({
      requestId: request.id,
      actorUserId: await seedActorId(),
      actorKind: 'client',
      reason: 'withdrawn',
      note: null,
    });

    const row = await readRequest(request.id);
    expect(row?.closeReason).toBe('withdrawn');
    expect(row?.closeNote).toBeNull();
    expect(row?.closedAt).toBeInstanceOf(Date);
  });

  it('throws for a missing request and writes nothing', async () => {
    await expect(
      projectRequestsRepository.close({
        requestId: '00000000-0000-4000-8000-000000000000',
        actorUserId: await seedActorId(),
        actorKind: 'balo',
        reason: 'unfilled',
        note: 'x',
      })
    ).rejects.toThrow(/Project request not found/);
  });
});

// ── §2 — refusal from accepted / kickoff_approved, atomically ───────────────────────────

describe('close() — §2 refuses from accepted and kickoff_approved, changing NOTHING', () => {
  it.each(['accepted', 'kickoff_approved'] as const)(
    'refuses from %s with InvalidStatusTransitionError and leaves the track untouched',
    async (from) => {
      const seeded = await seedRequestWithTrack({
        requestStatus: from,
        relationshipStatus: 'proposal_submitted',
      });

      await expect(closeAsBalo(seeded.requestId)).rejects.toBeInstanceOf(
        InvalidStatusTransitionError
      );

      // ATOMIC REFUSAL — re-read BOTH sides. A cascade that declined the track and then threw
      // would leave the request open with a dead track, which is worse than refusing.
      const request = await readRequest(seeded.requestId);
      expect(request?.status).toBe(from);
      expect(request?.closedAt).toBeNull();
      expect(request?.closeReason).toBeNull();

      const relationship = await readRelationship(seeded.relationshipId);
      expect(relationship?.status).toBe('proposal_submitted');
      expect(relationship?.declinedAt).toBeNull();
      expect(relationship?.declinedByUserId).toBeNull();
      expect(relationship?.declineReason).toBeNull();

      expect(await readCloseAudit(seeded.requestId)).toHaveLength(0);
    }
  );
});

// ── §3 — the track + proposal cascade, and the audit contract ───────────────────────────

describe('close() — §3 declines every live track and withdraws every open proposal', () => {
  it('closes with ZERO tracks: all counts are 0 and the audit row still lands', async () => {
    const request = await projectRequestFactory({ status: 'requested' });

    const result = await closeAsBalo(request.id, null);

    expect(result.declinedTracks).toEqual([]);
    expect(result.withdrawnProposalIds).toEqual([]);
    expect(result.cancelledMeetings).toEqual([]);
    expect(result.revokedRepresentationIds).toEqual([]);

    const [audit] = await readCloseAudit(request.id);
    expect(audit?.metadata).toMatchObject({
      counts: {
        tracksDeclined: 0,
        proposalsWithdrawn: 0,
        meetingsCancelled: 0,
        representationsRevoked: 0,
      },
      hasNote: false,
    });
  });

  it('declines ONE track with full attribution', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    const actorUserId = await seedActorId();

    const result = await projectRequestsRepository.close({
      requestId: seeded.requestId,
      actorUserId,
      actorKind: 'client',
      reason: 'withdrawn',
      note: null,
    });

    expect(result.declinedTracks).toHaveLength(1);
    expect(result.declinedTracks[0]?.relationshipId).toBe(seeded.relationshipId);
    expect(result.declinedTracks[0]?.expertProfileId).toBe(seeded.expertProfileId);
    expect(result.declinedTracks[0]?.previousStatus).toBe('eoi_submitted');
    expect(result.declinedTracks[0]?.declineAuditId).toEqual(expect.any(String));

    const relationship = await readRelationship(seeded.relationshipId);
    expect(relationship?.status).toBe('declined');
    // ⚠ THE THREE ATTRIBUTION COLUMNS, ALL SET, IN ONE STATEMENT. Dropping
    // `declinedByUserId` / `declineReason` from the `→ declined` `.set()` turns this red.
    expect(relationship?.declinedAt).toBeInstanceOf(Date);
    expect(relationship?.declinedByUserId).toBe(actorUserId);
    expect(relationship?.declineReason).toBe('request_closed');
  });

  it('declines N tracks, withdraws a submitted proposal, and the audit counts match', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'proposal_requested',
      relationshipStatus: 'proposal_requested',
    });
    const second = await addTrack(seeded.requestId, 'invited');
    const third = await addTrack(seeded.requestId, 'eoi_submitted');

    // A real, coherent proposal on the first track (also advances it to proposal_submitted).
    const proposal = await proposalsRepository.submit({
      relationshipId: seeded.relationshipId,
      actorUserId: await seedActorId(),
      overview: '<p>Scope.</p>',
      pricingMethod: 'tm',
      priceCents: 0,
      depositCents: 25_000,
      rateCents: 18_000,
      cadence: 'monthly',
    });
    expect(proposal.status).toBe('submitted');

    const result = await closeAsBalo(seeded.requestId);

    expect(result.declinedTracks.map((track) => track.relationshipId).sort()).toEqual(
      [seeded.relationshipId, second.relationshipId, third.relationshipId].sort()
    );
    expect(result.withdrawnProposalIds).toEqual([proposal.id]);

    for (const id of [seeded.relationshipId, second.relationshipId, third.relationshipId]) {
      const relationship = await readRelationship(id);
      expect(relationship?.status).toBe('declined');
      expect(relationship?.declineReason).toBe('request_closed');
    }

    const reloadedProposal = await proposalsRepository.findById(proposal.id);
    // ⚠ `withdrawn`, NOT `declined`. The request ended; nobody judged the proposal. A
    // deliberate per-track decline is what writes `declined` (see declineTrack).
    expect(reloadedProposal?.status).toBe('withdrawn');

    const [audit] = await readCloseAudit(seeded.requestId);
    expect(audit?.metadata).toMatchObject({
      reason: 'unfilled',
      actorKind: 'balo',
      previousStatus: 'proposal_submitted',
      hasNote: true,
      counts: { tracksDeclined: 3, proposalsWithdrawn: 1, meetingsCancelled: 0 },
    });
    // ⚠ THE NOTE TEXT MUST NEVER REACH THE AUDIT ROW — `close_note` is its only home.
    expect(JSON.stringify(audit?.metadata)).not.toContain('internal team');
  });
});

// ── §4/§5 — meetings ────────────────────────────────────────────────────────────────────

describe('close() — §4 cancels both request-grain meeting kinds inside the transaction', () => {
  it('cancels a scheduled project_discovery AND a scheduled request_interaction meeting', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    const second = await addTrack(seeded.requestId, 'invited');

    // `project_discovery` is keyed on the REQUEST; `request_interaction` on the RELATIONSHIP
    // — the two id shapes the batched finder has to unify.
    const discovery = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_discovery', contextId: seeded.requestId }],
    });
    const interaction = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'request_interaction', contextId: second.relationshipId }],
    });

    const result = await closeAsBalo(seeded.requestId);

    expect(result.cancelledMeetings.map((entry) => entry.meetingId).sort()).toEqual(
      [discovery.meeting.id, interaction.meeting.id].sort()
    );
    for (const entry of result.cancelledMeetings) {
      expect(entry.cancelAuditId).toEqual(expect.any(String));
      // Whose availability cache the caller must rebuild post-commit.
      expect(entry.expertProfileId).toEqual(expect.any(String));
    }

    for (const id of [discovery.meeting.id, interaction.meeting.id]) {
      const [meeting] = await db.select().from(meetings).where(eq(meetings.id, id));
      expect(meeting?.status).toBe('cancelled');

      // The availability projection follows in the SAME transaction — a cancelled meeting
      // that still occupied the expert's calendar would be the whole bug.
      const [projection] = await db
        .select()
        .from(consultations)
        .where(eq(consultations.meetingId, id));
      expect(projection?.status).toBe('cancelled');

      // …and the `meeting.cancelled` audit row exists for each.
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, 'meeting.cancelled')));
      expect(rows).toHaveLength(1);
    }
  });

  it('§5 — D1 RESIDUAL: a waiting_for_participants meeting SURVIVES the close', async () => {
    // ⚠ THIS PINS A DELIBERATE RESIDUAL AS A FACT, NOT A BUG. `CANCELLABLE_MEETING_STATUSES`
    // is `['scheduled']` and is NOT widened for the cascade (orchestrator D1): a call somebody
    // has already JOINED is un-cancellable BY STATE, and the lifecycle sweep ends it instead.
    // Widening the CAS to include `waiting_for_participants` turns this red.
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    const joined = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_discovery', contextId: seeded.requestId }],
    });
    await db
      .update(meetings)
      .set({ status: 'waiting_for_participants' })
      .where(eq(meetings.id, joined.meeting.id));

    const result = await closeAsBalo(seeded.requestId);

    expect(result.cancelledMeetings).toEqual([]);
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, joined.meeting.id));
    expect(meeting?.status).toBe('waiting_for_participants');
  });

  it('§6 — the money fan-out is provably EMPTY: no credit session exists for a cancelled request-grain meeting', async () => {
    // ⚠ ASSERTED, NOT ASSUMED. `openCaseSessionBestEffort` early-returns unless
    // `contextType === 'case'` (`apps/api/.../join-meeting.ts`), so a `project_discovery` /
    // `request_interaction` meeting NEVER carries a credit session or a hold — which is what
    // lets the cascade skip hold-release and settlement entirely.
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    const discovery = await meetingsRepository.create({
      ...schedule(),
      contexts: [{ contextType: 'project_discovery', contextId: seeded.requestId }],
    });

    const result = await closeAsBalo(seeded.requestId);
    expect(result.cancelledMeetings).toHaveLength(1);

    const sessions = await db
      .select()
      .from(creditSessions)
      .where(eq(creditSessions.meetingId, discovery.meeting.id));
    expect(sessions).toEqual([]);
  });
});

// ── §7/§8 — terminality ─────────────────────────────────────────────────────────────────

describe('close() — §7/§8 the terminal state is genuinely terminal', () => {
  it('§7 — a relationship advancing AFTER the close leaves the request at closed', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    await closeAsBalo(seeded.requestId);

    // Insert a track DIRECTLY, bypassing `invite()`'s closed-request guard, and advance it.
    // This is the residual the docblock names — the derivation's rule 1 is what contains it.
    const stray = await addTrack(seeded.requestId, 'invited');
    await requestExpertRelationshipsRepository.transitionStatus({
      id: stray.relationshipId,
      to: 'eoi_submitted',
      actorUserId: await seedActorId(),
    });

    const row = await readRequest(seeded.requestId);
    expect(row?.status).toBe('closed');
  });

  it('§7b — invite() REFUSES a closed request', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });
    await closeAsBalo(seeded.requestId);

    const expert = await expertDraftFactory();
    await expect(
      requestExpertRelationshipsRepository.invite({
        projectRequestId: seeded.requestId,
        expertProfileId: expert.id,
        invitedByUserId: await seedActorId(),
      })
    ).rejects.toBeInstanceOf(RequestClosedError);

    const rows = await db
      .select()
      .from(requestExpertRelationships)
      .where(eq(requestExpertRelationships.expertProfileId, expert.id));
    expect(rows).toEqual([]);
  });

  it('§8 — a second close REFUSES and writes exactly one audit row', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    await closeAsBalo(seeded.requestId);

    await expect(closeAsBalo(seeded.requestId)).rejects.toBeInstanceOf(
      InvalidStatusTransitionError
    );

    expect(await readCloseAudit(seeded.requestId)).toHaveLength(1);
  });
});

// ── §9 — representations ────────────────────────────────────────────────────────────────

describe('close() — §9 revokes request-grain representations, and only this tenant’s', () => {
  it('revokes an ACTIVE request-grain grant and leaves an org grant alone', async () => {
    const seeded = await seedRequestWithTrack({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });

    const requestGrant = await representationFactory({
      onBehalfOfCompanyId: seeded.companyId,
      scope: 'request',
      projectRequestId: seeded.requestId,
      capabilities: ['manage_requests'],
    });
    const orgGrant = await representationFactory({
      onBehalfOfCompanyId: seeded.companyId,
      scope: 'org',
    });

    const result = await closeAsBalo(seeded.requestId);

    expect(result.revokedRepresentationIds).toEqual([requestGrant.id]);

    const [revoked] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, requestGrant.id));
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    // ⚠ Revoke is a STATUS transition, never a soft delete.
    expect(revoked?.deletedAt).toBeNull();

    const [untouched] = await db
      .select()
      .from(representations)
      .where(eq(representations.id, orgGrant.id));
    expect(untouched?.status).toBe('active');
  });
});
