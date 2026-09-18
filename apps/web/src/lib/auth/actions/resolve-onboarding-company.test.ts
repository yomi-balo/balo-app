import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos are mocked; @balo/shared/domains and match-stand-down are
// REAL (pure logic). `@/lib/logging` is globally mocked in test/setup.ts.

const {
  mockFindActiveByDomain,
  mockGetPartyJoinSettings,
  mockFindWithMembers,
  mockCapture,
  mockUpdateName,
  mockUsersUpdate,
  mockFindForSessionSync,
} = vi.hoisted(() => ({
  mockFindActiveByDomain: vi.fn(),
  mockGetPartyJoinSettings: vi.fn(),
  mockFindWithMembers: vi.fn(),
  mockCapture: vi.fn(),
  mockUpdateName: vi.fn(),
  mockUsersUpdate: vi.fn(),
  // BAL-568 — the account-liveness gate reads the LIVE row through `readLiveUserRow`.
  mockFindForSessionSync: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: {
    findActiveByDomain: mockFindActiveByDomain,
    capture: mockCapture,
  },
  partyMembershipsRepository: { getPartyJoinSettings: mockGetPartyJoinSettings },
  companiesRepository: {
    findWithMembers: mockFindWithMembers,
    updateName: mockUpdateName,
  },
  usersRepository: { update: mockUsersUpdate, findForSessionSync: mockFindForSessionSync },
}));

// `readLiveUserRow` is `React.cache()`'d; a unit test has no request scope, so pass it through.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: vi.fn(),
  AUTH_SERVER_EVENTS: { SESSION_INVALIDATED: 'auth_session_invalidated' },
}));

const LIVE_ROW = { status: 'active', deletedAt: null };
const SUSPENDED_ROW = { status: 'suspended', deletedAt: null };

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { resolveOnboardingCompanyAction } from './resolve-onboarding-company';

// ── Helpers ─────────────────────────────────────────────────────

function actionableSettings(over: Record<string, unknown> = {}) {
  return { domainJoinMode: 'auto', membershipAuthority: 'balo', isPersonal: false, ...over };
}

function withEmail(email: string): void {
  mockSessionObj = { user: { id: 'user-1', email } };
}

function expectNoWrites(): void {
  expect(mockCapture).not.toHaveBeenCalled();
  expect(mockUpdateName).not.toHaveBeenCalled();
  expect(mockUsersUpdate).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  withEmail('founder@acme.io'); // acme.io is a non-freemail corporate domain
  mockFindForSessionSync.mockResolvedValue(LIVE_ROW);
});

/**
 * BAL-568 — one of the bounded `getSession()`-only set.
 *
 * ⚠ THE GATE SITS **ABOVE** THIS ACTION'S `try`, DELIBERATELY. The action fails OPEN on any
 * throw, so a gate inside the `try` would be swallowed by its catch and silently do nothing. A
 * refused account lands on the same safe default an anonymous one does: no company is disclosed,
 * and this path writes nothing.
 */
describe('BAL-568 — account liveness', () => {
  it('⚠ a SUSPENDED actor gets the empty default WITHOUT any domain lookup', async () => {
    mockFindForSessionSync.mockResolvedValue(SUSPENDED_ROW);

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({ status: 'new', suggestion: '' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a SOFT-DELETED actor is refused the same way', async () => {
    mockFindForSessionSync.mockResolvedValue({
      status: 'active',
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(await resolveOnboardingCompanyAction()).toEqual({ status: 'new', suggestion: '' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('⚠ an anonymous caller pays ZERO live-row reads', async () => {
    mockSessionObj = { user: undefined };

    await resolveOnboardingCompanyAction();

    expect(mockFindForSessionSync).not.toHaveBeenCalled();
  });
});

// ── Tests ───────────────────────────────────────────────────────

describe('resolveOnboardingCompanyAction', () => {
  it('returns new with empty suggestion when the session has no email', async () => {
    mockSessionObj = { user: undefined };
    const result = await resolveOnboardingCompanyAction();
    expect(result).toEqual({ status: 'new', suggestion: '' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('returns blocked with empty suggestion for a freemail domain (no owner lookup)', async () => {
    withEmail('someone@gmail.com');
    const result = await resolveOnboardingCompanyAction();
    expect(result).toEqual({ status: 'blocked', suggestion: '' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('returns new with a prefill suggestion for a corporate domain with no owner', async () => {
    mockFindActiveByDomain.mockResolvedValue(undefined);
    const result = await resolveOnboardingCompanyAction();
    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('applies the company-type gate: an agency-owned domain resolves to new', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'agency', partyId: 'agency-1' });
    const result = await resolveOnboardingCompanyAction();
    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    // Gate short-circuits before reading join settings.
    expect(mockGetPartyJoinSettings).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('returns matched for a company owner with an actionable domain match', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ domainJoinMode: 'request' }));
    mockFindWithMembers.mockResolvedValue({
      name: 'Northwind',
      members: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    });

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({
      status: 'matched',
      company: { name: 'Northwind', memberCount: 3, joinMode: 'request' },
      suggestion: 'Acme',
    });
    expect(mockGetPartyJoinSettings).toHaveBeenCalledWith('company', 'company-1');
    expectNoWrites();
  });

  it('stands down to new when an actionable match has a whitespace-only name (BAL-372 guard)', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings());
    mockFindWithMembers.mockResolvedValue({ name: '   ', members: [{ id: 'm1' }, { id: 'm2' }] });

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    // The stand-down runs only AFTER the member load — it is the name guard, not the gate.
    expect(mockFindWithMembers).toHaveBeenCalledWith('company-1');
    expectNoWrites();
  });

  it('stands down to new when an actionable match has a missing name (BAL-372 guard)', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings());
    mockFindWithMembers.mockResolvedValue(undefined);

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    expectNoWrites();
  });

  it('trims surrounding whitespace on a matched company name', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings());
    mockFindWithMembers.mockResolvedValue({
      name: '  Northwind  ',
      members: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    });

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({
      status: 'matched',
      company: { name: 'Northwind', memberCount: 3, joinMode: 'auto' },
      suggestion: 'Acme',
    });
    expectNoWrites();
  });

  it('returns new for a company owner whose workspace is personal (match stands down)', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(actionableSettings({ isPersonal: true }));

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    expect(mockFindWithMembers).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('returns new when the owning party has no join settings row', async () => {
    mockFindActiveByDomain.mockResolvedValue({ partyType: 'company', partyId: 'company-1' });
    mockGetPartyJoinSettings.mockResolvedValue(undefined);

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    expectNoWrites();
  });

  it('fails open to new (with suggestion) and warns when a lookup throws', async () => {
    mockFindActiveByDomain.mockRejectedValue(new Error('db down'));

    const result = await resolveOnboardingCompanyAction();

    expect(result).toEqual({ status: 'new', suggestion: 'Acme' });
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
    expectNoWrites();
  });
});
