import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRequireManager, mockRemoveDomain, mockGetParty, mockAfter } = vi.hoisted(() => ({
  mockRequireManager: vi.fn(),
  mockRemoveDomain: vi.fn(),
  mockGetParty: vi.fn(),
  mockAfter: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsStaffRepository: {
    removeDomain: (...a: unknown[]) => mockRemoveDomain(...a),
    getPartyForStaff: (...a: unknown[]) => mockGetParty(...a),
  },
}));
vi.mock('./_shared/require-party-domains-manager', () => ({
  requirePartyDomainsManager: () => mockRequireManager(),
}));
vi.mock('@/lib/logging', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('./_shared/staff-domain-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_shared/staff-domain-action')>();
  return { ...actual, afterDomainChange: (...a: unknown[]) => mockAfter(...a) };
});

import { removePartyDomainAction } from './remove-party-domain';

const PARTY_ID = '11111111-1111-4111-8111-111111111111';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const STAFF = { id: 'staff-1', platformRole: 'admin' };

const input = (overrides: Record<string, unknown> = {}) =>
  ({
    domainId: DOMAIN_ID,
    partyType: 'agency',
    partyId: PARTY_ID,
    reason: 'Customer left the company',
    ...overrides,
  }) as Parameters<typeof removePartyDomainAction>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireManager.mockResolvedValue({ ok: true, user: STAFF });
  mockGetParty.mockResolvedValue({
    partyType: 'agency',
    partyId: PARTY_ID,
    name: 'Globex',
    isPersonal: false,
    memberCount: 2,
  });
});

describe('removePartyDomainAction', () => {
  it('denies before parsing or any repository call', async () => {
    mockRequireManager.mockResolvedValue({ ok: false, error: 'nope' });

    expect(await removePartyDomainAction({ junk: 1 } as never)).toEqual({
      success: false,
      error: 'nope',
      code: 'denied',
    });
    expect(mockGetParty).not.toHaveBeenCalled();
    expect(mockRemoveDomain).not.toHaveBeenCalled();
  });

  it('rejects invalid input and a blank reason without writing', async () => {
    expect(await removePartyDomainAction(input({ domainId: 'x' }))).toMatchObject({
      success: false,
    });
    expect(await removePartyDomainAction(input({ reason: '  ' }))).toMatchObject({
      success: false,
      field: 'reason',
    });
    expect(mockRemoveDomain).not.toHaveBeenCalled();
  });

  it('removes, then runs side effects with the removed row source', async () => {
    mockRemoveDomain.mockResolvedValue({
      outcome: 'removed',
      domain: 'globex.com',
      source: 'admin_added',
    });

    const result = await removePartyDomainAction(input());

    expect(mockRemoveDomain).toHaveBeenCalledWith({
      domainId: DOMAIN_ID,
      partyType: 'agency',
      partyId: PARTY_ID,
      actorUserId: 'staff-1',
      reason: 'Customer left the company',
    });
    expect(mockAfter).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'removed',
        domainId: DOMAIN_ID,
        domain: 'globex.com',
        source: 'admin_added',
        party: expect.objectContaining({ partyName: 'Globex' }),
      })
    );
    expect(result).toEqual({
      success: true,
      message: 'globex.com removed from Globex. Owners and admins have been notified.',
    });
  });

  it('not_found reads as already removed and fires nothing', async () => {
    mockRemoveDomain.mockResolvedValue({ outcome: 'not_found' });

    expect(await removePartyDomainAction(input())).toEqual({
      success: false,
      error: 'That domain was already removed.',
      code: 'not_found',
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('fails generically for a missing party without removing', async () => {
    mockGetParty.mockResolvedValue(undefined);
    expect(await removePartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('Nothing was changed'),
    });
    expect(mockRemoveDomain).not.toHaveBeenCalled();
  });

  it('logs and returns the generic copy when the repository throws', async () => {
    mockRemoveDomain.mockRejectedValue(new Error('db down'));
    expect(await removePartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('Nothing was changed'),
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
