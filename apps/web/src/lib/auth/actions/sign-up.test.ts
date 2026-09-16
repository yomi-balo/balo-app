import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockCreateUser = vi.fn();
const mockAuthenticateWithPassword = vi.fn();
const mockDeleteUser = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({
    userManagement: {
      createUser: (...args: unknown[]) => mockCreateUser(...args),
      authenticateWithPassword: (...args: unknown[]) => mockAuthenticateWithPassword(...args),
      deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
    },
  }),
  clientId: 'test-client-id',
}));

const mockSave = vi.fn();
let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

const mockCreateWithWorkspace = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    createWithWorkspace: (...args: unknown[]) => mockCreateWithWorkspace(...args),
  },
}));

// BAL-345: the domain auto-join match engine, dynamically imported in the fallback
// (verification-disabled) create path. vi.mock intercepts dynamic imports too.
const mockRunDomainJoinAndEmit = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/domain-join/run-domain-join', () => ({
  runDomainJoinAndEmit: (...args: unknown[]) => mockRunDomainJoinAndEmit(...args),
}));

// BAL-489 — the guest→member linkage helper. Mocked so this suite never loads the real
// repository (the `@balo/db` factory mock above has no `meetingGuestsRepository`, and a
// missing export would be swallowed by the helper's own catch — a silent false green).
const mockRunGuestConversionAndEmit = vi.fn<(...a: unknown[]) => Promise<void>>(() =>
  Promise.resolve()
);
vi.mock('@/lib/guest-conversion/run-guest-conversion', () => ({
  runGuestConversionAndEmit: (...a: unknown[]) => mockRunGuestConversionAndEmit(...a),
}));

import { signUpAction } from './sign-up';
import type { UnifiedSignUpFormData } from '@/components/balo/auth/schemas';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'Passw0rd'; // NOSONAR — test fixture, not a real credential

function validInput(): UnifiedSignUpFormData {
  return { email: 'jane@example.com', password: TEST_PASSWORD };
}

function mockWorkOSUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workos-user-1',
    email: 'jane@example.com',
    firstName: null,
    lastName: null,
    emailVerified: false,
    ...overrides,
  };
}

function mockAuthResponse() {
  return { accessToken: 'at_test', refreshToken: 'rt_test', user: mockWorkOSUser() };
}

function mockDbResult() {
  return {
    user: {
      id: 'user-1',
      email: 'jane@example.com',
      firstName: null,
      lastName: null,
      activeMode: 'client',
    },
    company: { id: 'co-1', name: 'My Workspace' },
    membership: { role: 'owner' },
  };
}

function setupFallbackPath(workosOverrides: Record<string, unknown> = {}) {
  const workosUser = mockWorkOSUser(workosOverrides);
  mockCreateUser.mockResolvedValue(workosUser);
  mockAuthenticateWithPassword.mockResolvedValue({
    accessToken: 'at_test',
    refreshToken: 'rt_test',
    user: workosUser,
  });
  mockCreateWithWorkspace.mockResolvedValue(mockDbResult());
  mockSave.mockResolvedValue(undefined);
}

// ── Tests ───────────────────────────────────────────────────────

describe('signUpAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { save: mockSave };
  });

  describe('input validation', () => {
    it('returns error for invalid email', async () => {
      const result = await signUpAction({ ...validInput(), email: 'bad' });
      expect(result).toEqual({
        success: false,
        error: 'Please enter a valid email address',
      });
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it('returns error for short password', async () => {
      const result = await signUpAction({ ...validInput(), password: 'Ab1' }); // NOSONAR
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('at least 8 characters');
      }
    });

    it('returns first validation error when multiple fields are invalid', async () => {
      const result = await signUpAction({
        email: '',
        password: '',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeTruthy();
      }
      expect(mockCreateUser).not.toHaveBeenCalled();
    });
  });

  describe('WorkOS user creation', () => {
    it('calls createUser with email and password only (no names)', async () => {
      setupFallbackPath();
      await signUpAction(validInput());
      expect(mockCreateUser).toHaveBeenCalledWith({
        email: 'jane@example.com',
        password: TEST_PASSWORD,
      });
    });

    it('returns generic error when createUser throws with email_already_exists (no enumeration)', async () => {
      mockCreateUser.mockRejectedValue(
        Object.assign(new Error('Duplicate'), { code: 'email_already_exists' })
      );
      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Invalid email or password. Please try again.',
      });
      expect(mockAuthenticateWithPassword).not.toHaveBeenCalled();
    });

    it('returns default error when createUser throws with unknown error', async () => {
      mockCreateUser.mockRejectedValue(new Error('network failure'));
      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });
  });

  describe('authentication after creation', () => {
    it('authenticates with correct parameters after user creation', async () => {
      setupFallbackPath();
      await signUpAction(validInput());
      expect(mockAuthenticateWithPassword).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        email: 'jane@example.com',
        password: TEST_PASSWORD,
      });
    });
  });

  describe('email verification required path', () => {
    it('returns pendingAuthToken when authenticateWithPassword returns pending token', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockResolvedValue({
        pendingAuthenticationToken: 'pat_test_123',
        user: mockWorkOSUser(),
      });

      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: true,
        data: {
          pendingAuthToken: 'pat_test_123',
          email: 'jane@example.com',
        },
      });
      expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
    });

    it('returns pendingAuthToken when authenticateWithPassword throws email_verification_required', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockRejectedValue(
        Object.assign(new Error('Email verification required'), {
          code: 'email_verification_required',
          rawData: {
            code: 'email_verification_required',
            pending_authentication_token: 'pat_error_path_123',
          },
        })
      );

      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: true,
        data: {
          pendingAuthToken: 'pat_error_path_123',
          email: 'jane@example.com',
        },
      });
      expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });
  });

  describe('fallback path (no verification required)', () => {
    it('creates DB user + session when no verification needed', async () => {
      setupFallbackPath();
      const result = await signUpAction(validInput());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.verified).toBe(true);
        expect(result.data?.needsOnboarding).toBe(true);
        expect(result.data?.userId).toBe('user-1');
      }
    });

    it('calls createWithWorkspace with null names', async () => {
      setupFallbackPath();
      await signUpAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: null,
          lastName: null,
        })
      );
    });

    it('sets session.user with correct fields on success', async () => {
      setupFallbackPath();
      await signUpAction(validInput());
      expect(mockSessionObj.user).toEqual({
        id: 'user-1',
        email: 'jane@example.com',
        firstName: null,
        lastName: null,
        activeMode: 'client',
        onboardingCompleted: false,
        platformRole: 'user',
        companyId: 'co-1',
        companyName: 'My Workspace',
        companyRole: 'owner',
        avatarUrl: null,
      });
    });

    it('sets accessToken and refreshToken from auth response', async () => {
      setupFallbackPath();
      await signUpAction(validInput());
      expect(mockSessionObj.accessToken).toBe('at_test');
      expect(mockSessionObj.refreshToken).toBe('rt_test');
    });

    it('calls session.save()', async () => {
      setupFallbackPath();
      await signUpAction(validInput());
      expect(mockSave).toHaveBeenCalledOnce();
    });
  });

  describe('post-creation failure and orphan cleanup', () => {
    it('deletes orphaned WorkOS user when authenticateWithPassword fails (non-verification)', async () => {
      const workosUser = mockWorkOSUser();
      mockCreateUser.mockResolvedValue(workosUser);
      mockAuthenticateWithPassword.mockRejectedValue(new Error('auth failed'));
      mockDeleteUser.mockResolvedValue(undefined);

      const result = await signUpAction(validInput());
      expect(mockDeleteUser).toHaveBeenCalledWith('workos-user-1');
      expect(result.success).toBe(false);
    });

    it('deletes orphaned WorkOS user when DB transaction fails', async () => {
      const workosUser = mockWorkOSUser();
      mockCreateUser.mockResolvedValue(workosUser);
      mockAuthenticateWithPassword.mockResolvedValue(mockAuthResponse());
      mockCreateWithWorkspace.mockRejectedValue(new Error('DB error'));
      mockDeleteUser.mockResolvedValue(undefined);

      const result = await signUpAction(validInput());
      expect(mockDeleteUser).toHaveBeenCalledWith('workos-user-1');
      expect(result.success).toBe(false);
    });

    it('still returns the original error when orphan cleanup itself fails', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockRejectedValue(
        Object.assign(new Error('auth error'), { code: 'invalid_credentials' })
      );
      mockDeleteUser.mockRejectedValue(new Error('delete also failed'));

      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Invalid email or password. Please try again.',
      });
    });

    it('returns mapped error from the post-creation failure', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockResolvedValue(mockAuthResponse());
      mockCreateWithWorkspace.mockRejectedValue(new Error('generic DB error'));
      mockDeleteUser.mockResolvedValue(undefined);

      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });
  });

  // BAL-345 — domain auto-join seam wiring (verification-disabled fallback path).
  describe('domain auto-join wiring (BAL-345)', () => {
    it('runs the match engine with the WorkOS emailVerified flag (true)', async () => {
      setupFallbackPath({ emailVerified: true });
      await signUpAction(validInput());
      expect(mockRunDomainJoinAndEmit).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'jane@example.com',
        emailVerified: true,
      });
    });

    it('passes emailVerified: false when WorkOS reports it unverified (never hardcoded)', async () => {
      setupFallbackPath({ emailVerified: false });
      await signUpAction(validInput());
      expect(mockRunDomainJoinAndEmit).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false })
      );
    });

    it('does NOT run the match engine on the verification-required path (no user created)', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockResolvedValue({
        pendingAuthenticationToken: 'pat_test_123',
        user: mockWorkOSUser(),
      });

      await signUpAction(validInput());
      expect(mockRunDomainJoinAndEmit).not.toHaveBeenCalled();
    });

    it('a throw from the match engine is swallowed — sign-up still succeeds', async () => {
      setupFallbackPath({ emailVerified: true });
      mockRunDomainJoinAndEmit.mockRejectedValueOnce(new Error('engine boom'));
      const result = await signUpAction(validInput());
      expect(result.success).toBe(true);
    });
  });

  // BAL-489 — guest→member linkage seam wiring (verification-disabled fallback path).
  describe('guest → member linkage wiring (BAL-489)', () => {
    it('runs the helper with the SAME facts as domain-join, called once', async () => {
      setupFallbackPath({ emailVerified: true });
      await signUpAction(validInput());
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledTimes(1);
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'jane@example.com',
        emailVerified: true,
      });
    });

    it('passes emailVerified: false when WorkOS reports it unverified (never hardcoded)', async () => {
      setupFallbackPath({ emailVerified: false });
      await signUpAction(validInput());
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false })
      );
    });

    it('does NOT run on the verification-required path (no user created)', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockResolvedValue({
        pendingAuthenticationToken: 'pat_test_123',
        user: mockWorkOSUser(),
      });

      await signUpAction(validInput());
      expect(mockRunGuestConversionAndEmit).not.toHaveBeenCalled();
    });

    it('a linkage rejection is swallowed — sign-up still succeeds', async () => {
      setupFallbackPath({ emailVerified: true });
      mockRunGuestConversionAndEmit.mockRejectedValueOnce(new Error('linkage boom'));
      const result = await signUpAction(validInput());
      expect(result.success).toBe(true);
    });

    it('independence (R10): a domain-join rejection does not stop the linkage call, and sign-up still succeeds', async () => {
      setupFallbackPath({ emailVerified: true });
      mockRunDomainJoinAndEmit.mockRejectedValueOnce(new Error('domain-join boom'));
      const result = await signUpAction(validInput());
      expect(result.success).toBe(true);
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledTimes(1);
    });
  });
});
