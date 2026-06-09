import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const EXPERT_A = 'b0000000-0000-4000-8000-00000000000a';
const EXPERT_B = 'b0000000-0000-4000-8000-00000000000b';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockFindById = vi.fn();
const mockTransitionStatus = vi.fn();
const mockInvite = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    transitionStatus: (...args: unknown[]) => mockTransitionStatus(...args),
  },
  requestExpertRelationshipsRepository: {
    invite: (...args: unknown[]) => mockInvite(...args),
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { inviteExpertsAction } from './invite-experts';
import { revalidatePath } from 'next/cache';

function requestRow(status: string) {
  return {
    id: REQUEST_ID,
    status,
    title: 'CPQ implementation',
    createdAt: new Date(Date.now() - 60_000),
  };
}

describe('inviteExpertsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ id: 'admin-1', platformRole: 'admin' });
    mockFindById.mockResolvedValue(requestRow('requested'));
    mockTransitionStatus.mockResolvedValue(undefined);
    let n = 0;
    mockInvite.mockImplementation((input: { expertProfileId: string }) => {
      n += 1;
      return Promise.resolve({ id: `rel-${n}`, expertProfileId: input.expertProfileId });
    });
  });

  it('rejects a non-admin', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('rejects empty / invalid input', async () => {
    const result = await inviteExpertsAction({ requestId: REQUEST_ID, expertProfileIds: [] });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('rejects when the request is gone', async () => {
    mockFindById.mockResolvedValue(undefined);
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({ success: false, error: 'This request no longer exists.' });
  });

  it('rejects inviting once the window has closed (proposal_requested)', async () => {
    mockFindById.mockResolvedValue(requestRow('proposal_requested'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({
      success: false,
      error: 'Experts can no longer be invited to this request.',
    });
    expect(mockInvite).not.toHaveBeenCalled();
  });

  it('invites each expert and publishes project.expert_invited per invite', async () => {
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(mockInvite).toHaveBeenCalledTimes(2);
    expect(mockInvite).toHaveBeenCalledWith({
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_A,
      invitedByUserId: 'admin-1',
    });
    expect(mockPublish).toHaveBeenCalledWith('project.expert_invited', {
      correlationId: 'rel-1',
      projectRequestId: REQUEST_ID,
      expertProfileId: EXPERT_A,
      title: 'CPQ implementation',
    });
    expect(result.success && result.invitedCount).toBe(2);
  });

  it('transitions the request once (requested → experts_invited) on first invite', async () => {
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
    expect(mockTransitionStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      to: 'experts_invited',
      expectedFrom: 'requested',
    });
    expect(result.success && result.transitioned).toBe(true);
    if (result.success) {
      expect(result.from).toBe('requested');
      expect(result.firstAdminActionMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('transitions from exploratory_meeting_requested too', async () => {
    mockFindById.mockResolvedValue(requestRow('exploratory_meeting_requested'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(mockTransitionStatus).toHaveBeenCalledWith({
      id: REQUEST_ID,
      to: 'experts_invited',
      expectedFrom: 'exploratory_meeting_requested',
    });
    if (result.success) {
      expect(result.from).toBe('exploratory_meeting_requested');
      // firstAdminActionMs is only computed for the requested → ... move.
      expect(result.firstAdminActionMs).toBeUndefined();
    }
  });

  it('does NOT transition on the invite-another path (already experts_invited)', async () => {
    mockFindById.mockResolvedValue(requestRow('experts_invited'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(result.success && result.transitioned).toBe(false);
  });

  it('skips a duplicate invite without aborting the batch', async () => {
    mockInvite
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'))
      .mockResolvedValueOnce({ id: 'rel-2', expertProfileId: EXPERT_B });
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(result.success && result.invitedCount).toBe(1);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockTransitionStatus).toHaveBeenCalledTimes(1);
  });

  it('returns invitedCount 0 with no transition when all are dups', async () => {
    mockInvite.mockRejectedValue(new Error('duplicate'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A, EXPERT_B],
    });
    expect(result).toMatchObject({ success: true, invitedCount: 0, transitioned: false });
    expect(mockTransitionStatus).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('returns a generic error on an unexpected failure', async () => {
    mockFindById.mockRejectedValue(new Error('DB down'));
    const result = await inviteExpertsAction({
      requestId: REQUEST_ID,
      expertProfileIds: [EXPERT_A],
    });
    expect(result).toEqual({
      success: false,
      error: 'Could not invite experts. Please try again.',
    });
  });
});
