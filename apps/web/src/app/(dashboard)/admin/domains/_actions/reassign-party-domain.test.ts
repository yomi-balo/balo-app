import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRequireManager, mockReassign, mockGetParty, mockAfter } = vi.hoisted(() => ({
  mockRequireManager: vi.fn(),
  mockReassign: vi.fn(),
  mockGetParty: vi.fn(),
  mockAfter: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsStaffRepository: {
    reassignDomain: (...a: unknown[]) => mockReassign(...a),
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

import { reassignPartyDomainAction } from './reassign-party-domain';

const FROM_ID = '11111111-1111-4111-8111-111111111111';
const TO_ID = '22222222-2222-4222-8222-222222222222';
const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const STAFF = { id: 'staff-1', platformRole: 'admin' };

const input = (overrides: Record<string, unknown> = {}) =>
  ({
    expectedDomainId: DOMAIN_ID,
    fromPartyType: 'company',
    fromPartyId: FROM_ID,
    toPartyType: 'agency',
    toPartyId: TO_ID,
    domain: 'acme.com',
    reason: 'Customer moved to the agency',
    ...overrides,
  }) as Parameters<typeof reassignPartyDomainAction>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireManager.mockResolvedValue({ ok: true, user: STAFF });
  mockGetParty.mockImplementation(async (_type: string, id: string) =>
    id === FROM_ID
      ? { partyType: 'company', partyId: FROM_ID, name: 'Acme', isPersonal: false, memberCount: 3 }
      : { partyType: 'agency', partyId: TO_ID, name: 'Globex', isPersonal: false, memberCount: 5 }
  );
});

describe('reassignPartyDomainAction', () => {
  it('denies before parsing or any repository call', async () => {
    mockRequireManager.mockResolvedValue({ ok: false, error: 'nope' });

    expect(await reassignPartyDomainAction({ junk: 1 } as never)).toEqual({
      success: false,
      error: 'nope',
      code: 'denied',
    });
    expect(mockGetParty).not.toHaveBeenCalled();
    expect(mockReassign).not.toHaveBeenCalled();
  });

  it('rejects invalid input, a bad domain and a blank reason without writing', async () => {
    expect(await reassignPartyDomainAction(input({ expectedDomainId: 'x' }))).toMatchObject({
      success: false,
    });
    expect(await reassignPartyDomainAction(input({ domain: 'nope' }))).toMatchObject({
      field: 'domain',
    });
    expect(await reassignPartyDomainAction(input({ reason: ' ' }))).toMatchObject({
      field: 'reason',
    });
    expect(mockReassign).not.toHaveBeenCalled();
  });

  it('passes the expected owner to the repository and runs side effects', async () => {
    mockReassign.mockResolvedValue({
      outcome: 'reassigned',
      removedDomainId: 'row-old',
      addedDomainId: 'row-new',
      domain: 'acme.com',
      removedSource: 'auto_captured',
    });

    const result = await reassignPartyDomainAction(input());

    expect(mockReassign).toHaveBeenCalledWith({
      expected: { domainId: DOMAIN_ID, partyType: 'company', partyId: FROM_ID },
      to: { partyType: 'agency', partyId: TO_ID },
      actorUserId: 'staff-1',
      reason: 'Customer moved to the agency',
    });
    expect(mockAfter).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reassigned',
        removedDomainId: 'row-old',
        addedDomainId: 'row-new',
        from: expect.objectContaining({ partyName: 'Acme' }),
        to: expect.objectContaining({ partyName: 'Globex' }),
      })
    );
    expect(result).toEqual({
      success: true,
      message: 'acme.com moved from Acme to Globex. Owners and admins of both have been notified.',
    });
  });

  it('side effects take the domain from the repository, not the client input', async () => {
    mockReassign.mockResolvedValue({
      outcome: 'reassigned',
      removedDomainId: 'row-old',
      addedDomainId: 'row-new',
      domain: 'canonical.com',
      removedSource: 'auto_captured',
    });

    const result = await reassignPartyDomainAction(input({ domain: 'client-typed.com' }));

    expect(mockAfter).toHaveBeenCalledWith(expect.objectContaining({ domain: 'canonical.com' }));
    expect(result).toMatchObject({
      success: true,
      message: expect.stringContaining('canonical.com'),
    });
  });

  it('stale returns the stale copy and fires nothing', async () => {
    mockReassign.mockResolvedValue({ outcome: 'stale' });

    expect(await reassignPartyDomainAction(input())).toEqual({
      success: false,
      error: 'acme.com changed hands while you were looking. Check it again before reassigning.',
      code: 'stale',
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('refuses a personal workspace target before the repository', async () => {
    mockGetParty.mockImplementation(async (_type: string, id: string) => ({
      partyType: id === FROM_ID ? 'company' : 'agency',
      partyId: id,
      name: id === FROM_ID ? 'Acme' : 'Dana’s workspace',
      isPersonal: id !== FROM_ID,
      memberCount: 1,
    }));

    expect(await reassignPartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('personal workspace'),
    });
    expect(mockReassign).not.toHaveBeenCalled();
  });

  it('maps a repository personal_workspace outcome too', async () => {
    mockReassign.mockResolvedValue({ outcome: 'personal_workspace' });
    expect(await reassignPartyDomainAction(input())).toMatchObject({
      error: expect.stringContaining('personal workspace'),
    });
  });

  it('fails generically when either party is missing', async () => {
    mockGetParty.mockResolvedValueOnce(undefined);
    expect(await reassignPartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('Nothing was changed'),
    });
    expect(mockReassign).not.toHaveBeenCalled();
  });

  it.each(['same_party', 'party_not_found', 'conflict_retry'])(
    '%s returns the generic copy and fires nothing',
    async (outcome) => {
      mockReassign.mockResolvedValue({ outcome });
      expect(await reassignPartyDomainAction(input())).toMatchObject({
        success: false,
        error: expect.stringContaining('Nothing was changed'),
      });
      expect(mockAfter).not.toHaveBeenCalled();
    }
  );

  it('logs and returns the generic copy when the repository throws', async () => {
    mockReassign.mockRejectedValue(new Error('db down'));
    expect(await reassignPartyDomainAction(input())).toMatchObject({
      success: false,
      error: expect.stringContaining('Nothing was changed'),
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });
});
