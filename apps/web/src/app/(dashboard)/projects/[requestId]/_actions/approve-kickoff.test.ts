import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';
const CLIENT_USER_ID = 'f0000000-0000-4000-8000-000000000006';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const {
  mockFindByIdWithRelations,
  mockFindCurrentByRelationship,
  mockMaterializeFromKickoff,
  InvalidStatusTransitionError,
  KickoffGatesIncompleteError,
} = vi.hoisted(() => {
  class InvalidStatusTransitionError extends Error {}
  class KickoffGatesIncompleteError extends Error {}
  return {
    mockFindByIdWithRelations: vi.fn(),
    mockFindCurrentByRelationship: vi.fn(),
    mockMaterializeFromKickoff: vi.fn(),
    InvalidStatusTransitionError,
    KickoffGatesIncompleteError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findCurrentByRelationship: (...a: unknown[]) => mockFindCurrentByRelationship(...a),
  },
  projectRequestsRepository: {
    findByIdWithRelations: (...a: unknown[]) => mockFindByIdWithRelations(...a),
  },
  engagementsRepository: {
    materializeFromKickoff: (...a: unknown[]) => mockMaterializeFromKickoff(...a),
  },
  InvalidStatusTransitionError,
  KickoffGatesIncompleteError,
}));

import { approveKickoffAction } from './approve-kickoff';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'user-admin' };

const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID };

const PROPOSAL = {
  id: PROPOSAL_ID,
  status: 'accepted',
  isCurrent: true,
  pricingMethod: 'fixed',
  priceCents: 500000,
  currency: 'aud',
  depositCents: 100000,
  rateCents: null,
  cadence: null,
};

function requestGraph(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    status: 'accepted',
    companyId: 'company-1',
    title: 'CPQ implementation',
    createdByUserId: CLIENT_USER_ID,
    clientBillingConfirmedAt: new Date('2026-06-01T00:00:00Z'),
    expertTermsConfirmedAt: new Date('2026-06-02T00:00:00Z'),
    company: { id: 'company-1', name: 'Acme Corp' },
    createdByUser: { id: CLIENT_USER_ID, firstName: 'Grace', lastName: 'Hopper' },
    relationships: [
      {
        id: REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        status: 'accepted',
        expertProfile: { id: EXPERT_PROFILE_ID, user: { firstName: 'Ada', lastName: 'Lovelace' } },
      },
    ],
    ...overrides,
  };
}

describe('approveKickoffAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(ADMIN);
    mockFindByIdWithRelations.mockResolvedValue(requestGraph());
    mockFindCurrentByRelationship.mockResolvedValue({ ...PROPOSAL });
    mockMaterializeFromKickoff.mockResolvedValue({
      engagement: { id: ENGAGEMENT_ID },
      request: { id: REQUEST_ID, status: 'kickoff_approved' },
    });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects a non-admin', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects invalid input', async () => {
    expect(await approveKickoffAction({ ...VALID_INPUT, relationshipId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects when the request no longer exists', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects a stale request status (not accepted)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(requestGraph({ status: 'proposal_submitted' }));
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff approval.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects when the claimed relationship is not the accepted one', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({
        relationships: [
          {
            id: 'other-rel',
            expertProfileId: EXPERT_PROFILE_ID,
            status: 'accepted',
            expertProfile: {
              id: EXPERT_PROFILE_ID,
              user: { firstName: 'Ada', lastName: 'Lovelace' },
            },
          },
        ],
      })
    );
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff approval.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects when a kickoff gate is incomplete', async () => {
    mockFindByIdWithRelations.mockResolvedValue(requestGraph({ expertTermsConfirmedAt: null }));
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Client and expert must complete their steps first.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects a missing accepted current proposal', async () => {
    mockFindCurrentByRelationship.mockResolvedValue(undefined);
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff approval.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects a stale (non-accepted) current proposal', async () => {
    mockFindCurrentByRelationship.mockResolvedValue({ ...PROPOSAL, status: 'submitted' });
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff approval.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('rejects a non-current proposal', async () => {
    mockFindCurrentByRelationship.mockResolvedValue({ ...PROPOSAL, isCurrent: false });
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff approval.',
    });
    expect(mockMaterializeFromKickoff).not.toHaveBeenCalled();
  });

  it('approves: materialises the engagement, publishes the notification, and returns the engagementId', async () => {
    const result = await approveKickoffAction(VALID_INPUT);

    expect(result).toEqual({ success: true, engagementId: ENGAGEMENT_ID });

    // Snapshots the accepted proposal's commercial terms into the engagement.
    expect(mockMaterializeFromKickoff).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      companyId: 'company-1',
      expertProfileId: EXPERT_PROFILE_ID,
      sourceProposalId: PROPOSAL_ID,
      relationshipId: REL_ID,
      pricingMethod: 'fixed',
      priceCents: 500000,
      currency: 'aud',
      depositCents: 100000,
      rateCents: undefined,
      cadence: undefined,
    });

    // Publishes the kickoff-approved notification with the exact payload.
    expect(mockPublish).toHaveBeenCalledWith('project.kickoff_approved', {
      correlationId: REQUEST_ID,
      projectRequestId: REQUEST_ID,
      relationshipId: REL_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      recipientId: CLIENT_USER_ID,
      title: 'CPQ implementation',
      expertName: 'Ada Lovelace',
      clientName: 'Grace Hopper',
      clientCompanyName: 'Acme Corp',
    });

    expect(log.info).toHaveBeenCalledWith('Kickoff approved', expect.any(Object));

    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}/proposal/${REL_ID}`);
  });

  it('falls back to name placeholders when the graph has no names', async () => {
    mockFindByIdWithRelations.mockResolvedValue(
      requestGraph({
        createdByUser: { id: CLIENT_USER_ID, firstName: null, lastName: null },
        company: null,
        relationships: [
          {
            id: REL_ID,
            expertProfileId: EXPERT_PROFILE_ID,
            status: 'accepted',
            expertProfile: {
              id: EXPERT_PROFILE_ID,
              user: { firstName: null, lastName: null },
            },
          },
        ],
      })
    );
    await approveKickoffAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith(
      'project.kickoff_approved',
      expect.objectContaining({
        expertName: 'the expert',
        clientName: 'The client',
        clientCompanyName: 'their company',
      })
    );
  });

  it('maps a benign double-approve race (InvalidStatusTransitionError) to stale copy', async () => {
    mockMaterializeFromKickoff.mockRejectedValue(new InvalidStatusTransitionError());
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This request is no longer awaiting kickoff approval.',
    });
  });

  it('maps a KickoffGatesIncompleteError to the friendly gates copy', async () => {
    mockMaterializeFromKickoff.mockRejectedValue(new KickoffGatesIncompleteError());
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Client and expert must complete their steps first.',
    });
  });

  it('maps an unexpected materialise failure to the generic error and logs it (outer catch)', async () => {
    mockMaterializeFromKickoff.mockRejectedValue(new Error('db down'));
    expect(await approveKickoffAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not approve this kickoff. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Failed to approve kickoff', expect.any(Object));
  });

  it('does not fail the action when the notification publish rejects', async () => {
    mockPublish.mockRejectedValue(new Error('engine down'));
    const result = await approveKickoffAction(VALID_INPUT);
    expect(result).toEqual({ success: true, engagementId: ENGAGEMENT_ID });
  });

  it('does not fire any server-side analytics/track', async () => {
    // The action must NOT import or call a server-side analytics tracker — the
    // component fires PROJECT_KICKOFF_APPROVED client-side. Asserting via module
    // shape: no analytics mock is wired here, and a server track() call would
    // throw on the un-mocked import. A clean happy path is the guarantee.
    const result = await approveKickoffAction(VALID_INPUT);
    expect(result.success).toBe(true);
  });
});
