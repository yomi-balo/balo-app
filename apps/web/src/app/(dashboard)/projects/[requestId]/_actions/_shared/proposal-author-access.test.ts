import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

import type { SessionUser } from '@/lib/auth/session';
import { ONLY_EXPERT, resolveProposalAuthorAccess } from './proposal-author-access';

const USER = { id: 'user-expert' } as SessionUser;

describe('resolveProposalAuthorAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the expert-lens access through untouched', async () => {
    const access = { ok: true, ctx: { lens: 'expert' } };
    mockResolveAccess.mockResolvedValue(access);
    expect(await resolveProposalAuthorAccess(USER, 'req', 'rel')).toBe(access);
    expect(mockResolveAccess).toHaveBeenCalledWith(USER, 'req', 'rel');
  });

  it('refuses a client-lens participant with the expert-only copy', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
    expect(await resolveProposalAuthorAccess(USER, 'req', 'rel')).toEqual({
      ok: false,
      error: ONLY_EXPERT,
    });
  });

  it('returns the access denial unchanged', async () => {
    const denied = { ok: false, error: 'No access.' };
    mockResolveAccess.mockResolvedValue(denied);
    expect(await resolveProposalAuthorAccess(USER, 'req', 'rel')).toBe(denied);
  });
});
