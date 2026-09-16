import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformCapability } from '@balo/shared/authz';

vi.mock('server-only', () => ({}));

const mockSearchExperts = vi.fn();
vi.mock('@/lib/search/search-data', () => ({
  searchExperts: (...args: unknown[]) => mockSearchExperts(...args),
}));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

/**
 * BAL-558 — this action is SESSION-gated only, deliberately NOT live-gated (a read over
 * public marketplace data). The live gate is still mocked as a spy so the "capable caller
 * searches WITHOUT consulting it" test below is non-vacuous in the direction that matters.
 */
const mockActorHoldsLive = vi.fn<
  (userId: string, capability: PlatformCapability) => Promise<boolean>
>(async () => true);
vi.mock('@/lib/authz/live-platform-capability', () => ({
  actorHoldsPlatformCapability: (userId: string, capability: PlatformCapability) =>
    mockActorHoldsLive(userId, capability),
}));

import { searchExpertsForInviteAction } from './search-experts-for-invite';
import { EMPTY_FILTERS } from '@/lib/search/filters';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' as const };
const PERMISSION_DENIED = 'You do not have permission to do this.';

function expertRow(id: string, name: string) {
  return {
    id,
    name,
    headline: `${name} headline`,
    avatarUrl: null,
    // Extra DTO fields the action drops — present to prove the mapping is minimal.
    username: 'x',
    bio: null,
    rate: null,
  };
}

describe('searchExpertsForInviteAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUser.mockResolvedValue(ADMIN);
    mockActorHoldsLive.mockImplementation(async () => true);
    mockSearchExperts.mockResolvedValue({
      experts: [expertRow('e-1', 'Priya Nair'), expertRow('e-2', 'Sofia Ruiz')],
      total: 2,
    });
  });

  it('denies an unauthenticated caller; the search is NOT called', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await searchExpertsForInviteAction({ q: 'cpq' });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockSearchExperts).not.toHaveBeenCalled();
  });

  it('denies a session-uncapable caller (platformRole "user")', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await searchExpertsForInviteAction({ q: 'cpq' });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
    expect(mockSearchExperts).not.toHaveBeenCalled();
  });

  it('ordering: an uncapable caller with INVALID input (q over 120 chars) gets the permission denial, not the validation message', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', platformRole: 'user' });
    const result = await searchExpertsForInviteAction({ q: 'x'.repeat(121) });
    expect(result).toEqual({ success: false, error: PERMISSION_DENIED });
  });

  it('a thrown session read resolves to the permission denial and LOGS (D3)', async () => {
    mockGetCurrentUser.mockRejectedValueOnce(new Error('bad seal'));
    await expect(searchExpertsForInviteAction({ q: 'cpq' })).resolves.toEqual({
      success: false,
      error: PERMISSION_DENIED,
    });
    expect(log.error).toHaveBeenCalledWith(
      'Session read failed at the invite expert-search gate — denying',
      expect.objectContaining({ error: 'bad seal' })
    );
  });

  it('a capable caller searches WITHOUT consulting the live gate (a public read)', async () => {
    const result = await searchExpertsForInviteAction({ q: 'cpq' });
    expect(result.success).toBe(true);
    expect(mockActorHoldsLive).not.toHaveBeenCalled();
  });

  it('searches with default filters + the query and maps minimal rows', async () => {
    const result = await searchExpertsForInviteAction({ q: 'cpq' });
    expect(mockSearchExperts).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: 'cpq', page: 1 });
    expect(result).toEqual({
      success: true,
      experts: [
        { id: 'e-1', name: 'Priya Nair', headline: 'Priya Nair headline', avatarUrl: null },
        { id: 'e-2', name: 'Sofia Ruiz', headline: 'Sofia Ruiz headline', avatarUrl: null },
      ],
    });
  });

  it('defaults the query to empty when omitted', async () => {
    await searchExpertsForInviteAction({});
    expect(mockSearchExperts).toHaveBeenCalledWith({ ...EMPTY_FILTERS, q: '', page: 1 });
  });

  it('returns a friendly error when the search throws', async () => {
    mockSearchExperts.mockRejectedValue(new Error('upstream 500'));
    const result = await searchExpertsForInviteAction({ q: 'cpq' });
    expect(result).toEqual({ success: false, error: 'Could not load experts. Please try again.' });
  });
});
