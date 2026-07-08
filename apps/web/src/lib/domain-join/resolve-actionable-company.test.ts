import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos are mocked; @balo/shared/domains and match-stand-down are
// REAL (pure logic), so the company-type gate and the isPersonal stand-down are
// exercised end-to-end.

const { mockFindActiveByDomain, mockGetPartyJoinSettings } = vi.hoisted(() => ({
  mockFindActiveByDomain: vi.fn(),
  mockGetPartyJoinSettings: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: { findActiveByDomain: mockFindActiveByDomain },
  partyMembershipsRepository: { getPartyJoinSettings: mockGetPartyJoinSettings },
}));

import { resolveActionableCompanyForSession } from './resolve-actionable-company';

// ── Helpers ─────────────────────────────────────────────────────

function actionableSettings(over: Record<string, unknown> = {}) {
  return { domainJoinMode: 'auto', membershipAuthority: 'balo', isPersonal: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('resolveActionableCompanyForSession', () => {
  it('returns null when no email is provided (fails closed)', async () => {
    const result = await resolveActionableCompanyForSession(undefined);
    expect(result).toBeNull();
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('returns null for a blocked (freemail) domain without an owner lookup', async () => {
    const result = await resolveActionableCompanyForSession('someone@gmail.com');
    expect(result).toBeNull();
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('returns null when the corporate domain has no active owner', async () => {
    mockFindActiveByDomain.mockResolvedValue(undefined);
    const result = await resolveActionableCompanyForSession('founder@acme.io');
    expect(result).toBeNull();
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
  });

  it('applies the company-type gate: an agency-owned domain returns null', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-1' });
    const result = await resolveActionableCompanyForSession('founder@acme.io');
    expect(result).toBeNull();
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
  });

  it('returns null when the owning party has no join settings row', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(undefined);
    const result = await resolveActionableCompanyForSession('founder@acme.io');
    expect(result).toBeNull();
  });

  it('returns null when the match stands down (personal workspace — v1 dormant)', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ isPersonal: true }));
    const result = await resolveActionableCompanyForSession('founder@acme.io');
    expect(result).toBeNull();
  });

  it('returns the party id with mode "auto" for an actionable auto-join company', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ domainJoinMode: 'auto' }));
    const result = await resolveActionableCompanyForSession('founder@acme.io');
    expect(result).toEqual({ partyId: 'company-1', mode: 'auto' });
    expect(mockGetPartyJoinSettings).toHaveBeenCalledWith('company', 'company-1');
  });

  it('returns the party id with mode "request" for an actionable request company', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-2' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ domainJoinMode: 'request' }));
    const result = await resolveActionableCompanyForSession('founder@acme.io');
    expect(result).toEqual({ partyId: 'company-2', mode: 'request' });
  });
});
