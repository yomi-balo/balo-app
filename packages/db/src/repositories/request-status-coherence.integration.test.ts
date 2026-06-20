import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { projectRequests } from '../schema';
import {
  expertDraftFactory,
  projectRequestFactory,
  requestExpertRelationshipFactory,
} from '../test/factories';
import { projectRequestsRepository } from './project-requests';
import {
  requestExpertRelationshipsRepository,
  type RelationshipStatus,
} from './request-expert-relationships';
import { proposalsRepository } from './proposals';

/**
 * BAL-295 / ADR-1025 — request-status coherence: `project_requests.status` is a
 * stored, centrally-derived max-progress rollup over its live per-expert
 * relationships, computed by `deriveRequestStatus` inside the locked
 * `advanceRelationshipStatus` path. These tests drive through the REAL repo
 * wrappers (which run the lock + derive) and assert the stored request column.
 */

/** Seed a request with a live relationship for a fresh expert, at the given statuses. */
async function seedRequestWithRelationship(values: {
  requestStatus: 'requested' | 'experts_invited' | 'eoi_submitted' | 'proposal_submitted';
  relationshipStatus: RelationshipStatus;
}): Promise<{ requestId: string; relationshipId: string }> {
  const request = await projectRequestFactory({ status: values.requestStatus });
  const { relationship } = await requestExpertRelationshipFactory({
    projectRequestId: request.id,
    expertProfileId: request.expertProfileId ?? undefined,
    values: { status: values.relationshipStatus },
  });
  return { requestId: request.id, relationshipId: relationship.id };
}

/** Add a second live relationship for a DISTINCT expert on an existing request. */
async function addRelationship(
  requestId: string,
  status: RelationshipStatus
): Promise<{ relationshipId: string }> {
  const expert = await expertDraftFactory();
  const { relationship } = await requestExpertRelationshipFactory({
    projectRequestId: requestId,
    expertProfileId: expert.id,
    values: { status },
  });
  return { relationshipId: relationship.id };
}

describe('request-status coherence — scenario 1: single relationship moves in lockstep', () => {
  it('advances the request alongside the relationship at each stage', async () => {
    // Seed `experts_invited` request + `invited` relationship — the post-invite floor.
    const { requestId, relationshipId } = await seedRequestWithRelationship({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });

    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'eoi_submitted',
    });
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('eoi_submitted');

    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'proposal_requested',
      expectedFrom: 'eoi_submitted',
    });
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe(
      'proposal_requested'
    );

    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'proposal_submitted',
      expectedFrom: 'proposal_requested',
    });
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe(
      'proposal_submitted'
    );

    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'accepted',
      expectedFrom: 'proposal_submitted',
    });
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('accepted');
  });
});

describe('request-status coherence — scenario 2: second relationship does not regress', () => {
  it('a 2nd relationship reaching a stage the request already reflects does not regress or error', async () => {
    // Request already at `eoi_submitted` (expert A submitted); expert B is `invited`.
    const { requestId, relationshipId: relA } = await seedRequestWithRelationship({
      requestStatus: 'eoi_submitted',
      relationshipStatus: 'eoi_submitted',
    });
    expect(relA).toBeDefined();
    const { relationshipId: relB } = await addRelationship(requestId, 'invited');

    // Expert B advances invited → eoi_submitted: the request is ALREADY eoi_submitted,
    // so the rollup keeps it there (no regress, no error).
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relB,
      to: 'eoi_submitted',
    });

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('eoi_submitted');
  });
});

describe('request-status coherence — scenario 3: mixed set derives the max', () => {
  it('one proposal_submitted, one eoi_submitted, one declined ⇒ request proposal_submitted', async () => {
    // Build the graph one transition at a time so each advance flows through the
    // locked derive path.
    const { requestId, relationshipId: relSubmitted } = await seedRequestWithRelationship({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });
    const { relationshipId: relEoi } = await addRelationship(requestId, 'invited');
    const { relationshipId: relDeclined } = await addRelationship(requestId, 'invited');

    // Advance the "winner" all the way to proposal_submitted.
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relSubmitted,
      to: 'eoi_submitted',
    });
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relSubmitted,
      to: 'proposal_requested',
      expectedFrom: 'eoi_submitted',
    });
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relSubmitted,
      to: 'proposal_submitted',
      expectedFrom: 'proposal_requested',
    });

    // Second expert only reaches eoi_submitted; third declines.
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relEoi,
      to: 'eoi_submitted',
    });
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relDeclined,
      to: 'declined',
    });

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe(
      'proposal_submitted'
    );
  });
});

describe('request-status coherence — scenario 4: all declined stays put', () => {
  it('every relationship declined ⇒ request stays experts_invited', async () => {
    const { requestId, relationshipId: relA } = await seedRequestWithRelationship({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });
    const { relationshipId: relB } = await addRelationship(requestId, 'invited');

    await requestExpertRelationshipsRepository.transitionStatus({ id: relA, to: 'declined' });
    await requestExpertRelationshipsRepository.transitionStatus({ id: relB, to: 'declined' });

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('experts_invited');
  });
});

describe('request-status coherence — scenario 5: admin milestones preserved', () => {
  it('a later relationship recompute never clobbers kickoff_approved', async () => {
    // Request manually at the terminal admin milestone; a stray relationship advance
    // must not regress it (never-regress floor).
    const { requestId, relationshipId } = await seedRequestWithRelationship({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });
    // Force the request to kickoff_approved on disk (admin milestone beyond the rollup).
    await projectRequestsRepository.transitionStatus({
      id: requestId,
      to: 'eoi_submitted',
      expectedFrom: 'experts_invited',
    });
    // (transitionStatus is single-step; walk it up to accepted → kickoff_approved.)
    for (const to of [
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'kickoff_approved',
    ] as const) {
      await projectRequestsRepository.transitionStatus({ id: requestId, to });
    }
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('kickoff_approved');

    // A relationship advance now derives at most `eoi_submitted`, far below the floor.
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'eoi_submitted',
    });

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('kickoff_approved');
  });

  it('exploratory_meeting_requested is preserved when an invited relationship recomputes below it', async () => {
    const request = await projectRequestFactory({ status: 'exploratory_meeting_requested' });
    const { relationship } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'invited' },
    });

    // Decline the invited relationship — the rollup yields nothing, so the request
    // must remain at the admin meeting milestone (never regress to a lower floor).
    await requestExpertRelationshipsRepository.transitionStatus({
      id: relationship.id,
      to: 'declined',
    });

    expect((await projectRequestsRepository.findById(request.id))?.status).toBe(
      'exploratory_meeting_requested'
    );
  });
});

/**
 * Scenario 6 — two relationships advancing "concurrently".
 *
 * HARNESS CAVEAT: the db integration harness pins every query to a single
 * connection (`postgres(url, { max: 1 })`) and wraps each test in one outer
 * transaction, so a repository's `db.transaction()` runs as a nested SAVEPOINT on
 * that one connection (see `test/setup-integration.ts`). The two `transitionStatus`
 * calls below therefore SERIALISE rather than truly race. So these assert the
 * derivation OUTCOME — because the rollup re-reads the live sibling statuses AFTER
 * locking the request, the second advance still derives the correct max (no
 * lost update at the data level) regardless of order. Real cross-transaction
 * row-lock contention / deadlock-freedom is argued by inspection in
 * `advanceRelationshipStatus`'s LOCK ORDER block, not empirically reproduced here.
 */
describe('request-status coherence — scenario 6: concurrent advances ⇒ correct max-progress rollup', () => {
  it('two relationships advancing concurrently ⇒ final request status = the max', async () => {
    // Two experts both invited; advance both to eoi_submitted. They serialise on
    // the single-connection harness (see caveat above); the re-read-after-lock in
    // the rollup is what keeps the derived status correct under either order.
    const { requestId, relationshipId: relA } = await seedRequestWithRelationship({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });
    const { relationshipId: relB } = await addRelationship(requestId, 'invited');

    await Promise.all([
      requestExpertRelationshipsRepository.transitionStatus({ id: relA, to: 'eoi_submitted' }),
      requestExpertRelationshipsRepository.transitionStatus({ id: relB, to: 'eoi_submitted' }),
    ]);

    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('eoi_submitted');
  });

  it('asymmetric concurrent advances ⇒ request reflects the furthest-along relationship', async () => {
    // Expert A is at proposal_requested (request reflects that); expert B is invited.
    // A → proposal_submitted, B → eoi_submitted (serialised by the harness — see
    // the caveat above). The final request status is the max (proposal_submitted):
    // B's advance re-reads A's now-committed sibling status and derives the max
    // rather than clobbering it back to eoi_submitted.
    const request = await projectRequestFactory({ status: 'proposal_requested' });
    const { relationship: relAObj } = await requestExpertRelationshipFactory({
      projectRequestId: request.id,
      expertProfileId: request.expertProfileId ?? undefined,
      values: { status: 'proposal_requested' },
    });
    const { relationshipId: relB } = await addRelationship(request.id, 'invited');

    await Promise.all([
      requestExpertRelationshipsRepository.transitionStatus({
        id: relAObj.id,
        to: 'proposal_submitted',
        expectedFrom: 'proposal_requested',
      }),
      requestExpertRelationshipsRepository.transitionStatus({ id: relB, to: 'eoi_submitted' }),
    ]);

    expect((await projectRequestsRepository.findById(request.id))?.status).toBe(
      'proposal_submitted'
    );
  });
});

describe('request-status coherence — via the cross-table repo wrappers', () => {
  it('proposalsRepository.accept advances both the relationship and the request to accepted', async () => {
    const { requestId, relationshipId } = await seedRequestWithRelationship({
      requestStatus: 'proposal_requested',
      relationshipStatus: 'proposal_requested',
    });
    // A coherent header-only tm submit advances rel → proposal_submitted (and the
    // request derives proposal_submitted).
    const proposal = await proposalsRepository.submit({
      relationshipId,
      overview: '<p>Scope.</p>',
      pricingMethod: 'tm',
      priceCents: 0,
      depositCents: 25_000,
      rateCents: 18_000,
      cadence: 'monthly',
    });
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe(
      'proposal_submitted'
    );

    await proposalsRepository.accept({ id: proposal.id });
    expect((await projectRequestsRepository.findById(requestId))?.status).toBe('accepted');
  });
});

describe('request-status coherence — defensive: missing/soft-deleted request', () => {
  it('skips the rollup (relationship advance still succeeds) when the request is soft-deleted', async () => {
    // Seed a coherent graph, then soft-delete the request out from under a still-live
    // relationship. The rollup locks the request `WHERE deleted_at IS NULL` → no row →
    // the `if (request !== undefined)` skip branch fires: the relationship advance must
    // still commit and NOT throw (a live relationship normally implies a live request;
    // this guards the degenerate case).
    const { requestId, relationshipId } = await seedRequestWithRelationship({
      requestStatus: 'experts_invited',
      relationshipStatus: 'invited',
    });
    await db
      .update(projectRequests)
      .set({ deletedAt: new Date() })
      .where(eq(projectRequests.id, requestId));

    const updated = await requestExpertRelationshipsRepository.transitionStatus({
      id: relationshipId,
      to: 'eoi_submitted',
    });

    // Relationship advanced; the soft-deleted request was left untouched.
    expect(updated.status).toBe('eoi_submitted');
    const [raw] = await db
      .select({ status: projectRequests.status, deletedAt: projectRequests.deletedAt })
      .from(projectRequests)
      .where(eq(projectRequests.id, requestId));
    expect(raw?.deletedAt).not.toBeNull();
    expect(raw?.status).toBe('experts_invited'); // unchanged — rollup skipped
  });
});
