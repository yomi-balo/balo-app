import { describe, it, expect, vi, beforeEach } from 'vitest';

// @balo/db repos + getMemberRole are mocked, but @/lib/authz and @balo/shared/authz
// stay REAL — so the capability gate runs end-to-end through the real role map.
const { mockAddDomain, mockGetMemberRole, mockFindById } = vi.hoisted(() => ({
  mockAddDomain: vi.fn(),
  mockGetMemberRole: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: { addDomain: mockAddDomain },
  partyMembershipsRepository: { getMemberRole: mockGetMemberRole },
  companiesRepository: { findById: mockFindById },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireUser: () => mockRequireUser() }));

vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: vi.fn(() => Promise.resolve()),
}));

const mockEmitAdded = vi.fn();
vi.mock('@/lib/analytics/party-join', () => ({
  emitPartyDomainAdded: (...a: unknown[]) => mockEmitAdded(...a),
  emitJoinRequestResolved: vi.fn(),
}));

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

import { addPartyDomain } from './add-domain';

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const AGENCY_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN = { id: 'admin-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue(ADMIN);
  // Default: a real (non-personal) company so the isPersonal guard is inert.
  mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: false });
});

describe('addPartyDomain', () => {
  it('requires a signed-in user — no repo call', async () => {
    mockRequireUser.mockRejectedValue(new Error('no session'));
    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
    });
    expect(result).toEqual({ success: false, error: 'You must be signed in to do this.' });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('rejects an invalid domain format before touching the DB', async () => {
    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'not a domain',
    });
    expect(result).toEqual({
      success: false,
      error: "That doesn't look like a domain. Enter it like acme.com — no https:// or @.",
    });
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('DENIES a base member (no MANAGE_MEMBERS) — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
    });
    expect(result).toEqual({ success: false, error: 'You do not have permission to do this.' });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('ALLOWS an owner — captures, emits, revalidates /settings/team', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockAddDomain.mockResolvedValue({
      outcome: 'captured',
      partyType: 'company',
      source: 'admin_added',
    });

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'HTTPS://Acme.com/team',
    });

    expect(result).toEqual({ success: true });
    // The normalised domain reaches the repo, actor is the session user.
    expect(mockAddDomain).toHaveBeenCalledWith({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
      actorUserId: 'admin-1',
    });
    expect(mockEmitAdded).toHaveBeenCalledWith('company', 'admin_added', 'admin-1');
    expect(mockRevalidate).toHaveBeenCalledWith('/settings/team');
  });

  it('re-gates a client-supplied agency partyType and revalidates /expert/settings', async () => {
    mockGetMemberRole.mockResolvedValue('admin');
    mockAddDomain.mockResolvedValue({
      outcome: 'captured',
      partyType: 'agency',
      source: 'admin_added',
    });

    const result = await addPartyDomain({
      partyType: 'agency',
      partyId: AGENCY_ID,
      domain: 'lattice.co',
    });

    expect(result).toEqual({ success: true });
    // The gate resolved the role against the AGENCY scope (not a company one).
    expect(mockGetMemberRole).toHaveBeenCalledWith('agency', AGENCY_ID, 'admin-1');
    expect(mockEmitAdded).toHaveBeenCalledWith('agency', 'admin_added', 'admin-1');
    expect(mockRevalidate).toHaveBeenCalledWith('/expert/settings');
    // The agency path has no isPersonal concept — the company guard never runs.
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('DENIES a personal-workspace company — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockFindById.mockResolvedValue({ id: COMPANY_ID, isPersonal: true });

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
    });

    expect(result).toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
    expect(mockAddDomain).not.toHaveBeenCalled();
    expect(mockEmitAdded).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('DENIES a company that no longer exists — no repo call', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockFindById.mockResolvedValue(undefined);

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
    });

    expect(result).toEqual({
      success: false,
      error: "This isn't available for personal workspaces.",
    });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('maps already_owned to friendly copy and does NOT emit or revalidate', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockAddDomain.mockResolvedValue({ outcome: 'already_owned' });

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'northwind.com',
    });

    expect(result).toEqual({ success: false, error: 'northwind.com is already on your list.' });
    expect(mockEmitAdded).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('maps blocked_domain to the freemail copy', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockAddDomain.mockResolvedValue({ outcome: 'skipped', reason: 'blocked_domain' });

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'gmail.com',
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('personal email provider');
  });

  it('maps already_claimed to the single-owner copy', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockAddDomain.mockResolvedValue({ outcome: 'skipped', reason: 'already_claimed' });

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error).toContain('already connected to another organisation');
  });

  it('maps a repo failure to the fallback message', async () => {
    mockGetMemberRole.mockResolvedValue('owner');
    mockAddDomain.mockRejectedValue(new Error('db exploded'));

    const result = await addPartyDomain({
      partyType: 'company',
      partyId: COMPANY_ID,
      domain: 'acme.com',
    });

    expect(result).toEqual({
      success: false,
      error: 'Could not add this domain. Please try again.',
    });
  });
});
