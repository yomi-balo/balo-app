import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindForSessionSync = vi.fn();
const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...a: unknown[]) => mockFindForSessionSync(...a),
    findById: (...a: unknown[]) => mockFindById(...a),
  },
}));

const mockDeriveWorkspacesForUser = vi.fn();
vi.mock('@/lib/workspaces/derive-workspaces', () => ({
  deriveWorkspacesForUser: (...a: unknown[]) => mockDeriveWorkspacesForUser(...a),
}));

import { buildImpersonatedSessionUser } from './impersonation-target';

const TARGET_ID = 'target-1';

function syncRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'user',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null,
    expertApprovedAt: null,
    verticalId: null,
    ...overrides,
  };
}

function displayUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    email: 'target@northwind.test',
    firstName: 'Tara',
    lastName: 'Getty',
    avatarUrl: null,
    // Extra fields a real `User` row carries — must NEVER leak into SessionUser.
    workosId: 'workos_target_1',
    phone: '+61400000000',
    ...overrides,
  };
}

const COMPANY_DERIVATION = {
  workspaces: [],
  activeWorkspace: { type: 'company' as const, key: 'company:company-1' },
  session: {
    activeMode: 'client' as const,
    companyId: 'company-1',
    companyName: 'Northwind Industrial',
    companyRole: 'owner' as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildImpersonatedSessionUser', () => {
  it('builds a SessionUser copying only the four display fields off the User row', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow());
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(TARGET_ID);
    expect(result?.email).toBe('target@northwind.test');
    expect(result?.firstName).toBe('Tara');
    expect(result?.lastName).toBe('Getty');
    expect(result?.avatarUrl).toBeNull();
    expect(result).not.toHaveProperty('workosId');
    expect(result).not.toHaveProperty('phone');
  });

  it('seals the DB row values for platformRole and onboardingCompleted', async () => {
    mockFindForSessionSync.mockResolvedValue(
      syncRow({ platformRole: 'admin', onboardingCompleted: false })
    );
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result?.platformRole).toBe('admin');
    expect(result?.onboardingCompleted).toBe(false);
  });

  // BAL-553 fix round 1, F7 — this used to be folded into the test above under a title
  // ("seals the DB row values for activeMode…") that asserted nothing about `activeMode`,
  // because BOTH fixture sides used `'client'` and nothing discriminated them. The real
  // behaviour: `applyWorkspaceDerivationToSessionUser` unconditionally overwrites `activeMode`
  // from `derived.session.activeMode`, so a target whose STORED `activeMode` is `'expert'` but
  // who derives no expert workspace (`resolveActiveWorkspace`'s fail-safe demotion in
  // `@balo/shared/workspaces`) ends up with `activeMode: 'client'` in the impersonated
  // session — the DERIVED value, never the raw DB column.
  it('activeMode comes from the DERIVATION, not the raw syncRow column, when the two disagree', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow({ activeMode: 'expert' }));
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue({
      ...COMPANY_DERIVATION,
      session: { ...COMPANY_DERIVATION.session, activeMode: 'client' },
    });

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result?.activeMode).toBe('client');
  });

  it('carries expertProfileId and verticalId when the target holds an expert profile', async () => {
    mockFindForSessionSync.mockResolvedValue(
      syncRow({ expertProfileId: 'ep-1', verticalId: 'vertical-1' })
    );
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result?.expertProfileId).toBe('ep-1');
    expect(result?.verticalId).toBe('vertical-1');
  });

  it('omits expertProfileId/verticalId entirely when the target has no expert profile', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow({ expertProfileId: null, verticalId: null }));
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result).not.toHaveProperty('expertProfileId');
    expect(result).not.toHaveProperty('verticalId');
  });

  it('does NOT carry authMethod — nobody authenticated as the target', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow());
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result).not.toHaveProperty('authMethod');
  });

  it('applies the workspace derivation projection (companyId/companyName/companyRole/activeWorkspace)', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow());
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID);

    expect(result?.companyId).toBe('company-1');
    expect(result?.companyName).toBe('Northwind Industrial');
    expect(result?.companyRole).toBe('owner');
    expect(result?.activeWorkspace).toEqual(COMPANY_DERIVATION.activeWorkspace);
  });

  it('returns null when the target row is not found', async () => {
    mockFindForSessionSync.mockResolvedValue(null);

    await expect(buildImpersonatedSessionUser(TARGET_ID)).resolves.toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns null when the target is soft-deleted', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow({ deletedAt: new Date() }));

    await expect(buildImpersonatedSessionUser(TARGET_ID)).resolves.toBeNull();
  });

  it('returns null when the target is not active (suspended)', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow({ status: 'suspended' }));

    await expect(buildImpersonatedSessionUser(TARGET_ID)).resolves.toBeNull();
  });

  it('returns null when the User row is missing despite a session-sync row existing', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow());
    mockFindById.mockResolvedValue(undefined);

    await expect(buildImpersonatedSessionUser(TARGET_ID)).resolves.toBeNull();
  });

  it('returns null when no company workspace is derivable', async () => {
    mockFindForSessionSync.mockResolvedValue(syncRow());
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(null);

    await expect(buildImpersonatedSessionUser(TARGET_ID)).resolves.toBeNull();
  });
});
