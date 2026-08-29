import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

// `deriveWorkspacesForUser` is wrapped in React's `cache()`, which requires a request scope
// to run. In unit tests there is no such scope, so make `cache` a pass-through wrapper —
// same precedent as `apps/web/src/lib/actions/expert-checklist.test.ts`.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const mockFindForSessionSync = vi.fn();
const mockFindWithCompany = vi.fn();
const mockFindSummariesByIds = vi.fn();
const mockListCapabilityEligibleCompanies = vi.fn();
const mockFindActiveForActor = vi.fn();

vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
    findWithCompany: (...args: unknown[]) => mockFindWithCompany(...args),
  },
  companiesRepository: {
    findSummariesByIds: (...args: unknown[]) => mockFindSummariesByIds(...args),
  },
  partyMembershipsRepository: {
    listCapabilityEligibleCompanies: (...args: unknown[]) =>
      mockListCapabilityEligibleCompanies(...args),
  },
  representationsRepository: {
    findActiveForActor: (...args: unknown[]) => mockFindActiveForActor(...args),
  },
}));

import { deriveWorkspacesForUser } from './derive-workspaces';

// ── Helpers ─────────────────────────────────────────────────────

const USER_ID = 'user-1';
const PERSONAL_ID = 'company-personal';

function sessionSyncUser(overrides: Record<string, unknown> = {}) {
  return {
    status: 'active',
    activeMode: 'client',
    platformRole: 'user',
    onboardingCompleted: true,
    deletedAt: null,
    expertProfileId: null,
    activeCompanyId: null,
    expertApprovedAt: null,
    ...overrides,
  };
}

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    role: 'owner',
    company: {
      id: PERSONAL_ID,
      name: "Dana's Workspace",
      isPersonal: true,
      // A real row carries far more — this simulates the hydration danger the
      // wrapper must project away from.
      stripeCustomerId: 'cus_super_secret_123',
      creditBalance: 500000,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindForSessionSync.mockResolvedValue(sessionSyncUser());
  mockFindWithCompany.mockResolvedValue({ companyMemberships: [membershipRow()] });
  mockListCapabilityEligibleCompanies.mockResolvedValue([
    { id: PERSONAL_ID, name: "Dana's Workspace", logoUrl: null },
  ]);
  mockFindActiveForActor.mockResolvedValue([]);
  mockFindSummariesByIds.mockResolvedValue([]);
});

// ── Tests ───────────────────────────────────────────────────────

describe('deriveWorkspacesForUser', () => {
  it('issues all four primary reads', async () => {
    await deriveWorkspacesForUser(USER_ID);
    expect(mockFindForSessionSync).toHaveBeenCalledWith(USER_ID);
    expect(mockListCapabilityEligibleCompanies).toHaveBeenCalledWith(USER_ID, 'participate');
    expect(mockFindWithCompany).toHaveBeenCalledWith(USER_ID);
    expect(mockFindActiveForActor).toHaveBeenCalledWith(USER_ID, expect.any(Date));
  });

  it('read 5 (findSummariesByIds) is skipped when representations add no new ids', async () => {
    mockFindActiveForActor.mockResolvedValue([]);
    await deriveWorkspacesForUser(USER_ID);
    expect(mockFindSummariesByIds).not.toHaveBeenCalled();
  });

  it('read 5 is skipped when the represented company is already covered by a membership', async () => {
    mockFindActiveForActor.mockResolvedValue([
      {
        scope: 'org',
        capabilities: ['participate'],
        onBehalfOfCompanyId: PERSONAL_ID, // same id as the membership row
      },
    ]);
    await deriveWorkspacesForUser(USER_ID);
    expect(mockFindSummariesByIds).not.toHaveBeenCalled();
  });

  it('read 5 IS called for a represented company NOT covered by any membership, and it is hydrated', async () => {
    const REP_ID = 'company-represented';
    mockFindActiveForActor.mockResolvedValue([
      { scope: 'org', capabilities: ['participate'], onBehalfOfCompanyId: REP_ID },
    ]);
    mockFindSummariesByIds.mockResolvedValue([
      { id: REP_ID, name: 'Represented Co', isPersonal: false },
    ]);

    const result = await deriveWorkspacesForUser(USER_ID);

    expect(mockFindSummariesByIds).toHaveBeenCalledWith([REP_ID]);
    const repWorkspace = result?.workspaces.find(
      (w) => w.type === 'company' && w.companyId === REP_ID
    );
    expect(repWorkspace).toMatchObject({
      companyId: REP_ID,
      via: 'representation',
      name: 'Represented Co',
    });
  });

  it('drops a representation row lacking scope="org" or PARTICIPATE', async () => {
    mockFindActiveForActor.mockResolvedValue([
      { scope: 'request', capabilities: ['participate'], onBehalfOfCompanyId: 'rep-a' },
      { scope: 'org', capabilities: ['manage_requests'], onBehalfOfCompanyId: 'rep-b' },
    ]);
    const result = await deriveWorkspacesForUser(USER_ID);
    expect(mockFindSummariesByIds).not.toHaveBeenCalled();
    const companyIds = (result?.workspaces ?? [])
      .filter((w) => w.type === 'company')
      .map((w) => (w.type === 'company' ? w.companyId : null));
    expect(companyIds).not.toContain('rep-a');
    expect(companyIds).not.toContain('rep-b');
  });

  it('findActiveForActor receives a server-derived Date, not a caller-supplied one', async () => {
    const before = Date.now();
    await deriveWorkspacesForUser(USER_ID);
    const after = Date.now();
    const [, now] = mockFindActiveForActor.mock.calls[0] as [string, Date];
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });

  it('explicit projection: no stripeCustomerId or creditBalance reaches the derived output', async () => {
    const result = await deriveWorkspacesForUser(USER_ID);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('stripeCustomerId');
    expect(serialized).not.toContain('cus_super_secret_123');
    expect(serialized).not.toContain('creditBalance');
    expect(serialized).not.toContain('500000');
  });

  it('hasApprovedExpertProfile is true only when BOTH expertProfileId and expertApprovedAt are set', async () => {
    mockFindForSessionSync.mockResolvedValue(
      sessionSyncUser({ expertProfileId: 'expert-1', expertApprovedAt: new Date('2025-01-01') })
    );
    const result = await deriveWorkspacesForUser(USER_ID);
    expect(result?.workspaces.some((w) => w.type === 'expert')).toBe(true);
  });

  it('hasApprovedExpertProfile is false when the profile exists but is not yet approved', async () => {
    mockFindForSessionSync.mockResolvedValue(
      sessionSyncUser({ expertProfileId: 'expert-1', expertApprovedAt: null })
    );
    const result = await deriveWorkspacesForUser(USER_ID);
    expect(result?.workspaces.some((w) => w.type === 'expert')).toBe(false);
  });

  it('returns null when findForSessionSync resolves null (user vanished) and there is no membership', async () => {
    mockFindForSessionSync.mockResolvedValue(null);
    mockFindWithCompany.mockResolvedValue(undefined);
    mockListCapabilityEligibleCompanies.mockResolvedValue([]);
    const result = await deriveWorkspacesForUser(USER_ID);
    expect(result).toBeNull();
  });

  it('passes the stored activeMode/activeCompanyId through to the derivation', async () => {
    mockFindForSessionSync.mockResolvedValue(
      sessionSyncUser({ activeMode: 'client', activeCompanyId: PERSONAL_ID })
    );
    const result = await deriveWorkspacesForUser(USER_ID);
    expect(result?.activeWorkspace).toMatchObject({ companyId: PERSONAL_ID });
  });
});
