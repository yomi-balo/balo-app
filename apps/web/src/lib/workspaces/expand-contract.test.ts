import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-494 — the BEHAVIOUR-LEVEL PROOF for AC "all existing consumers pass untouched".
 *
 * With `active_company_id = NULL` (the state of EVERY existing row after the migration),
 * the derivation's projection must be BIT-IDENTICAL to today's
 * `findWithCompany().companyMemberships[0]` — same query, same `[role, joinedAt, id]`
 * ordering, no re-implementation. This is what makes the expand/contract step behaviourally
 * a no-op for every user who has not yet explicitly switched.
 */

vi.mock('server-only', () => ({}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const mockFindForSessionSync = vi.fn();
const mockFindWithCompany = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
    findWithCompany: (...args: unknown[]) => mockFindWithCompany(...args),
  },
  companiesRepository: { findSummariesByIds: vi.fn().mockResolvedValue([]) },
  partyMembershipsRepository: {
    listCapabilityEligibleCompanies: vi.fn(),
  },
  representationsRepository: { findActiveForActor: vi.fn().mockResolvedValue([]) },
}));

import { partyMembershipsRepository } from '@balo/db';
import { deriveWorkspacesForUser } from './derive-workspaces';

const USER_ID = 'user-1';

function sessionSyncUser(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'user',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null, // every existing row, post-migration
    expertApprovedAt: null,
    ...overrides,
  };
}

/**
 * A two-membership actor: the personal workspace first (canonical `[role, joinedAt, id]`
 * order, as `findWithCompany` already returns it), then Northwind.
 */
function twoMembershipUser(): void {
  mockFindWithCompany.mockResolvedValue({
    companyMemberships: [
      {
        role: 'owner',
        company: { id: 'company-personal', name: "Dana's Workspace", isPersonal: true },
      },
      {
        role: 'member',
        company: { id: 'company-2', name: 'Northwind Industrial', isPersonal: false },
      },
    ],
  });
  vi.mocked(partyMembershipsRepository.listCapabilityEligibleCompanies).mockResolvedValue([
    { id: 'company-personal', name: "Dana's Workspace", logoUrl: null },
    { id: 'company-2', name: 'Northwind Industrial', logoUrl: null },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expand/contract — single-membership user', () => {
  it('reproduces findWithCompany()[0] exactly (id, name, role), and activeMode equals the DB column', async () => {
    mockFindForSessionSync.mockResolvedValue(sessionSyncUser({ activeMode: 'client' }));
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        { role: 'owner', company: { id: 'company-1', name: "Dana's Workspace", isPersonal: true } },
      ],
    });
    vi.mocked(partyMembershipsRepository.listCapabilityEligibleCompanies).mockResolvedValue([
      { id: 'company-1', name: "Dana's Workspace", logoUrl: null },
    ]);

    const result = await deriveWorkspacesForUser(USER_ID);

    // Bit-identical to `findWithCompany().companyMemberships[0]`.
    expect(result?.session).toEqual({
      activeMode: 'client',
      companyId: 'company-1',
      companyName: "Dana's Workspace",
      companyRole: 'owner',
    });
  });
});

describe('expand/contract — two-membership user (personal first)', () => {
  it('the default company is the FIRST membership in canonical [role, joinedAt, id] order — the personal workspace', async () => {
    mockFindForSessionSync.mockResolvedValue(sessionSyncUser());
    twoMembershipUser();

    const result = await deriveWorkspacesForUser(USER_ID);

    expect(result?.session).toEqual({
      activeMode: 'client',
      companyId: 'company-personal',
      companyName: "Dana's Workspace",
      companyRole: 'owner',
    });
  });
});

describe('expand/contract — activeMode drives the projection identically to today', () => {
  it("DB activeMode='expert' with an approved profile projects activeMode:'expert'", async () => {
    mockFindForSessionSync.mockResolvedValue(
      sessionSyncUser({
        activeMode: 'expert',
        expertProfileId: 'expert-1',
        expertApprovedAt: new Date('2025-01-01'),
      })
    );
    mockFindWithCompany.mockResolvedValue({
      companyMemberships: [
        {
          role: 'owner',
          company: { id: 'company-personal', name: "Dana's Workspace", isPersonal: true },
        },
      ],
    });
    vi.mocked(partyMembershipsRepository.listCapabilityEligibleCompanies).mockResolvedValue([
      { id: 'company-personal', name: "Dana's Workspace", logoUrl: null },
    ]);

    const result = await deriveWorkspacesForUser(USER_ID);
    expect(result?.session.activeMode).toBe('expert');
  });
});

describe('expand/contract — a STORED company choice survives a trip through expert', () => {
  it("activeMode='expert' with a stored active_company_id projects THAT company, not memberships[0]", async () => {
    mockFindForSessionSync.mockResolvedValue(
      sessionSyncUser({
        activeMode: 'expert',
        activeCompanyId: 'company-2', // the user switched to B, then switched to expert
        expertProfileId: 'expert-1',
        expertApprovedAt: new Date('2025-01-01'),
      })
    );
    twoMembershipUser();

    const result = await deriveWorkspacesForUser(USER_ID);

    expect(result?.activeWorkspace).toEqual({ type: 'expert', key: 'expert' });
    expect(result?.session).toEqual({
      activeMode: 'expert',
      companyId: 'company-2',
      companyName: 'Northwind Industrial',
      companyRole: 'member',
    });
  });
});
