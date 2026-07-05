import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const { mockConfirmKickoffGate, InvalidKickoffStateError } = vi.hoisted(() => {
  class InvalidKickoffStateError extends Error {}
  return {
    mockConfirmKickoffGate: vi.fn(),
    InvalidKickoffStateError,
  };
});

vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    confirmKickoffGate: (...a: unknown[]) => mockConfirmKickoffGate(...a),
  },
  InvalidKickoffStateError,
}));

import { completeKickoffTaskAction } from './complete-kickoff-task';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert', firstName: 'Grace', lastName: 'Hopper' };

const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID };

// Default access resolves to the WINNING EXPERT — the only lens that confirms a
// gate here now that BAL-323 moved client billing to its own form.
function accessOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ctx: { lens: 'expert' },
    relationship: { expertProfileId: EXPERT_PROFILE_ID, status: 'accepted' },
    request: { status: 'accepted', title: 'CPQ implementation' },
    recipient: { role: 'expert', expertProfileId: EXPERT_PROFILE_ID },
    ...overrides,
  };
}

describe('completeKickoffTaskAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(accessOk());
    mockConfirmKickoffGate.mockResolvedValue({ id: REQUEST_ID });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('rejects invalid input', async () => {
    expect(await completeKickoffTaskAction({ ...VALID_INPUT, relationshipId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('bubbles the access guard error', async () => {
    mockResolveAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access to this conversation.',
    });
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('rejects the client lens — billing is captured through the billing form', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'client' } }));
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Billing details are added from the billing form.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('rejects a non-participant lens (defensive)', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'admin' } }));
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only a participant can complete this step.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('maps the expert lens → expert_terms gate', async () => {
    const result = await completeKickoffTaskAction(VALID_INPUT);
    expect(result).toEqual({ success: true, gate: 'expert_terms' });
    expect(mockConfirmKickoffGate).toHaveBeenCalledWith({
      id: REQUEST_ID,
      gate: 'expert_terms',
    });
  });

  it('rejects a stale request status (not accepted)', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({ request: { status: 'proposal_submitted', title: 'CPQ implementation' } })
    );
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This kickoff is no longer open.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('rejects when the relationship is not accepted (non-winning expert)', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({
        relationship: { expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
      })
    );
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This kickoff is no longer open.',
    });
    expect(mockConfirmKickoffGate).not.toHaveBeenCalled();
  });

  it('maps an InvalidKickoffStateError to stale copy', async () => {
    mockConfirmKickoffGate.mockRejectedValue(new InvalidKickoffStateError());
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This kickoff is no longer open.',
    });
  });

  it('confirms the gate, logs, revalidates, and returns success', async () => {
    const result = await completeKickoffTaskAction(VALID_INPUT);
    expect(result).toEqual({ success: true, gate: 'expert_terms' });
    expect(mockConfirmKickoffGate).toHaveBeenCalledWith({
      id: REQUEST_ID,
      gate: 'expert_terms',
    });
    expect(log.info).toHaveBeenCalledWith('Kickoff gate confirmed', expect.any(Object));
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('maps an unexpected confirm failure to the generic error and logs it (outer catch)', async () => {
    mockConfirmKickoffGate.mockRejectedValue(new Error('db down'));
    expect(await completeKickoffTaskAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not complete this step. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Failed to confirm kickoff gate', expect.any(Object));
  });
});
