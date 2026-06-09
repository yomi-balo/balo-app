import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockSearchExperts = vi.fn();
vi.mock('@/lib/search/search-data', () => ({
  searchExperts: (...args: unknown[]) => mockSearchExperts(...args),
}));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/auth/require-admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

import { searchExpertsForInviteAction } from './search-experts-for-invite';
import { EMPTY_FILTERS } from '@/lib/search/filters';

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
    mockRequireAdmin.mockResolvedValue({ id: 'admin-1', platformRole: 'admin' });
    mockSearchExperts.mockResolvedValue({
      experts: [expertRow('e-1', 'Priya Nair'), expertRow('e-2', 'Sofia Ruiz')],
      total: 2,
    });
  });

  it('rejects a non-admin', async () => {
    mockRequireAdmin.mockRejectedValue(new Error('Forbidden'));
    const result = await searchExpertsForInviteAction({ q: 'cpq' });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockSearchExperts).not.toHaveBeenCalled();
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
