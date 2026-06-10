import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindByIdWithRelations = vi.fn();
const mockWithdraw = vi.fn();
const mockTransitionStatus = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => mockFindByIdWithRelations(...args),
    transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  },
  expressionsOfInterestRepository: {
    withdraw: (...args: unknown[]) => mockWithdraw(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { withdrawEoiAction } from './withdraw-eoi';
import { revalidatePath } from 'next/cache';

function requestGraph(relationshipExpertProfileId = EXPERT_PROFILE_ID): Record<string, unknown> {
  return {
    id: REQUEST_ID,
    companyId: 'company-1',
    createdByUserId: 'user-client',
    status: 'eoi_submitted',
    title: 'CPQ implementation',
    relationships: [
      {
        id: RELATIONSHIP_ID,
        expertProfileId: relationshipExpertProfileId,
        status: 'eoi_submitted',
        invitedAt: new Date(Date.now() - 60_000),
        expertProfile: {
          id: relationshipExpertProfileId,
          user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
        },
        expressionsOfInterest: [{ id: 'eoi-1', submittedAt: new Date(), message: '<p>x</p>' }],
      },
    ],
  };
}

const EXPERT_USER = {
  id: 'user-expert',
  companyId: 'company-expert',
  platformRole: 'user',
  expertProfileId: EXPERT_PROFILE_ID,
};

describe('withdrawEoiAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(EXPERT_USER);
    mockFindByIdWithRelations.mockResolvedValue(requestGraph());
    mockWithdraw.mockResolvedValue({ id: 'eoi-1', deletedAt: new Date() });
  });

  it('rejects an unauthenticated caller', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await withdrawEoiAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('rejects an invalid requestId', async () => {
    const result = await withdrawEoiAction({ requestId: 'nope' });
    expect(result.success).toBe(false);
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('rejects a non-invited expert (different expertProfileId → lens null)', async () => {
    mockFindByIdWithRelations.mockResolvedValue(requestGraph('someone-else'));
    const result = await withdrawEoiAction({ requestId: REQUEST_ID });
    expect(result).toEqual({
      success: false,
      error: 'You are not an invited expert on this request.',
    });
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('happy path: withdraws, returns success, NO publish, NO status transition', async () => {
    const result = await withdrawEoiAction({ requestId: REQUEST_ID });
    expect(mockWithdraw).toHaveBeenCalledWith({ relationshipId: RELATIONSHIP_ID });
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('no live EOI to withdraw → friendly error, no crash', async () => {
    mockWithdraw.mockResolvedValue(undefined);
    const result = await withdrawEoiAction({ requestId: REQUEST_ID });
    expect(result).toEqual({ success: false, error: 'You have no active EOI to withdraw.' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('returns a generic error on an unexpected failure', async () => {
    mockWithdraw.mockRejectedValue(new Error('DB down'));
    const result = await withdrawEoiAction({ requestId: REQUEST_ID });
    expect(result).toEqual({
      success: false,
      error: 'Could not withdraw your interest. Please try again.',
    });
  });
});
