import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockEligible, mockOthers } = vi.hoisted(() => ({
  mockEligible: vi.fn(),
  mockOthers: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyMembershipsRepository: {
    listCapabilityEligibleAgencies: (...args: unknown[]) => mockEligible(...args),
  },
  expertsRepository: {
    countOtherLinkedProfiles: (...args: unknown[]) => mockOthers(...args),
  },
}));

import { loadOversightAgencies } from './agency-oversight';
import type { SessionUser } from '@/lib/auth/session';

const USER = { id: 'user-1' } as SessionUser;

describe('loadOversightAgencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for agencies granting manage_members', async () => {
    mockEligible.mockResolvedValue([]);
    await loadOversightAgencies(USER);
    expect(mockEligible).toHaveBeenCalledWith('user-1', 'manage_members');
  });

  it('skips the count query when the viewer holds no agency', async () => {
    mockEligible.mockResolvedValue([]);
    await expect(loadOversightAgencies(USER)).resolves.toEqual([]);
    expect(mockOthers).not.toHaveBeenCalled();
  });

  it('drops a solo agency and keeps the others in name order', async () => {
    mockEligible.mockResolvedValue([
      { id: 'a1', name: 'Alpha' },
      { id: 'a2', name: 'Solo Co' },
      { id: 'a3', name: 'Zeta' },
    ]);
    mockOthers.mockResolvedValue(new Map([['a1', 2]]).set('a3', 1));
    const result = await loadOversightAgencies(USER);
    expect(result.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(mockOthers).toHaveBeenCalledWith(['a1', 'a2', 'a3'], 'user-1');
  });
});
