import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockAuthenticateWithPassword = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({
    userManagement: {
      authenticateWithPassword: (...args: unknown[]) => mockAuthenticateWithPassword(...args),
    },
  }),
  clientId: 'test-client-id',
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

const mockFindByWorkosId = vi.fn();
const mockFindByEmail = vi.fn();
const mockRelinkWorkosId = vi.fn();
const mockFindWithCompany = vi.fn();
const mockCreateWithWorkspace = vi.fn();
const mockTouch = vi.fn();
const mockExpertProfileFindFirst = vi.fn();
// BAL-362: the real `resolveLinkedUser` runs against this mocked repository — so the
// mock must expose findByEmail + relinkWorkosId (the resolver's re-link seam).
vi.mock('@balo/db', () => ({
  usersRepository: {
    findByWorkosId: (...args: unknown[]) => mockFindByWorkosId(...args),
    findByEmail: (...args: unknown[]) => mockFindByEmail(...args),
    relinkWorkosId: (...args: unknown[]) => mockRelinkWorkosId(...args),
    findWithCompany: (...args: unknown[]) => mockFindWithCompany(...args),
    createWithWorkspace: (...args: unknown[]) => mockCreateWithWorkspace(...args),
    touch: (...args: unknown[]) => mockTouch(...args),
  },
  db: {
    query: {
      expertProfiles: {
        findFirst: (...args: unknown[]) => mockExpertProfileFindFirst(...args),
      },
    },
  },
}));

// BAL-344: the orphan-recovery branch emits domain capture — stub it (this suite
// tests sign-in logic, not emission; the emit is covered in verify-email.test.ts).
vi.mock('@/lib/analytics/party-domains', () => ({ emitDomainCapture: vi.fn() }));

// BAL-362: sign-in now emits method-agnostic server analytics on re-link / conflict.
// Mock the seam so posthog-node / next/server `after()` stays out of the test.
const mockTrackServerAndFlush = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  AUTH_SERVER_EVENTS: { AUTH_RELINK: 'auth_relink', AUTH_CONFLICT: 'auth_conflict' },
}));

// BAL-345: the domain auto-join match engine, wired only in the orphan-recovery
// (!user) create branch. Mocked to assert the WorkOS emailVerified flag is passed
// through (never hardcoded) and that a throw never breaks sign-in.
const mockRunDomainJoinAndEmit = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/domain-join/run-domain-join', () => ({
  runDomainJoinAndEmit: (...args: unknown[]) => mockRunDomainJoinAndEmit(...args),
}));

import { signInAction } from './sign-in';
import { ACCOUNT_EXISTS_MESSAGE } from '@/lib/auth/resolve-identity';
import type { SignInFormData } from '@/components/balo/auth/schemas';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'Passw0rd'; // NOSONAR — test fixture, not a real credential

function validInput(): SignInFormData {
  return { email: 'user@example.com', password: TEST_PASSWORD };
}

function mockWorkOSAuthResponse(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'at_test',
    refreshToken: 'rt_test',
    user: {
      id: 'workos-1',
      email: 'user@example.com',
      firstName: 'Test',
      lastName: 'User',
      profilePictureUrl: null,
      emailVerified: true,
      ...overrides,
    },
  };
}

function mockBaloUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    firstName: 'Test',
    lastName: 'User',
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    ...overrides,
  };
}

function mockCompanyData(userOverrides: Record<string, unknown> = {}) {
  return {
    ...mockBaloUser(userOverrides),
    companyMemberships: [{ role: 'owner', company: { id: 'co-1', name: 'Test Co' } }],
  };
}

function setupHappyPath(userOverrides: Record<string, unknown> = {}) {
  mockAuthenticateWithPassword.mockResolvedValue(mockWorkOSAuthResponse());
  mockFindByWorkosId.mockResolvedValue(mockBaloUser(userOverrides));
  mockFindWithCompany.mockResolvedValue(mockCompanyData(userOverrides));
  mockTouch.mockResolvedValue(undefined);
  mockSave.mockResolvedValue(undefined);
}

// ── Tests ───────────────────────────────────────────────────────

describe('signInAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { save: mockSave };
    mockTouch.mockResolvedValue(undefined);
    // BAL-362: default the email fallback to a miss so the create / findByWorkosId
    // paths are unaffected. Re-link / conflict tests override per-case.
    mockFindByEmail.mockResolvedValue(null);
  });

  describe('input validation', () => {
    it('returns error for empty email', async () => {
      const result = await signInAction({ email: '', password: 'pass' }); // NOSONAR
      expect(result).toEqual({ success: false, error: 'Email is required' });
      expect(mockAuthenticateWithPassword).not.toHaveBeenCalled();
    });

    it('returns error for empty password', async () => {
      const result = await signInAction({ email: 'user@example.com', password: '' });
      expect(result).toEqual({ success: false, error: 'Password is required' });
    });

    it('returns error for invalid email format', async () => {
      const result = await signInAction({ email: 'bad', password: 'pass' }); // NOSONAR
      expect(result.success).toBe(false);
      expect(mockAuthenticateWithPassword).not.toHaveBeenCalled();
    });
  });

  describe('WorkOS authentication', () => {
    it('calls authenticateWithPassword with correct parameters', async () => {
      setupHappyPath();
      await signInAction(validInput());
      expect(mockAuthenticateWithPassword).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        email: 'user@example.com',
        password: TEST_PASSWORD,
      });
    });

    it('returns mapped error when authentication fails with known code', async () => {
      mockAuthenticateWithPassword.mockRejectedValue(
        Object.assign(new Error('bad'), { code: 'invalid_credentials' })
      );
      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Invalid email or password. Please try again.',
      });
    });

    it('returns default error when authentication fails with unknown error', async () => {
      mockAuthenticateWithPassword.mockRejectedValue(new Error('network error'));
      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });
  });

  describe('user lookup and orphan recovery', () => {
    it('finds existing Balo user by WorkOS ID', async () => {
      setupHappyPath();
      await signInAction(validInput());
      expect(mockFindByWorkosId).toHaveBeenCalledWith('workos-1');
      expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
    });

    it('auto-creates DB user when findByWorkosId returns undefined (orphan recovery)', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(mockWorkOSAuthResponse());
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockCreateWithWorkspace.mockResolvedValue({ user: mockBaloUser() });
      mockFindWithCompany.mockResolvedValue(mockCompanyData());
      mockTouch.mockResolvedValue(undefined);
      mockSave.mockResolvedValue(undefined);

      await signInAction(validInput());

      expect(mockCreateWithWorkspace).toHaveBeenCalledWith({
        workosId: 'workos-1',
        email: 'user@example.com',
        firstName: 'Test',
        lastName: 'User',
        avatarUrl: null,
        emailVerified: true,
        activeMode: 'client',
      });
    });

    it('passes profilePictureUrl as avatarUrl during orphan recovery', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(
        mockWorkOSAuthResponse({ profilePictureUrl: 'https://img.example.com/pic.jpg' })
      );
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockCreateWithWorkspace.mockResolvedValue({ user: mockBaloUser() });
      mockFindWithCompany.mockResolvedValue(mockCompanyData());
      mockTouch.mockResolvedValue(undefined);
      mockSave.mockResolvedValue(undefined);

      await signInAction(validInput());

      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ avatarUrl: 'https://img.example.com/pic.jpg' })
      );
    });

    it('passes emailVerified: false when WorkOS emailVerified is null', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(
        mockWorkOSAuthResponse({ emailVerified: null })
      );
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockCreateWithWorkspace.mockResolvedValue({ user: mockBaloUser() });
      mockFindWithCompany.mockResolvedValue(mockCompanyData());
      mockTouch.mockResolvedValue(undefined);
      mockSave.mockResolvedValue(undefined);

      await signInAction(validInput());

      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false })
      );
    });
  });

  describe('company membership loading', () => {
    it('returns error when findWithCompany returns null', async () => {
      setupHappyPath();
      mockFindWithCompany.mockResolvedValue(null);

      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Account configuration error. Please contact support.',
        code: 'no_company_membership',
      });
    });

    it('returns error when companyMemberships array is empty', async () => {
      setupHappyPath();
      mockFindWithCompany.mockResolvedValue({
        ...mockBaloUser(),
        companyMemberships: [],
      });

      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Account configuration error. Please contact support.',
        code: 'no_company_membership',
      });
    });

    it('returns error when companyMemberships is undefined', async () => {
      setupHappyPath();
      mockFindWithCompany.mockResolvedValue({
        ...mockBaloUser(),
        companyMemberships: undefined,
      });

      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Account configuration error. Please contact support.',
        code: 'no_company_membership',
      });
    });
  });

  describe('expert profile loading', () => {
    it('loads expert profile when activeMode is "expert"', async () => {
      setupHappyPath({ activeMode: 'expert' });
      mockExpertProfileFindFirst.mockResolvedValue({
        id: 'ep-1',
        verticalId: 'v-1',
        userId: 'user-1',
      });

      await signInAction(validInput());

      expect(mockExpertProfileFindFirst).toHaveBeenCalled();
      expect(mockSessionObj.user).toEqual(
        expect.objectContaining({
          expertProfileId: 'ep-1',
          verticalId: 'v-1',
        })
      );
    });

    it('does NOT load expert profile when activeMode is "client"', async () => {
      setupHappyPath({ activeMode: 'client' });
      await signInAction(validInput());
      expect(mockExpertProfileFindFirst).not.toHaveBeenCalled();
      expect(mockSessionObj.user).not.toHaveProperty('expertProfileId');
    });

    it('omits expert fields when expert profile query returns null', async () => {
      setupHappyPath({ activeMode: 'expert' });
      mockExpertProfileFindFirst.mockResolvedValue(null);

      await signInAction(validInput());

      expect(mockSessionObj.user).not.toHaveProperty('expertProfileId');
    });
  });

  describe('session setup', () => {
    it('sets session.user with all required fields for client mode', async () => {
      setupHappyPath();
      await signInAction(validInput());

      expect(mockSessionObj.user).toEqual({
        id: 'user-1',
        email: 'user@example.com',
        firstName: 'Test',
        lastName: 'User',
        activeMode: 'client',
        onboardingCompleted: true,
        platformRole: 'user',
        companyId: 'co-1',
        companyName: 'Test Co',
        companyRole: 'owner',
        avatarUrl: null,
      });
    });

    it('sets accessToken and refreshToken from auth response', async () => {
      setupHappyPath();
      await signInAction(validInput());
      expect(mockSessionObj.accessToken).toBe('at_test');
      expect(mockSessionObj.refreshToken).toBe('rt_test');
    });

    it('calls session.save()', async () => {
      setupHappyPath();
      await signInAction(validInput());
      expect(mockSave).toHaveBeenCalledOnce();
    });
  });

  describe('fire-and-forget touch', () => {
    it('calls usersRepository.touch with user ID', async () => {
      setupHappyPath();
      await signInAction(validInput());
      expect(mockTouch).toHaveBeenCalledWith('user-1');
    });

    it('does not block response when touch rejects', async () => {
      setupHappyPath();
      mockTouch.mockRejectedValue(new Error('DB down'));

      const result = await signInAction(validInput());
      expect(result.success).toBe(true);
    });
  });

  describe('success response', () => {
    it('returns needsOnboarding: false when onboardingCompleted is true', async () => {
      setupHappyPath({ onboardingCompleted: true });
      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: true,
        data: {
          needsOnboarding: false,
          userId: 'user-1',
          email: 'user@example.com',
          activeMode: 'client',
          platformRole: 'user',
        },
      });
    });

    it('returns needsOnboarding: true when onboardingCompleted is false', async () => {
      setupHappyPath({ onboardingCompleted: false });
      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: true,
        data: {
          needsOnboarding: true,
          userId: 'user-1',
          email: 'user@example.com',
          activeMode: 'client',
          platformRole: 'user',
        },
      });
    });
  });

  describe('error handling', () => {
    it('returns mapped error for any exception after authentication', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(mockWorkOSAuthResponse());
      mockFindByWorkosId.mockRejectedValue(new Error('DB error'));

      const result = await signInAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });
  });

  // BAL-345 — domain auto-join seam wiring (orphan-recovery create branch only).
  describe('domain auto-join wiring (BAL-345)', () => {
    function setupOrphanRecovery(workosOverrides: Record<string, unknown> = {}) {
      mockAuthenticateWithPassword.mockResolvedValue(mockWorkOSAuthResponse(workosOverrides));
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockCreateWithWorkspace.mockResolvedValue({ user: mockBaloUser() });
      mockFindWithCompany.mockResolvedValue(mockCompanyData());
      mockTouch.mockResolvedValue(undefined);
      mockSave.mockResolvedValue(undefined);
    }

    it('runs the match engine with the WorkOS emailVerified flag (true)', async () => {
      setupOrphanRecovery({ emailVerified: true });
      await signInAction(validInput());
      expect(mockRunDomainJoinAndEmit).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'user@example.com',
        emailVerified: true,
      });
    });

    it('passes emailVerified: false when WorkOS reports it unverified (never hardcoded true)', async () => {
      setupOrphanRecovery({ emailVerified: null });
      await signInAction(validInput());
      expect(mockRunDomainJoinAndEmit).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false })
      );
    });

    it('does NOT run the match engine for an existing (non-orphan) user', async () => {
      setupHappyPath();
      await signInAction(validInput());
      expect(mockRunDomainJoinAndEmit).not.toHaveBeenCalled();
    });

    it('a throw from the match engine is swallowed — sign-in still succeeds', async () => {
      setupOrphanRecovery();
      mockRunDomainJoinAndEmit.mockRejectedValueOnce(new Error('engine boom'));
      const result = await signInAction(validInput());
      expect(result.success).toBe(true);
    });
  });

  // BAL-362 — identity re-link + conflict via the shared resolveLinkedUser seam.
  describe('identity re-link + conflict (BAL-362)', () => {
    function setupRelink() {
      mockAuthenticateWithPassword.mockResolvedValue(
        mockWorkOSAuthResponse({ emailVerified: true })
      );
      mockFindByWorkosId.mockResolvedValue(undefined); // workosId miss
      mockFindByEmail.mockResolvedValue({
        id: 'user-1',
        workosId: 'W1',
        email: 'user@example.com',
        emailVerified: true, // live verified email → safe to re-link
      });
      mockRelinkWorkosId.mockResolvedValue(mockBaloUser()); // re-linked returning user
      mockFindWithCompany.mockResolvedValue(mockCompanyData());
      mockTouch.mockResolvedValue(undefined);
      mockSave.mockResolvedValue(undefined);
    }

    it('(a) re-links a workosId miss onto a live verified-email user and takes the returning path', async () => {
      setupRelink();

      const result = await signInAction(validInput());

      expect(result.success).toBe(true);
      expect(mockRelinkWorkosId).toHaveBeenCalledWith('user-1', 'workos-1', {
        actorUserId: 'user-1',
        oldWorkosId: 'W1',
        email: 'user@example.com',
        emailVerified: true,
      });
      expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
      // A re-linked user is NOT new — no orphan-recovery domain-join runs.
      expect(mockRunDomainJoinAndEmit).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith('auth_relink', {
        distinct_id: 'user-1',
        method: 'password',
      });
    });

    it('(b) refuses to re-link when the incoming profile is unverified — account_exists conflict', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(
        mockWorkOSAuthResponse({ emailVerified: false })
      );
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue({
        id: 'user-9',
        workosId: 'W1',
        email: 'user@example.com',
        emailVerified: true,
      });

      const result = await signInAction(validInput());

      expect(result).toEqual({
        success: false,
        error: ACCOUNT_EXISTS_MESSAGE,
        code: 'account_exists',
      });
      expect(mockRelinkWorkosId).not.toHaveBeenCalled();
      expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith('auth_conflict', {
        distinct_id: 'user-9',
        method: 'password',
      });
    });

    it('(c) refuses to re-link onto an unverified existing row (incoming verified) — account_exists conflict', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(
        mockWorkOSAuthResponse({ emailVerified: true })
      );
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue({
        id: 'user-9',
        workosId: 'W1',
        email: 'user@example.com',
        emailVerified: false, // existing row unverified → resolver precheck refuses
      });

      const result = await signInAction(validInput());

      expect(result).toEqual({
        success: false,
        error: ACCOUNT_EXISTS_MESSAGE,
        code: 'account_exists',
      });
      expect(mockRelinkWorkosId).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).toHaveBeenCalledWith('auth_conflict', {
        distinct_id: 'user-9',
        method: 'password',
      });
    });

    it('(d) creates when neither workosId nor email match (orphan recovery, unchanged)', async () => {
      mockAuthenticateWithPassword.mockResolvedValue(mockWorkOSAuthResponse());
      mockFindByWorkosId.mockResolvedValue(undefined);
      mockFindByEmail.mockResolvedValue(null);
      mockCreateWithWorkspace.mockResolvedValue({
        user: mockBaloUser(),
        domainCapture: { outcome: 'not_applicable' },
      });
      mockFindWithCompany.mockResolvedValue(mockCompanyData());

      const result = await signInAction(validInput());

      expect(result.success).toBe(true);
      expect(mockCreateWithWorkspace).toHaveBeenCalled();
      expect(mockRelinkWorkosId).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    });

    it('(e) resolves an existing workosId hit without consulting the email fallback', async () => {
      setupHappyPath();

      const result = await signInAction(validInput());

      expect(result.success).toBe(true);
      expect(mockFindByEmail).not.toHaveBeenCalled();
      expect(mockRelinkWorkosId).not.toHaveBeenCalled();
      expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
    });
  });
});
