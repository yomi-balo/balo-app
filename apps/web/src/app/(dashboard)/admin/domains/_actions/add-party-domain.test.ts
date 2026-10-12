import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRequireManager, mockAddDomain, mockFindOwner, mockGetParty, mockAfter } = vi.hoisted(
  () => ({
    mockRequireManager: vi.fn(),
    mockAddDomain: vi.fn(),
    mockFindOwner: vi.fn(),
    mockGetParty: vi.fn(),
    mockAfter: vi.fn(),
  })
);

vi.mock('@balo/db', () => ({
  partyDomainsStaffRepository: {
    addDomain: (...a: unknown[]) => mockAddDomain(...a),
    findLiveOwnerForStaff: (...a: unknown[]) => mockFindOwner(...a),
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

import { addPartyDomainAction } from './add-party-domain';

const PARTY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const STAFF = { id: 'staff-1', platformRole: 'admin' };

const input = (overrides: Record<string, unknown> = {}) =>
  ({
    partyType: 'company',
    partyId: PARTY_ID,
    domain: 'acme.co.nz',
    reason: 'Customer asked, confirmed by email',
    ...overrides,
  }) as Parameters<typeof addPartyDomainAction>[0];

const owner = (overrides: Record<string, unknown> = {}) => ({
  domainId: 'row-9',
  domain: 'acme.co.nz',
  partyType: 'agency',
  partyId: OTHER_ID,
  partyName: 'Globex',
  memberCount: 4,
  source: 'auto_captured',
  createdAt: new Date('2026-10-03T08:00:00.000Z'),
  createdBy: { firstName: 'Dana', lastName: 'Lee' },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireManager.mockResolvedValue({ ok: true, user: STAFF });
  mockGetParty.mockResolvedValue({
    partyType: 'company',
    partyId: PARTY_ID,
    name: 'Acme',
    isPersonal: false,
    memberCount: 2,
  });
});

describe('addPartyDomainAction', () => {
  it('denies BEFORE parsing or touching the repository', async () => {
    mockRequireManager.mockResolvedValue({
      ok: false,
      error: 'You do not have permission to do this.',
    });

    const result = await addPartyDomainAction({ nonsense: true } as never);

    expect(result).toEqual({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    expect(mockGetParty).not.toHaveBeenCalled();
    expect(mockAddDomain).not.toHaveBeenCalled();
    expect(mockFindOwner).not.toHaveBeenCalled();
  });

  it('rejects an unknown key and a non-uuid party', async () => {
    expect(await addPartyDomainAction(input({ extra: 1 }))).toMatchObject({ success: false });
    expect(await addPartyDomainAction(input({ partyId: 'x' }))).toMatchObject({ success: false });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('rejects a malformed domain on the domain field', async () => {
    expect(await addPartyDomainAction(input({ domain: 'nope' }))).toMatchObject({
      success: false,
      field: 'domain',
    });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('writes with a reason and runs the side effects on `added`', async () => {
    mockAddDomain.mockResolvedValue({ outcome: 'added', domainId: 'row-1', domain: 'acme.co.nz' });

    const result = await addPartyDomainAction(input({ domain: 'HTTPS://Acme.co.nz/x' }));

    expect(mockAddDomain).toHaveBeenCalledWith({
      partyType: 'company',
      partyId: PARTY_ID,
      domain: 'acme.co.nz',
      actorUserId: 'staff-1',
      reason: 'Customer asked, confirmed by email',
    });
    expect(mockAfter).toHaveBeenCalledWith({
      kind: 'added',
      actorUserId: 'staff-1',
      party: expect.objectContaining({ partyId: PARTY_ID, partyName: 'Acme' }),
      domainId: 'row-1',
      domain: 'acme.co.nz',
    });
    expect(result).toEqual({
      success: true,
      message: 'acme.co.nz added to Acme. Owners and admins have been notified.',
    });
  });

  describe('blank reason is a read-only probe', () => {
    it('asks for a reason when the domain is free, writing nothing', async () => {
      mockFindOwner.mockResolvedValue(undefined);

      const result = await addPartyDomainAction(input({ reason: '   ' }));

      expect(result).toMatchObject({ success: false, field: 'reason' });
      expect(mockAddDomain).not.toHaveBeenCalled();
      expect(mockAfter).not.toHaveBeenCalled();
    });

    it('surfaces the conflict BEFORE asking for a reason', async () => {
      mockFindOwner.mockResolvedValue(owner());

      const result = await addPartyDomainAction(input({ reason: '' }));

      expect(result).toMatchObject({
        success: false,
        code: 'owned_by_other',
        owner: { domainId: 'row-9', partyName: 'Globex', createdByName: 'Dana Lee' },
      });
      expect(mockAddDomain).not.toHaveBeenCalled();
    });

    it('reports a domain already on this party', async () => {
      mockFindOwner.mockResolvedValue(owner({ partyType: 'company', partyId: PARTY_ID }));

      expect(await addPartyDomainAction(input({ reason: '' }))).toMatchObject({
        field: 'domain',
        error: 'acme.co.nz is already on Acme.',
      });
    });

    it('reports a personal email provider without a repository call', async () => {
      expect(await addPartyDomainAction(input({ reason: '', domain: 'gmail.com' }))).toMatchObject({
        field: 'domain',
        error: expect.stringContaining('personal email provider'),
      });
      expect(mockFindOwner).not.toHaveBeenCalled();
    });
  });

  it('refuses a personal workspace without writing', async () => {
    mockGetParty.mockResolvedValue({
      partyType: 'company',
      partyId: PARTY_ID,
      name: 'Dana’s workspace',
      isPersonal: true,
      memberCount: 1,
    });

    expect(await addPartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('personal workspace'),
    });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  it('fails generically for a party that does not exist', async () => {
    mockGetParty.mockResolvedValue(undefined);
    expect(await addPartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('Nothing was changed'),
    });
    expect(mockAddDomain).not.toHaveBeenCalled();
  });

  describe('repository outcomes', () => {
    it('owned_by_other loads the owner for the conflict panel', async () => {
      mockAddDomain.mockResolvedValue({
        outcome: 'owned_by_other',
        ownerDomainId: 'row-9',
        ownerPartyType: 'agency',
        ownerPartyId: OTHER_ID,
      });
      mockFindOwner.mockResolvedValue(owner());

      expect(await addPartyDomainAction(input())).toMatchObject({
        code: 'owned_by_other',
        owner: { partyName: 'Globex' },
      });
      expect(mockAfter).not.toHaveBeenCalled();
    });

    it('owned_by_other whose owner vanished falls back to the generic copy', async () => {
      mockAddDomain.mockResolvedValue({ outcome: 'owned_by_other' });
      mockFindOwner.mockResolvedValue(undefined);

      expect(await addPartyDomainAction(input())).toMatchObject({
        success: false,
        error: expect.stringContaining('Nothing was changed'),
      });
    });

    it.each([
      ['already_on_party', 'acme.co.nz is already on Acme.'],
      ['blocked_domain', 'personal email provider'],
      ['personal_workspace', 'personal workspace'],
      ['party_not_found', 'Nothing was changed'],
      ['not_applicable', 'Nothing was changed'],
      ['conflict_retry', 'Nothing was changed'],
    ])('%s returns an error and fires no side effects', async (outcome, fragment) => {
      mockAddDomain.mockResolvedValue({ outcome });

      const result = await addPartyDomainAction(input());

      expect(result).toMatchObject({ success: false, error: expect.stringContaining(fragment) });
      expect(mockAfter).not.toHaveBeenCalled();
    });
  });

  it('logs and returns the generic copy when the repository throws', async () => {
    mockAddDomain.mockRejectedValue(new Error('db down'));
    expect(await addPartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('Nothing was changed'),
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
