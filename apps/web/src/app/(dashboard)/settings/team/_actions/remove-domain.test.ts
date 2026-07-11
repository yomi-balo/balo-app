import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRemoveDomain, mockGetMemberRole, mockFindById } = vi.hoisted(() => ({
  mockRemoveDomain: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: { removeDomain: mockRemoveDomain },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  companiesRepository: { findById: mockFindById },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: vi.fn(() => Promise.resolve()),
}));

const mockEmitRemoved = vi.fn();
vi.mock('@/lib/analytics/party-join', () => ({
  emitPartyDomainRemoved: (...a: unknown[]) => mockEmitRemoved(...a),
  emitJoinRequestResolved: vi.fn(),
}));

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

import { removePartyDomain } from './remove-domain';

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const AGENCY_ID = '33333333-3333-4333-8333-333333333333';
const DOMAIN_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN = { id: 'admin-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue(ADMIN);
  // Default: a real (non-personal) company so the isPersonal guard is inert.
  mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: false });
});

describe('removePartyDomain', () => {
  it('requires a signed-in user — no repo call', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));
    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: DOMAIN_ID,
    });
    expect(result).toEqual({ success: false, error: 'You must be signed in to do this.' });
    expect(mockRemoveDomain).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid domainId — no repo call', async () => {
    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: 'not-a-uuid',
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockRemoveDomain).not.toHaveBeenCalled();
  });

  it('DENIES a base member — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: DOMAIN_ID,
    });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockRemoveDomain).not.toHaveBeenCalled();
  });

  it('ALLOWS an owner — removes, emits, revalidates /settings/team', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockRemoveDomain.mockResolvedValue({ outcome: 'removed', domain: 'acme.com' });

    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: DOMAIN_ID,
    });

    expect(result).toEqual({ success: true });
    expect(mockRemoveDomain).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      partyType: 'company',
      partyId: COMPANY_ID,
      actorUserId: 'admin-1',
    });
    expect(mockEmitRemoved).toHaveBeenCalledWith('company', 'admin-1');
    expect(mockRevalidate).toHaveBeenCalledWith('/settings/team');
  });

  it('revalidates /expert/settings for an agency removal', async () => {
    mockGetMemberRole.mockResolvedValue('admin');
    mockRemoveDomain.mockResolvedValue({ outcome: 'removed', domain: 'lattice.co' });

    await removePartyDomain({ partyType: 'agency', partyId: AGENCY_ID, domainId: DOMAIN_ID });

    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, 'admin-1');
    expect(mockEmitRemoved).toHaveBeenCalledWith('agency', 'admin-1');
    expect(mockRevalidate).toHaveBeenCalledWith('/expert/settings');
    // The agency path has no isPersonal concept — the company guard never runs.
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('DENIES a personal-workspace company — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: true });

    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: DOMAIN_ID,
    });

    expect(result).toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
    expect(mockRemoveDomain).not.toHaveBeenCalled();
    expect(mockEmitRemoved).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('maps not_found to a friendly (idempotent-safe) error, no emit or revalidate', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockRemoveDomain.mockResolvedValue({ outcome: 'not_found' });

    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: DOMAIN_ID,
    });

    expect(result).toEqual({ success: false, error: 'This domain could not be found.' });
    expect(mockEmitRemoved).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('maps a repo failure to the fallback message', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockRemoveDomain.mockRejectedValue(new Error('db exploded'));

    const result = await removePartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domainId: DOMAIN_ID,
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not remove this domain. Please try again.',
    });
  });
});
