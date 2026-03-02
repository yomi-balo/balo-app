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

import { signUpAction } from './sign-up';
import type { SignUpFormData } from '@/components/balo/auth/schemas';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'Passw0rd'; // NOSONAR — test fixture, not a real credential

function validInput(): SignUpFormData {
  return { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', password: TEST_PASSWORD };
}

function mockWorkOSUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workos-user-1',
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    emailVerified: true,
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
      firstName: 'Jane',
      lastName: 'Doe',
      activeMode: 'client',
    },
    company: { id: 'co-1', name: "Jane's Workspace" },
    membership: { role: 'owner' },
  };
}

function setupHappyPath(workosOverrides: Record<string, unknown> = {}) {
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
        firstName: '',
        lastName: '',
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
    it('calls createUser with correct parameters', async () => {
      setupHappyPath();
      await signUpAction(validInput());
      expect(mockCreateUser).toHaveBeenCalledWith({
        email: 'jane@example.com',
        password: TEST_PASSWORD,
        firstName: 'Jane',
        lastName: 'Doe',
      });
    });

    it('returns mapped error when createUser throws with known code', async () => {
      mockCreateUser.mockRejectedValue(
        Object.assign(new Error('Duplicate'), { code: 'email_already_exists' })
      );
      const result = await signUpAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'An account with this email already exists. Try signing in instead.',
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
      setupHappyPath();
      await signUpAction(validInput());
      expect(mockAuthenticateWithPassword).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        email: 'jane@example.com',
        password: TEST_PASSWORD,
      });
    });
  });

  describe('database transaction', () => {
    it('calls createWithWorkspace with correct data', async () => {
      setupHappyPath();
      await signUpAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith({
        workosId: 'workos-user-1',
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        emailVerified: true,
        activeMode: 'client',
      });
    });

    it('passes emailVerified: false when WorkOS user emailVerified is null', async () => {
      setupHappyPath({ emailVerified: null });
      await signUpAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false })
      );
    });
  });

  describe('session setup', () => {
    it('sets session.user with correct fields on success', async () => {
      setupHappyPath();
      await signUpAction(validInput());
      expect(mockSessionObj.user).toEqual({
        id: 'user-1',
        email: 'jane@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        activeMode: 'client',
        onboardingCompleted: false,
        platformRole: 'user',
        companyId: 'co-1',
        companyName: "Jane's Workspace",
        companyRole: 'owner',
      });
    });

    it('sets accessToken and refreshToken from auth response', async () => {
      setupHappyPath();
      await signUpAction(validInput());
      expect(mockSessionObj.accessToken).toBe('at_test');
      expect(mockSessionObj.refreshToken).toBe('rt_test');
    });

    it('calls session.save()', async () => {
      setupHappyPath();
      await signUpAction(validInput());
      expect(mockSave).toHaveBeenCalledOnce();
    });
  });

  describe('success response', () => {
    it('returns { success: true, data: { needsOnboarding: true } }', async () => {
      setupHappyPath();
      const result = await signUpAction(validInput());
      expect(result).toEqual({ success: true, data: { needsOnboarding: true } });
    });
  });

  describe('post-creation failure and orphan cleanup', () => {
    it('deletes orphaned WorkOS user when authenticateWithPassword fails', async () => {
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
});
