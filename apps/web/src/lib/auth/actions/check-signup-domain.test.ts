import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos are mocked; @balo/shared/domains and the pure
// match-stand-down predicate are REAL (no I/O). `log` is auto-mocked in setup.ts.

const {
  mockFindActiveByDomain,
  mockGetPartyJoinSettings,
  mockFindOrCreateDomainMembership,
  mockCapture,
} = vi.hoisted(() => ({
  mockFindActiveByDomain: vi.fn(),
  mockGetPartyJoinSettings: vi.fn(),
  mockFindOrCreateDomainMembership: vi.fn(),
  mockCapture: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: {
    findActiveByDomain: mockFindActiveByDomain,
    capture: mockCapture,
  },
  partyMembershipsRepository: {
    getPartyJoinSettings: mockGetPartyJoinSettings,
    findOrCreateDomainMembership: mockFindOrCreateDomainMembership,
  },
}));

import { checkSignupDomainAction } from './check-signup-domain';

// ── Helpers ─────────────────────────────────────────────────────

const CORP_EMAIL = 'newhire@acme.io'; // acme.io is not freemail/disposable

function settings(over: Record<string, unknown> = {}) {
  return { domainJoinMode: 'auto', membershipAuthority: 'balo', isPersonal: false, ...over };
}

function companyOwner() {
  return { partyType: 'company', partyId: 'party-1' };
}

function expectNoWrites(): void {
  expect(mockFindOrCreateDomainMembership).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();
}

// ── Tests ───────────────────────────────────────────────────────

describe('checkSignupDomainAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocked (freemail) email → blocked (no owner lookup)', async () => {
    const result = await checkSignupDomainAction('someone@gmail.com');
    expect(result).toEqual({ status: 'blocked' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('no owning party → new', async () => {
    mockFindActiveByDomain.mockResolvedValue(undefined);
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'new' });
    expect(mockFindActiveByDomain).toHaveBeenCalledWith('acme.io');
    expectNoWrites();
  });

  it('owner is a personal workspace → new (STAND-DOWN, field shown)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ isPersonal: true }));
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'new' });
    expectNoWrites();
  });

  it('owner is an ACTIONABLE match (non-personal, auto) → matched', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'matched' });
    expectNoWrites();
  });

  it('directory-authority owner → new (stand-down)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ membershipAuthority: 'directory' }));
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'new' });
  });

  it('mode-off owner → new (stand-down)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ domainJoinMode: 'off' }));
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'new' });
  });

  it('settings undefined (party row absent) → new', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(undefined);
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'new' });
  });

  it.each(['', 'not-an-email', 'a@'])(
    'invalid/empty email %j → new (fail open, no lookup)',
    async (email) => {
      const result = await checkSignupDomainAction(email);
      expect(result).toEqual({ status: 'new' });
      expect(mockFindActiveByDomain).not.toHaveBeenCalled();
      expectNoWrites();
    }
  );

  it('repo throws → fail open (new) and does not rethrow', async () => {
    mockFindActiveByDomain.mockRejectedValue(new Error('db down'));
    const result = await checkSignupDomainAction(CORP_EMAIL);
    expect(result).toEqual({ status: 'new' });
    expectNoWrites();
  });
});
