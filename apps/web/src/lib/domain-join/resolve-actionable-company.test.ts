import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos are mocked; @balo/shared/domains and match-stand-down are
// REAL (pure logic), so the company-type gate and the isPersonal stand-down are
// exercised end-to-end.

const { mockFindActiveByDomain, mockGetPartyJoinSettings, mockUsersFindById } = vi.hoisted(() => ({
  mockFindActiveByDomain: vi.fn(),
  mockGetPartyJoinSettings: vi.fn(),
  mockUsersFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: { findActiveByDomain: mockFindActiveByDomain },
  partyMembershipsRepository: { getPartyJoinSettings: mockGetPartyJoinSettings },
  usersRepository: { findById: mockUsersFindById },
}));

import { resolveActionableCompanyForSession } from './resolve-actionable-company';

// ── Helpers ─────────────────────────────────────────────────────

const USER_ID = 'user-1';

function actionableSettings(over: Record<string, unknown> = {}) {
  return { domainJoinMode: 'auto', membershipAuthority: 'balo', isPersonal: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a verified session user so the domain read-chain tests below exercise the
  // owner lookup. The unverified / missing cases override this per-test.
  mockUsersFindById.mockResolvedValue({ id: USER_ID, emailVerified: true });
});

// ── Tests ───────────────────────────────────────────────────────

describe('resolveActionableCompanyForSession', () => {
  it('returns null when no email is provided (fails closed) — before the verified gate', async () => {
    const result = await resolveActionableCompanyForSession(USER_ID, undefined);
    expect(result).toBeNull();
    expect(mockUsersFindById).not.toHaveBeenCalled();
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('returns null for a blocked (freemail) domain without a verified/owner lookup', async () => {
    const result = await resolveActionableCompanyForSession(USER_ID, 'someone@gmail.com');
    expect(result).toBeNull();
    expect(mockUsersFindById).not.toHaveBeenCalled();
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  // ── BAL-348 HARD verified gate ──
  it('returns null when the session user is UNVERIFIED (fails closed, no owner lookup)', async () => {
    mockUsersFindById.mockResolvedValue({ id: USER_ID, emailVerified: false });
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toBeNull();
    expect(mockUsersFindById).toHaveBeenCalledWith(USER_ID);
    // The gate short-circuits BEFORE the domain owner read.
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
  });

  it('returns null when the session user row is MISSING (fails closed)', async () => {
    mockUsersFindById.mockResolvedValue(undefined);
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toBeNull();
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('returns null when the corporate domain has no active owner (verified user)', async () => {
    mockFindActiveByDomain.mockResolvedValue(undefined);
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toBeNull();
    expect(mockUsersFindById).toHaveBeenCalledWith(USER_ID);
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
  });

  it('applies the company-type gate: an agency-owned domain returns null', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-1' });
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toBeNull();
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
  });

  it('returns null when the owning party has no join settings row', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(undefined);
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toBeNull();
  });

  it('returns null when the match stands down (personal workspace — v1 dormant)', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ isPersonal: true }));
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toBeNull();
  });

  it('returns the party id with mode "auto" for a verified user + actionable auto-join company', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ domainJoinMode: 'auto' }));
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toEqual({ partyId: 'company-1', mode: 'auto' });
    expect(mockUsersFindById).toHaveBeenCalledWith(USER_ID);
    expect(mockGetPartyJoinSettings).toHaveBeenCalledWith('company', 'company-1');
  });

  it('returns the party id with mode "request" for a verified user + actionable request company', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-2' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ domainJoinMode: 'request' }));
    const result = await resolveActionableCompanyForSession(USER_ID, 'founder@acme.io');
    expect(result).toEqual({ partyId: 'company-2', mode: 'request' });
  });
});
