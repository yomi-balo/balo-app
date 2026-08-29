import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockDeriveWorkspacesForUser = vi.fn();
vi.mock('./derive-workspaces', () => ({
  deriveWorkspacesForUser: (...args: unknown[]) => mockDeriveWorkspacesForUser(...args),
}));

// The seal is exercised for real in `switch-token.test.ts`; here it is stubbed to a readable
// projection of its payload so this suite can assert WHAT gets sealed, not how.
const mockSealWorkspaceSwitchToken = vi.fn(
  async (payload: { userId: string; targetKey: string; returnTo: string }) =>
    `sealed(${payload.userId}|${payload.targetKey}|${payload.returnTo})`
);
vi.mock('./switch-token', () => ({
  WORKSPACE_SWITCH_TOKEN_PARAM: 't',
  sealWorkspaceSwitchToken: (payload: { userId: string; targetKey: string; returnTo: string }) =>
    mockSealWorkspaceSwitchToken(payload),
}));

import {
  resolveWorkspaceForEntity,
  workspaceSwitchRedirectPath,
} from './resolve-workspace-for-entity';

const ACTIVE_ID = 'company-active';
const OTHER_ID = 'company-other';
const REP_ID = 'company-represented';
const user = { id: 'user-1' } as never;

const activeWorkspace = {
  type: 'company' as const,
  key: `company:${ACTIVE_ID}`,
  companyId: ACTIVE_ID,
  name: 'Active Co',
  via: 'membership' as const,
  isPersonal: false,
};

const otherWorkspace = {
  type: 'company' as const,
  key: `company:${OTHER_ID}`,
  companyId: OTHER_ID,
  name: 'Other Co',
  via: 'membership' as const,
  isPersonal: false,
};

const representationWorkspace = {
  type: 'company' as const,
  key: `company:${REP_ID}`,
  companyId: REP_ID,
  name: 'Represented Co',
  via: 'representation' as const,
  isPersonal: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveWorkspaceForEntity', () => {
  it('returns the other workspace when the actor holds it (and it is not active)', async () => {
    mockDeriveWorkspacesForUser.mockResolvedValue({
      workspaces: [activeWorkspace, otherWorkspace],
      activeWorkspace,
      session: {
        activeMode: 'client',
        companyId: ACTIVE_ID,
        companyName: 'Active Co',
        companyRole: 'owner',
      },
    });

    const result = await resolveWorkspaceForEntity(user, { companyId: OTHER_ID });
    expect(result).toEqual(otherWorkspace);
  });

  it('returns null when the target is ALREADY the active workspace (loop guard)', async () => {
    mockDeriveWorkspacesForUser.mockResolvedValue({
      workspaces: [activeWorkspace],
      activeWorkspace,
      session: {
        activeMode: 'client',
        companyId: ACTIVE_ID,
        companyName: 'Active Co',
        companyRole: 'owner',
      },
    });

    const result = await resolveWorkspaceForEntity(user, { companyId: ACTIVE_ID });
    expect(result).toBeNull();
  });

  it('returns null when no workspace owns the entity', async () => {
    mockDeriveWorkspacesForUser.mockResolvedValue({
      workspaces: [activeWorkspace],
      activeWorkspace,
      session: {
        activeMode: 'client',
        companyId: ACTIVE_ID,
        companyName: 'Active Co',
        companyRole: 'owner',
      },
    });

    const result = await resolveWorkspaceForEntity(user, { companyId: 'company-unowned' });
    expect(result).toBeNull();
  });

  it('returns null when deriveWorkspacesForUser resolves null (no company workspace at all)', async () => {
    mockDeriveWorkspacesForUser.mockResolvedValue(null);
    const result = await resolveWorkspaceForEntity(user, { companyId: OTHER_ID });
    expect(result).toBeNull();
  });

  it('R1 — a representation workspace is NEVER returned as a redirect target', async () => {
    mockDeriveWorkspacesForUser.mockResolvedValue({
      workspaces: [activeWorkspace, representationWorkspace],
      activeWorkspace,
      session: {
        activeMode: 'client',
        companyId: ACTIVE_ID,
        companyName: 'Active Co',
        companyRole: 'owner',
      },
    });

    const result = await resolveWorkspaceForEntity(user, { companyId: REP_ID });
    expect(result).toBeNull();
  });
});

describe('workspaceSwitchRedirectPath', () => {
  it('seals the user, the target key and returnTo — and puts NO raw target in the query', async () => {
    const path = await workspaceSwitchRedirectPath('user-1', otherWorkspace, '/projects/req-1');

    expect(mockSealWorkspaceSwitchToken).toHaveBeenCalledWith({
      userId: 'user-1',
      targetKey: otherWorkspace.key,
      returnTo: '/projects/req-1',
    });

    const params = new URL(path, 'http://localhost:3000').searchParams;
    expect(params.get('t')).toBe(`sealed(user-1|${otherWorkspace.key}|/projects/req-1)`);
    // returnTo is repeated in the clear ONLY so an expired token still lands on the page.
    expect(params.get('returnTo')).toBe('/projects/req-1');
    // The switch target must NEVER be readable (or forgeable) from a raw query param.
    expect(params.get('to')).toBeNull();
  });

  it('works for the expert workspace', async () => {
    const path = await workspaceSwitchRedirectPath(
      'user-1',
      { type: 'expert', key: 'expert' },
      '/dashboard'
    );
    const url = new URL(path, 'http://localhost:3000');
    expect(url.pathname).toBe('/api/auth/switch-workspace');
    expect(url.searchParams.get('t')).toBe('sealed(user-1|expert|/dashboard)');
    expect(url.searchParams.get('returnTo')).toBe('/dashboard');
  });
});
