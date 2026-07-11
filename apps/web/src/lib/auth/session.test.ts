import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('server-only', () => ({}));

vi.mock('./config', () => ({
  sessionConfig: {
    cookieName: 'balo_session',
    password: 'x'.repeat(32),
    cookieOptions: {},
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve({})),
}));

let mockSession: Record<string, unknown>;
vi.mock('iron-session', () => ({
  getIronSession: vi.fn(() => Promise.resolve(mockSession)),
}));

import { requireUser, requireOnboardedUser } from './session';

// ── Helpers ─────────────────────────────────────────────────────

const baseUser = {
  id: 'user-1',
  email: 'a@b.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  avatarUrl: null,
  activeMode: 'client',
  platformRole: 'user',
  companyId: 'company-1',
  companyName: 'Test Co',
  companyRole: 'owner',
};

function userWith(onboardingCompleted: unknown): Record<string, unknown> {
  return { ...baseUser, onboardingCompleted };
}

// ── Tests ───────────────────────────────────────────────────────

describe('requireOnboardedUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: userWith(true) };
  });

  it('throws Unauthorized when there is no user', async () => {
    mockSession = {};
    await expect(requireOnboardedUser()).rejects.toThrow('Unauthorized');
  });

  it('returns the user when onboardingCompleted is true', async () => {
    mockSession = { user: userWith(true) };
    const user = await requireOnboardedUser();
    expect(user.id).toBe('user-1');
  });

  it('throws Onboarding not completed when onboardingCompleted is false', async () => {
    mockSession = { user: userWith(false) };
    await expect(requireOnboardedUser()).rejects.toThrow('Onboarding not completed');
  });

  it('throws Onboarding not completed when onboardingCompleted is undefined (fail-closed)', async () => {
    mockSession = { user: { ...baseUser } };
    await expect(requireOnboardedUser()).rejects.toThrow('Onboarding not completed');
  });

  it('throws Onboarding not completed when onboardingCompleted is null (fail-closed)', async () => {
    mockSession = { user: userWith(null) };
    await expect(requireOnboardedUser()).rejects.toThrow('Onboarding not completed');
  });
});

describe('requireUser (unchanged contract — regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an un-onboarded user WITHOUT throwing (contract not overloaded)', async () => {
    mockSession = { user: userWith(false) };
    const user = await requireUser();
    expect(user.id).toBe('user-1');
    expect(user.onboardingCompleted).toBe(false);
  });

  it('throws Unauthorized when there is no user', async () => {
    mockSession = {};
    await expect(requireUser()).rejects.toThrow('Unauthorized');
  });
});
