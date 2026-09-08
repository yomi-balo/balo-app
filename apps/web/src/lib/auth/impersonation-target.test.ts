import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
  },
}));

const mockDeriveWorkspacesForUser = vi.fn();
vi.mock('@/lib/workspaces/derive-workspaces', () => ({
  deriveWorkspacesForUser: (...a: unknown[]) => mockDeriveWorkspacesForUser(...a),
}));

import { buildImpersonatedSessionUser, type ImpersonationTargetRow } from './impersonation-target';

const TARGET_ID = 'target-1';

// BAL-553 fix round 2, F4 — `targetRow` is now a PARAMETER, not fetched internally. The caller
// (`startImpersonationAction`) reads it once and passes the same row here — closing the TOCTOU
// window between the staff-target check and the data actually sealed.
function targetRow(overrides: Partial<ImpersonationTargetRow> = {}): ImpersonationTargetRow {
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
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID, targetRow());

    expect(result).not.toBeNull();
    expect(result?.id).toBe(TARGET_ID);
    expect(result?.email).toBe('target@northwind.test');
    expect(result?.firstName).toBe('Tara');
    expect(result?.lastName).toBe('Getty');
    expect(result?.avatarUrl).toBeNull();
    expect(result).not.toHaveProperty('workosId');
    expect(result).not.toHaveProperty('phone');
  });

  it('seals the passed-in row values for platformRole and onboardingCompleted', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(
      TARGET_ID,
      targetRow({ platformRole: 'admin', onboardingCompleted: false })
    );

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
  it('activeMode comes from the DERIVATION, not the raw row column, when the two disagree', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue({
      ...COMPANY_DERIVATION,
      session: { ...COMPANY_DERIVATION.session, activeMode: 'client' },
    });

    const result = await buildImpersonatedSessionUser(
      TARGET_ID,
      targetRow({ activeMode: 'expert' })
    );

    expect(result?.activeMode).toBe('client');
  });

  it('carries expertProfileId and verticalId when the target holds an expert profile', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(
      TARGET_ID,
      targetRow({ expertProfileId: 'ep-1', verticalId: 'vertical-1' })
    );

    expect(result?.expertProfileId).toBe('ep-1');
    expect(result?.verticalId).toBe('vertical-1');
  });

  it('omits expertProfileId/verticalId entirely when the target has no expert profile', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(
      TARGET_ID,
      targetRow({ expertProfileId: null, verticalId: null })
    );

    expect(result).not.toHaveProperty('expertProfileId');
    expect(result).not.toHaveProperty('verticalId');
  });

  it('does NOT carry authMethod — nobody authenticated as the target', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID, targetRow());

    expect(result).not.toHaveProperty('authMethod');
  });

  it('applies the workspace derivation projection (companyId/companyName/companyRole/activeWorkspace)', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(COMPANY_DERIVATION);

    const result = await buildImpersonatedSessionUser(TARGET_ID, targetRow());

    expect(result?.companyId).toBe('company-1');
    expect(result?.companyName).toBe('Northwind Industrial');
    expect(result?.companyRole).toBe('owner');
    expect(result?.activeWorkspace).toEqual(COMPANY_DERIVATION.activeWorkspace);
  });

  // BAL-553 fix round 2, F4 — "row not found" is no longer this function's question: the
  // CALLER now owns that check (it already read the row once to gate on `platformRoleIsStaff`),
  // covered by `actions/impersonation.test.ts`'s `target_unavailable` case. This function's own
  // not-found guard is gone along with the internal `findForSessionSync` call — only the
  // deletedAt/status defensive re-checks below remain, against the PASSED-IN row.
  it('returns null when the passed-in row is soft-deleted', async () => {
    await expect(
      buildImpersonatedSessionUser(TARGET_ID, targetRow({ deletedAt: new Date() }))
    ).resolves.toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns null when the passed-in row is not active (suspended)', async () => {
    await expect(
      buildImpersonatedSessionUser(TARGET_ID, targetRow({ status: 'suspended' }))
    ).resolves.toBeNull();
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('returns null when the User row is missing despite a live session-sync row', async () => {
    mockFindById.mockResolvedValue(undefined);

    await expect(buildImpersonatedSessionUser(TARGET_ID, targetRow())).resolves.toBeNull();
  });

  it('returns null when no company workspace is derivable', async () => {
    mockFindById.mockResolvedValue(displayUser());
    mockDeriveWorkspacesForUser.mockResolvedValue(null);

    await expect(buildImpersonatedSessionUser(TARGET_ID, targetRow())).resolves.toBeNull();
  });
});
