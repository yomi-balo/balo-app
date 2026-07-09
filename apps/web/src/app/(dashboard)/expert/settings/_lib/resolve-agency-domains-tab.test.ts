import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PartyDomainWithCreator } from '@balo/db';

const { mockGetSummaryById, mockListByPartyWithCreator, mockHasCapability, mockLogError } =
  vi.hoisted(() => ({
    mockGetSummaryById: vi.fn(),
    mockListByPartyWithCreator: vi.fn(),
    mockHasCapability: vi.fn(),
    mockLogError: vi.fn(),
  }));

vi.mock('@balo/db', () => ({
  agenciesRepository: { getSummaryById: mockGetSummaryById },
  partyDomainsRepository: { listByPartyWithCreator: mockListByPartyWithCreator },
}));
vi.mock('@/lib/authz', () => ({
  hasCapability: (...args: unknown[]) => mockHasCapability(...args),
  CAPABILITIES: { MANAGE_MEMBERS: 'manage_members' },
}));
vi.mock('@/lib/logging', () => ({ log: { error: (...args: unknown[]) => mockLogError(...args) } }));

import { resolveAgencyDomainsTab } from './resolve-agency-domains-tab';

const USER = { id: 'expert-1' };
const AGENCY_ID = '33333333-3333-4333-8333-333333333333';

const DOMAIN: PartyDomainWithCreator = {
  id: 'a1',
  domain: 'latticeconsulting.com',
  source: 'auto_captured',
  createdAt: new Date('2020-01-01T00:00:00Z'),
  createdBy: { id: 'u1', firstName: 'Sam', lastName: 'Okafor' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCapability.mockResolvedValue(true);
  mockGetSummaryById.mockResolvedValue({ name: 'Lattice' });
  mockListByPartyWithCreator.mockResolvedValue([DOMAIN]);
});

describe('resolveAgencyDomainsTab', () => {
  it('returns no tab (no reads) when there is no agency', async () => {
    const result = await resolveAgencyDomainsTab(USER, null);
    expect(result).toEqual({ canManageAgency: false, agencyDomains: null });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockListByPartyWithCreator).not.toHaveBeenCalled();
  });

  it('returns no tab when the expert cannot manage the agency (no domains fetch)', async () => {
    mockHasCapability.mockResolvedValue(false);
    const result = await resolveAgencyDomainsTab(USER, AGENCY_ID);
    expect(result).toEqual({ canManageAgency: false, agencyDomains: null });
    expect(mockListByPartyWithCreator).not.toHaveBeenCalled();
  });

  it('loads the domains and resolves partyName from the summary on the happy path', async () => {
    const result = await resolveAgencyDomainsTab(USER, AGENCY_ID);
    expect(result).toEqual({
      canManageAgency: true,
      agencyDomains: { agencyId: AGENCY_ID, partyName: 'Lattice', domains: [DOMAIN] },
    });
  });

  it('CONTAINS a domains-fetch failure to the tab (domains: null) — does not throw/blank the page', async () => {
    mockListByPartyWithCreator.mockRejectedValue(new Error('db exploded'));

    // The key guarantee: it RESOLVES (no rejection propagates to the page-level catch,
    // so the rest of the expert-settings surface still renders).
    const result = await resolveAgencyDomainsTab(USER, AGENCY_ID);

    expect(result).toEqual({
      canManageAgency: true,
      // partyName still resolves from the (successful) summary; only domains degrade.
      agencyDomains: { agencyId: AGENCY_ID, partyName: 'Lattice', domains: null },
    });
    expect(mockLogError).toHaveBeenCalled();
  });

  it('falls back to a sensible partyName label when the summary read fails', async () => {
    mockGetSummaryById.mockRejectedValue(new Error('summary down'));

    const result = await resolveAgencyDomainsTab(USER, AGENCY_ID);

    expect(result).toEqual({
      canManageAgency: true,
      agencyDomains: { agencyId: AGENCY_ID, partyName: 'Your agency', domains: [DOMAIN] },
    });
  });
});
