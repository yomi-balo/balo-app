import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUser } from '@/lib/auth/session';

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));

vi.mock('@balo/db', () => ({
  platformLookupRepository: { search: mockSearch },
}));

import { loadLookup } from './load-lookup';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadLookup — the authorization proof', () => {
  it('a non-staff user gets { ok: false, reason: forbidden } and the repository is never called', async () => {
    const dto = await loadLookup(user({ platformRole: 'user' }), 'northwind');
    expect(dto).toEqual({ ok: false, reason: 'forbidden' });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('staff calls the repository exactly once with authorizedPlatformStaff: true', async () => {
    mockSearch.mockResolvedValue({ results: [], truncated: false, tooShort: false });
    const dto = await loadLookup(user({ platformRole: 'admin' }), 'northwind');
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith({
      query: 'northwind',
      authorizedPlatformStaff: true,
    });
    expect(dto).toEqual({ ok: true, results: [], truncated: false, tooShort: false });
  });

  it('a super_admin is also staff', async () => {
    mockSearch.mockResolvedValue({ results: [], truncated: false, tooShort: false });
    await loadLookup(user({ platformRole: 'super_admin' }), 'x');
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('an empty query short-circuits before the repository, for a staff viewer', async () => {
    const dto = await loadLookup(user({ platformRole: 'admin' }), '   ');
    expect(dto).toEqual({ ok: true, results: [], truncated: false, tooShort: false });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('passes the results, truncated and tooShort straight through', async () => {
    mockSearch.mockResolvedValue({
      results: [{ id: 'u1', type: 'user', title: 'Dana', sub: 'x', publicExpertUsername: null }],
      truncated: true,
      tooShort: false,
    });
    const dto = await loadLookup(user(), 'dana');
    expect(dto).toEqual({
      ok: true,
      results: [{ id: 'u1', type: 'user', title: 'Dana', sub: 'x', publicExpertUsername: null }],
      truncated: true,
      tooShort: false,
    });
  });
});
