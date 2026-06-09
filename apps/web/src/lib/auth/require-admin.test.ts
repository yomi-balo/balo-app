import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { SessionUser } from './session';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

let mockSessionObj: { user?: Partial<SessionUser> } | undefined;
vi.mock('./session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { requireAdmin } from './require-admin';

// ── Helpers ─────────────────────────────────────────────────────

function buildUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    email: 'admin@balo.expert',
    firstName: 'Ada',
    lastName: 'Admin',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'admin',
    companyId: 'company-1',
    companyName: 'Balo',
    companyRole: 'owner',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('requireAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: buildUser() };
  });

  it('returns the session user for an admin', async () => {
    const user = buildUser({ platformRole: 'admin' });
    mockSessionObj = { user };

    await expect(requireAdmin()).resolves.toEqual(user);
  });

  it('returns the session user for a super_admin', async () => {
    const user = buildUser({ platformRole: 'super_admin' });
    mockSessionObj = { user };

    await expect(requireAdmin()).resolves.toEqual(user);
  });

  it("throws 'Unauthorized' when there is no session", async () => {
    mockSessionObj = undefined;

    await expect(requireAdmin()).rejects.toThrow('Unauthorized');
  });

  it("throws 'Unauthorized' when the session has no user", async () => {
    mockSessionObj = {};

    await expect(requireAdmin()).rejects.toThrow('Unauthorized');
  });

  it("throws 'Unauthorized' when the user has no id", async () => {
    mockSessionObj = { user: buildUser({ id: undefined as unknown as string }) };

    await expect(requireAdmin()).rejects.toThrow('Unauthorized');
  });

  it("throws 'Forbidden' for a non-admin platform role", async () => {
    mockSessionObj = { user: buildUser({ platformRole: 'user' }) };

    await expect(requireAdmin()).rejects.toThrow('Forbidden');
  });
});
