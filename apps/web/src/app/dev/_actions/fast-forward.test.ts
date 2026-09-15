import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * BAL-275 — closes the last test gap on the fast-forward fix round (F1): `planFastForward` is
 * track-grain on the spine arm (`fast-forward-plan.test.ts` already covers the pure planner in
 * full), but the ONE call site that threads the selected track's status into it —
 * `runFastForwardRequest`'s `selectedTrackStatus = findTrack(initialRequest, relationshipId)?.status`
 * — had no test at all. This file proves that threading reaches the runtime, plus the entry
 * gate's three ordered clauses (§4.2 of the BAL-275 plan).
 *
 * The real `../_lib/fast-forward-plan` and `../_lib/fast-forward-fixtures` modules are used
 * UNMOCKED (both are pure, no I/O, no `server-only`) — every planning assertion below exercises
 * the genuine planner, not a stand-in for it. `@/lib/authz/platform` (and the `@balo/shared/authz`
 * it delegates to) is also unmocked: it is a pure, synchronous role→capability map, so the
 * capability-gate tests drive it with real `platformRole` values exactly as
 * `close-request-as-admin.test.ts` does. Every OTHER direct import of `fast-forward.ts` — the
 * repositories, the derived-actor resolver, and every real handler it orchestrates — is mocked,
 * so what's under test is `fastForwardRequestAction`'s own planning/threading/gating logic, not
 * any of the handlers it calls.
 */

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_B = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_B = 'c0000000-0000-4000-8000-000000000003';
const RELATIONSHIP_EXISTING = 'b0000000-0000-4000-8000-000000000004';
const EXPERT_NEW = 'c0000000-0000-4000-8000-000000000005';
const RELATIONSHIP_UNKNOWN = 'b0000000-0000-4000-8000-000000000006';
const RELATIONSHIP_DECLINED = 'b0000000-0000-4000-8000-000000000007';
const RELATIONSHIP_PARTIAL = 'b0000000-0000-4000-8000-000000000008';
const RELATIONSHIP_FOR_ACCEPT_UNKNOWN = 'b0000000-0000-4000-8000-000000000009';

vi.mock('server-only', () => ({}));

const mockFindByIdWithRelations = vi.fn();
const mockFindById = vi.fn();
const mockFindCurrentByRelationship = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  proposalsRepository: {
    findCurrentByRelationship: (...args: unknown[]) => mockFindCurrentByRelationship(...args),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockInviteExpertsAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/invite-experts', () => ({
  inviteExpertsAction: (...args: unknown[]) => mockInviteExpertsAction(...args),
}));

const mockRequestProposalAsAdmin = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/request-proposal-as-admin', () => ({
  requestProposalAsAdmin: (...args: unknown[]) => mockRequestProposalAsAdmin(...args),
}));

const mockCloseRequestAsAdminAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/close-request-as-admin', () => ({
  closeRequestAsAdminAction: (...args: unknown[]) => mockCloseRequestAsAdminAction(...args),
}));

const mockDeclineTrackAsAdminAction = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/decline-track-as-admin', () => ({
  declineTrackAsAdminAction: (...args: unknown[]) => mockDeclineTrackAsAdminAction(...args),
}));

const mockRunSubmitEoi = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/_shared/submit-eoi-core', () => ({
  runSubmitEoi: (...args: unknown[]) => mockRunSubmitEoi(...args),
}));

const mockRunSaveProposalDraft = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/_shared/save-proposal-draft-core', () => ({
  runSaveProposalDraft: (...args: unknown[]) => mockRunSaveProposalDraft(...args),
}));

const mockRunSubmitProposal = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/_shared/submit-proposal-core', () => ({
  runSubmitProposal: (...args: unknown[]) => mockRunSubmitProposal(...args),
}));

const mockRunAcceptProposal = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/_shared/accept-proposal-core', () => ({
  runAcceptProposal: (...args: unknown[]) => mockRunAcceptProposal(...args),
}));

const mockRunMarkThreadRead = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/_shared/mark-thread-read-core', () => ({
  runMarkThreadRead: (...args: unknown[]) => mockRunMarkThreadRead(...args),
}));

const mockResolveClientActor = vi.fn();
const mockResolveExpertActor = vi.fn();
vi.mock('../_lib/resolve-step-actor', () => ({
  resolveClientActor: (...args: unknown[]) => mockResolveClientActor(...args),
  resolveExpertActor: (...args: unknown[]) => mockResolveExpertActor(...args),
}));

import { fastForwardRequestAction } from './fast-forward';
import { refusalCopy } from '../_lib/fast-forward-plan';

function requestRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    status: 'requested',
    createdByUserId: 'client-user-1',
    relationships: [],
    ...overrides,
  };
}

function trackRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RELATIONSHIP_B,
    status: 'invited',
    expertProfileId: EXPERT_B,
    ...overrides,
  };
}

function sessionUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'derived-user-1',
    email: 'derived@example.com',
    firstName: 'Priya',
    lastName: 'Nair',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    ...overrides,
  };
}

const OPERATOR = sessionUser({
  id: 'operator-1',
  email: 'operator@example.com',
  firstName: 'Op',
  lastName: 'Erator',
  platformRole: 'admin',
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue(OPERATOR);
  mockFindByIdWithRelations.mockResolvedValue(requestRow());
  mockFindById.mockResolvedValue({ status: 'requested' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fastForwardRequestAction — entry gate (§4.2)', () => {
  const VALID_INPUT = {
    requestId: REQUEST_ID,
    target: 'experts_invited' as const,
    expertProfileId: EXPERT_NEW,
  };

  it('(a) refuses when NODE_ENV is outside the allow-list, BEFORE any identity or capability work', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const result = await fastForwardRequestAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'The fast-forward is not available in production.',
    });
    // Ordering is the property under test, not just the refusal: identity resolution must
    // never even be attempted once the environment refusal has fired.
    expect(mockRequireOnboardedUser).not.toHaveBeenCalled();
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('(b) refuses an unauthenticated caller', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('no session'));
    const result = await fastForwardRequestAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('(c) refuses a caller without PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST', async () => {
    mockRequireOnboardedUser.mockResolvedValue(
      sessionUser({ id: 'plain-user', platformRole: 'user' })
    );
    const result = await fastForwardRequestAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });
});

describe('fastForwardRequestAction — track-grain planning (BAL-275 F1 fix)', () => {
  /**
   * THE POINT OF THIS FILE. `request.status` is `proposal_submitted` (a rollup that reports
   * some OTHER, further-along track), while the SELECTED track (B) is only `invited`. If the
   * third argument to `planFastForward` were dropped, planning would run at request grain,
   * see `proposal_submitted` already at-or-past the `proposal_submitted` target, and refuse
   * with `already_at_or_past` — performing ZERO of the steps track B still needs. Mutation
   * proof (see PR report): commenting out the third argument at the call site turns this RED.
   */
  it('plans from the SELECTED TRACK, not the request rollup — a lagging track gets every step it still needs, starting with eoi', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        status: 'proposal_submitted', // rollup — reports a DIFFERENT, further-along track
        relationships: [
          trackRow({ id: RELATIONSHIP_B, status: 'invited', expertProfileId: EXPERT_B }),
        ],
      })
    );
    mockResolveExpertActor.mockResolvedValue({ ok: true, user: sessionUser() });
    mockRunSubmitEoi.mockResolvedValue({
      success: true,
      transitioned: true,
      relationshipId: RELATIONSHIP_B,
      expertProfileId: EXPERT_B,
      timeToEoiMs: 1000,
    });
    mockRequestProposalAsAdmin.mockResolvedValue({ success: true });
    mockRunSaveProposalDraft.mockResolvedValue({ success: true, proposalId: 'draft-proposal-1' });
    mockRunSubmitProposal.mockResolvedValue({
      success: true,
      proposalId: 'submitted-proposal-1',
      expertProfileId: EXPERT_B,
      transitioned: true,
    });
    mockFindById.mockResolvedValue({ status: 'proposal_submitted' });

    const result = await fastForwardRequestAction({
      requestId: REQUEST_ID,
      target: 'proposal_submitted',
      relationshipId: RELATIONSHIP_B,
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    // The step list was NOT shortened: eoi, then request_proposal, then submit_proposal — every
    // step track B still needs to go from `invited` to `proposal_submitted`.
    expect(result.steps.map((step) => step.step)).toEqual([
      'eoi',
      'request_proposal',
      'submit_proposal',
    ]);
    expect(result.steps.every((step) => step.success)).toBe(true);
    // Actor labels: the derived expert ran the two non-staff steps, the dev operator ran the
    // admin-only middle step.
    expect(result.steps[0]).toMatchObject({ step: 'eoi', actorLabel: 'Priya Nair' });
    expect(result.steps[1]).toMatchObject({ step: 'request_proposal', actorLabel: 'dev operator' });
    expect(result.steps[2]).toMatchObject({ step: 'submit_proposal', actorLabel: 'Priya Nair' });
    // The draft's proposalId threads into the submit call.
    expect(mockRunSubmitProposal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestId: REQUEST_ID,
        relationshipId: RELATIONSHIP_B,
        proposalId: 'draft-proposal-1',
      })
    );
  });

  it('falls back to REQUEST grain when no relationshipId is supplied, even with an existing track on the request', async () => {
    // An existing track at `invited` (rank 1) sits on the request. If the code silently
    // defaulted `selectedTrackStatus` to that track's status instead of leaving it `undefined`,
    // the invite-window branch would never fire and this would be refused `already_at_or_past`
    // instead of succeeding.
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        status: 'experts_invited',
        relationships: [trackRow({ id: RELATIONSHIP_EXISTING, status: 'invited' })],
      })
    );
    mockInviteExpertsAction.mockResolvedValue({
      success: true,
      invited: [{ relationshipId: 'new-relationship-1', expertProfileId: EXPERT_NEW }],
    });
    mockFindById.mockResolvedValue({ status: 'experts_invited' });

    const result = await fastForwardRequestAction({
      requestId: REQUEST_ID,
      target: 'experts_invited',
      expertProfileId: EXPERT_NEW,
      // relationshipId intentionally omitted
    });

    expect(result).toEqual({
      success: true,
      from: 'experts_invited',
      to: 'experts_invited',
      steps: [{ step: 'invite', success: true, actorLabel: 'dev operator' }],
    });
    expect(mockInviteExpertsAction).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_NEW],
    });
    expect(mockResolveExpertActor).not.toHaveBeenCalled();
    expect(mockResolveClientActor).not.toHaveBeenCalled();
  });

  it('an UNKNOWN relationshipId falls back to request grain, and the per-step runner refuses on its own terms rather than crashing', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        status: 'experts_invited',
        relationships: [
          trackRow({ id: RELATIONSHIP_B, status: 'invited', expertProfileId: EXPERT_B }),
        ],
      })
    );

    const result = await fastForwardRequestAction({
      requestId: REQUEST_ID,
      target: 'eoi_submitted',
      relationshipId: RELATIONSHIP_UNKNOWN,
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not find that track on the request.',
      steps: [{ step: 'eoi', success: false, error: 'Could not find that track on the request.' }],
    });
    // Refused before ever attempting to resolve a derived actor or call the real handler.
    expect(mockResolveExpertActor).not.toHaveBeenCalled();
    expect(mockRunSubmitEoi).not.toHaveBeenCalled();
  });

  it('a DECLINED selected track gets the track_declined refusal copy, never the off_spine "draft request" copy', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        status: 'proposal_requested',
        relationships: [trackRow({ id: RELATIONSHIP_DECLINED, status: 'declined' })],
      })
    );

    const result = await fastForwardRequestAction({
      requestId: REQUEST_ID,
      target: 'accepted',
      relationshipId: RELATIONSHIP_DECLINED,
    });

    expect(result).toEqual({ success: false, error: refusalCopy('track_declined') });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected refusal');
    expect(result.error).not.toBe(refusalCopy('off_spine'));
    expect(mockResolveClientActor).not.toHaveBeenCalled();
    expect(mockRunAcceptProposal).not.toHaveBeenCalled();
  });
});

describe('fastForwardRequestAction — per-step execution', () => {
  it('stops at the first failing step — steps already committed stay in the report, later steps never run', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        status: 'proposal_submitted',
        relationships: [
          trackRow({
            id: RELATIONSHIP_PARTIAL,
            status: 'eoi_submitted',
            expertProfileId: EXPERT_B,
          }),
        ],
      })
    );
    mockRequestProposalAsAdmin.mockResolvedValue({ success: true });
    mockResolveExpertActor.mockResolvedValue({
      ok: false,
      error: 'That party has not completed onboarding.',
    });

    const result = await fastForwardRequestAction({
      requestId: REQUEST_ID,
      target: 'proposal_submitted',
      relationshipId: RELATIONSHIP_PARTIAL,
    });

    expect(result).toEqual({
      success: false,
      error: 'That party has not completed onboarding.',
      steps: [
        { step: 'request_proposal', success: true, actorLabel: 'dev operator' },
        {
          step: 'submit_proposal',
          success: false,
          error: 'That party has not completed onboarding.',
        },
      ],
    });
    expect(mockRequestProposalAsAdmin).toHaveBeenCalledTimes(1);
    expect(mockRunSaveProposalDraft).not.toHaveBeenCalled();
    expect(mockRunSubmitProposal).not.toHaveBeenCalled();
  });

  it('runAcceptStep refuses a relationshipId not on the request BEFORE resolving a proposal or an actor (S3 containment check)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestRow({
        status: 'proposal_submitted',
        relationships: [trackRow({ id: RELATIONSHIP_B, status: 'proposal_submitted' })],
      })
    );

    const result = await fastForwardRequestAction({
      requestId: REQUEST_ID,
      target: 'accepted',
      relationshipId: RELATIONSHIP_FOR_ACCEPT_UNKNOWN,
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not find that track on the request.',
      steps: [
        { step: 'accept', success: false, error: 'Could not find that track on the request.' },
      ],
    });
    expect(mockResolveClientActor).not.toHaveBeenCalled();
    expect(mockFindCurrentByRelationship).not.toHaveBeenCalled();
    expect(mockRunAcceptProposal).not.toHaveBeenCalled();
  });
});
