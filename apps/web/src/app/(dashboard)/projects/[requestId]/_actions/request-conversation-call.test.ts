import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';

vi.mock('server-only', () => ({}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

import { requestConversationCallAction } from './request-conversation-call';
import { log } from '@/lib/logging';

const USER = { id: 'user-client' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID };

describe('requestConversationCallAction (mock seam)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await requestConversationCallAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You must be signed in to request a call.',
    });
  });

  it('rejects invalid input', async () => {
    const result = await requestConversationCallAction({
      requestId: 'nope',
      relationshipId: REL_ID,
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('still runs the full access validation (cannot be used as a probe)', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    const result = await requestConversationCallAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'No access.' });
  });

  it('client lens: returns mocked confirmation without any write', async () => {
    const result = await requestConversationCallAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      mocked: true,
      confirmation: {
        message: 'Your call request is in — Balo will email you the details.',
        scheduledAtIso: null,
      },
    });
    expect(log.info).toHaveBeenCalledWith(
      'Conversation call requested (mock)',
      expect.objectContaining({ lens: 'client' })
    );
  });

  it('expert lens: propose-times copy', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'expert' } });
    const result = await requestConversationCallAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.confirmation.message).toBe(
        'Times proposed — the client will be notified by email.'
      );
    }
  });

  it('maps unexpected failures to a friendly error', async () => {
    mockResolveAccess.mockRejectedValue(new Error('boom'));
    const result = await requestConversationCallAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not request your call. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });
});
