import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos are mocked; @balo/shared/domains is REAL (pure logic).

const { mockFindActiveByDomain, mockGetSummaryById } = vi.hoisted(() => ({
  mockFindActiveByDomain: vi.fn(),
  mockGetSummaryById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: { findActiveByDomain: mockFindActiveByDomain },
  agenciesRepository: { getSummaryById: mockGetSummaryById },
}));

import { resolveExpertAgency } from './resolve-expert-agency';

beforeEach(() => {
  vi.clearAllMocks();
});

// acme.io is a non-freemail corporate domain.
const CORP_EMAIL = 'founder@acme.io';

describe('resolveExpertAgency', () => {
  it('resolves a freemail domain to SOLO without any owner lookup', async () => {
    const result = await resolveExpertAgency('someone@gmail.com');
    expect(result).toEqual({ kind: 'solo' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('resolves an unusable/no-domain email to SOLO', async () => {
    const result = await resolveExpertAgency('not-an-email');
    expect(result).toEqual({ kind: 'solo' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('resolves an unowned corporate domain to PROVISION with a suggested name', async () => {
    mockFindActiveByDomain.mockResolvedValue(undefined);
    const result = await resolveExpertAgency(CORP_EMAIL);
    expect(result).toEqual({ kind: 'provision', name: 'Acme' });
    expect(mockGetSummaryById).not.toHaveBeenCalled();
  });

  it('resolves a COMPANY-owned domain to SOLO (collision — an agency can not claim it)', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    const result = await resolveExpertAgency(CORP_EMAIL);
    expect(result).toEqual({ kind: 'solo' });
    // Gate short-circuits before reading the agency summary.
    expect(mockGetSummaryById).not.toHaveBeenCalled();
  });

  it('resolves an AGENCY-owned domain to JOIN with the agency summary', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-1' });
    mockGetSummaryById.mockResolvedValue({ id: 'agency-1', name: 'Lattice', memberCount: 12 });

    const result = await resolveExpertAgency(CORP_EMAIL);

    expect(result).toEqual({
      kind: 'join',
      agency: { id: 'agency-1', name: 'Lattice', memberCount: 12 },
    });
    expect(mockGetSummaryById).toHaveBeenCalledWith('agency-1');
  });

  it('falls back to PROVISION when an agency owns the domain but its row is gone', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-x' });
    mockGetSummaryById.mockResolvedValue(undefined);

    const result = await resolveExpertAgency(CORP_EMAIL);

    expect(result).toEqual({ kind: 'provision', name: 'Acme' });
  });
});
