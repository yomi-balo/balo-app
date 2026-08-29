import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

// `getWorkspacesForCurrentUser` is wrapped in React's `cache()`, which needs a request scope
// to run. In unit tests there is none, so `cache` is a pass-through — same precedent as
// `derive-workspaces.test.ts`.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const mockDeriveWorkspacesForUser = vi.fn();
vi.mock('./derive-workspaces', () => ({
  deriveWorkspacesForUser: (...args: unknown[]) => mockDeriveWorkspacesForUser(...args),
}));

import { getWorkspacesForCurrentUser } from './get-workspaces';

const USER_ID = 'user-1';

const companyWorkspace = {
  type: 'company' as const,
  key: 'company:11111111-1111-4111-8111-111111111111',
  companyId: '11111111-1111-4111-8111-111111111111',
  name: 'Northwind Industrial',
  via: 'membership' as const,
  isPersonal: false,
};
const expertWorkspace = { type: 'expert' as const, key: 'expert' as const };

function derivation(workspaces: unknown[]) {
  return {
    workspaces,
    activeWorkspace: workspaces[0],
    session: {
      activeMode: 'client',
      companyId: companyWorkspace.companyId,
      companyName: companyWorkspace.name,
      companyRole: 'owner',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getWorkspacesForCurrentUser', () => {
  it('returns the FULL derived list for the session user', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockDeriveWorkspacesForUser.mockResolvedValue(derivation([companyWorkspace, expertWorkspace]));

    await expect(getWorkspacesForCurrentUser()).resolves.toEqual([
      companyWorkspace,
      expertWorkspace,
    ]);
    expect(mockDeriveWorkspacesForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('derives the list FRESH rather than reading it off the session user', async () => {
    // ⚠ THE POINT OF THE WHOLE ACCESSOR. `SessionUser` carries no `workspaces` field — the
    // list overran the 4096-byte cookie limit — so a stale cookie cannot be the source here.
    // Passing a session user that (impossibly) carried one must change nothing.
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID, workspaces: ['stale-nonsense'] });
    mockDeriveWorkspacesForUser.mockResolvedValue(derivation([companyWorkspace]));

    await expect(getWorkspacesForCurrentUser()).resolves.toEqual([companyWorkspace]);
  });

  it('returns an empty list when there is no session user, without deriving', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    await expect(getWorkspacesForCurrentUser()).resolves.toEqual([]);
    expect(mockDeriveWorkspacesForUser).not.toHaveBeenCalled();
  });

  it('returns an empty list — not a throw — when the derivation is null (no company at all)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockDeriveWorkspacesForUser.mockResolvedValue(null);

    await expect(getWorkspacesForCurrentUser()).resolves.toEqual([]);
  });

  it('propagates a derivation failure instead of failing open with an empty list', async () => {
    // A read failure must not be indistinguishable from "you hold no workspaces": the same
    // fail-closed stance `deriveWorkspacesForUser` takes (it catches nothing either).
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });
    mockDeriveWorkspacesForUser.mockRejectedValue(new Error('connection terminated'));

    await expect(getWorkspacesForCurrentUser()).rejects.toThrow('connection terminated');
  });
});
