import { describe, it, expect, vi, beforeEach } from 'vitest';

// @balo/db is mocked (the live-role lookup); @balo/shared/authz is REAL so the
// capability map is exercised end-to-end through the seam.
const mockGetMemberRole = vi.fn();
vi.mock('@balo/db', () => ({
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
}));

import { hasCapability, CAPABILITIES } from './index';

beforeEach(() => vi.clearAllMocks());

describe('hasCapability seam (BAL-345 §3.3)', () => {
  it('resolves the live role against a COMPANY scope and grants MANAGE_MEMBERS to owner', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    const allowed = await hasCapability({ id: 'u-1' }, CAPABILITIES.MANAGE_MEMBERS, {
      companyId: 'co-1',
    });
    expect(allowed).toBe(true);
    expect(mockGetMemberRole).toHaveBeenCalledWith('company', 'co-1', 'u-1');
  });

  it('resolves against an AGENCY scope (branches partyType from the discriminant)', async () => {
    mockGetMemberRole.mockResolvedValue('expert');
    const allowed = await hasCapability({ id: 'u-2' }, CAPABILITIES.MANAGE_MEMBERS, {
      agencyId: 'ag-9',
    });
    // agency `expert` is a base member — no MANAGE_MEMBERS.
    expect(allowed).toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', 'ag-9', 'u-2');
  });

  it('denies (false) when the actor has no live membership', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    const allowed = await hasCapability({ id: 'u-3' }, CAPABILITIES.MANAGE_MEMBERS, {
      companyId: 'co-1',
    });
    expect(allowed).toBe(false);
  });

  it('grants a base-member capability to a plain member', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const allowed = await hasCapability({ id: 'u-4' }, CAPABILITIES.PARTICIPATE, {
      companyId: 'co-1',
    });
    expect(allowed).toBe(true);
  });
});
