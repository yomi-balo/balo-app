import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const READ_AT = new Date('2026-06-10T10:00:00Z');

vi.mock('server-only', () => ({}));

const mockMarkThreadRead = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

import { markThreadReadAction } from './mark-thread-read';
import { log } from '@/lib/logging';

const USER = { id: 'user-client' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID };

describe('markThreadReadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true });
    mockMarkThreadRead.mockResolvedValue({ lastReadAt: READ_AT });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await markThreadReadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects invalid input', async () => {
    const result = await markThreadReadAction({ requestId: 'x', relationshipId: REL_ID });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    const result = await markThreadReadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'No access.' });
    expect(mockMarkThreadRead).not.toHaveBeenCalled();
  });

  it('upserts the watermark and returns the persisted instant', async () => {
    const result = await markThreadReadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, lastReadAtIso: READ_AT.toISOString() });
    expect(mockMarkThreadRead).toHaveBeenCalledWith({
      relationshipId: REL_ID,
      userId: USER.id,
      at: expect.any(Date),
    });
    // High-frequency action — no business-event log.
    expect(log.info).not.toHaveBeenCalled();
  });

  it('maps repo failures to a friendly error and logs', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('boom'));
    const result = await markThreadReadAction(VALID_INPUT);
    expect(result.success).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to mark conversation thread read',
      expect.any(Object)
    );
  });
});
