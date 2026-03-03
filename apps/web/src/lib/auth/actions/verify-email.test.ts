import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockAuthenticateWithEmailVerification = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({
    userManagement: {
      authenticateWithEmailVerification: (...args: unknown[]) =>
        mockAuthenticateWithEmailVerification(...args),
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
const mockFindByWorkosId = vi.fn();
const mockFindWithCompany = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    createWithWorkspace: (...args: unknown[]) => mockCreateWithWorkspace(...args),
    findByWorkosId: (...args: unknown[]) => mockFindByWorkosId(...args),
    findWithCompany: (...args: unknown[]) => mockFindWithCompany(...args),
  },
}));

import { verifyEmailAction } from './verify-email';
import type { VerifyEmailInput } from './verify-email';

// ── Helpers ─────────────────────────────────────────────────────

function validInput(): VerifyEmailInput {
  return { pendingAuthToken: 'pat_test_token', code: '123456' };
}

function mockWorkOSUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workos-user-1',
    email: 'jane@example.com',
    firstName: null,
    lastName: null,
    emailVerified: true,
    ...overrides,
  };
}

function mockAuthResponse(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: 'at_test',
    refreshToken: 'rt_test',
    user: mockWorkOSUser(),
    ...overrides,
  };
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

function mockFindWithCompanyResult() {
  return {
    id: 'user-1',
    email: 'jane@example.com',
    firstName: null,
    lastName: null,
    activeMode: 'client',
    companyMemberships: [
      {
        role: 'owner',
        company: { id: 'co-1', name: 'My Workspace' },
      },
    ],
  };
}

function setupHappyPath() {
  mockAuthenticateWithEmailVerification.mockResolvedValue(mockAuthResponse());
  mockFindByWorkosId.mockResolvedValue(null); // User doesn't exist yet
  mockCreateWithWorkspace.mockResolvedValue(mockDbResult());
  mockFindWithCompany.mockResolvedValue(mockFindWithCompanyResult());
  mockSave.mockResolvedValue(undefined);
}

// ── Tests ───────────────────────────────────────────────────────

describe('verifyEmailAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { save: mockSave };
  });

  describe('input validation', () => {
    it('returns error for missing pendingAuthToken', async () => {
      const result = await verifyEmailAction({ pendingAuthToken: '', code: '123456' });
      expect(result).toEqual({
        success: false,
        error: 'Missing verification token',
      });
      expect(mockAuthenticateWithEmailVerification).not.toHaveBeenCalled();
    });

    it('returns error for code shorter than 6 digits', async () => {
      const result = await verifyEmailAction({ pendingAuthToken: 'pat_test', code: '12345' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('6 digits');
      }
    });

    it('returns error for code with non-numeric characters', async () => {
      const result = await verifyEmailAction({ pendingAuthToken: 'pat_test', code: '12345a' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('6 digits');
      }
    });

    it('returns error for code longer than 6 digits', async () => {
      const result = await verifyEmailAction({ pendingAuthToken: 'pat_test', code: '1234567' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('6 digits');
      }
    });

    it('accepts valid 6-digit numeric code', async () => {
      setupHappyPath();
      const result = await verifyEmailAction(validInput());
      expect(result.success).toBe(true);
    });
  });

  describe('WorkOS email verification', () => {
    it('calls authenticateWithEmailVerification with correct params', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockAuthenticateWithEmailVerification).toHaveBeenCalledWith({
        clientId: 'test-client-id',
        pendingAuthenticationToken: 'pat_test_token',
        code: '123456',
      });
    });

    it('returns mapped error when verification fails with known code', async () => {
      mockAuthenticateWithEmailVerification.mockRejectedValue(
        Object.assign(new Error('Invalid code'), { code: 'email_verification_failed' })
      );
      const result = await verifyEmailAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Invalid or expired verification code. Please try again.',
      });
    });

    it('returns mapped error when verification fails with expired code', async () => {
      mockAuthenticateWithEmailVerification.mockRejectedValue(
        Object.assign(new Error('Code expired'), { code: 'email_verification_code_expired' })
      );
      const result = await verifyEmailAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Your verification code has expired. Please request a new one.',
      });
    });

    it('returns default error for unknown errors', async () => {
      mockAuthenticateWithEmailVerification.mockRejectedValue(new Error('network failure'));
      const result = await verifyEmailAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });
  });

  describe('user creation', () => {
    it('checks if user exists before creating', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockFindByWorkosId).toHaveBeenCalledWith('workos-user-1');
    });

    it('creates user + workspace when user does not exist', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith({
        workosId: 'workos-user-1',
        email: 'jane@example.com',
        firstName: null,
        lastName: null,
        emailVerified: true,
        activeMode: 'client',
      });
    });

    it('skips creation when user already exists (race condition)', async () => {
      mockAuthenticateWithEmailVerification.mockResolvedValue(mockAuthResponse());
      mockFindByWorkosId.mockResolvedValue({
        id: 'user-1',
        email: 'jane@example.com',
        firstName: null,
        lastName: null,
        activeMode: 'client',
      });
      mockFindWithCompany.mockResolvedValue(mockFindWithCompanyResult());
      mockSave.mockResolvedValue(undefined);

      const result = await verifyEmailAction(validInput());
      expect(mockCreateWithWorkspace).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('passes firstName and lastName as null when WorkOS user has no name', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: null, lastName: null })
      );
    });

    it('passes firstName and lastName from WorkOS user when available', async () => {
      mockAuthenticateWithEmailVerification.mockResolvedValue(
        mockAuthResponse({ user: mockWorkOSUser({ firstName: 'Jane', lastName: 'Doe' }) })
      );
      mockFindByWorkosId.mockResolvedValue(null);
      mockCreateWithWorkspace.mockResolvedValue({
        user: { ...mockDbResult().user, firstName: 'Jane', lastName: 'Doe' },
        company: mockDbResult().company,
        membership: mockDbResult().membership,
      });
      mockFindWithCompany.mockResolvedValue({
        ...mockFindWithCompanyResult(),
        firstName: 'Jane',
        lastName: 'Doe',
      });
      mockSave.mockResolvedValue(undefined);

      await verifyEmailAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: 'Jane', lastName: 'Doe' })
      );
    });

    it('sets emailVerified to true', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: true })
      );
    });

    it('sets activeMode to client', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockCreateWithWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ activeMode: 'client' })
      );
    });
  });

  describe('session setup', () => {
    it('sets session.user with all required fields on success', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
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
      });
    });

    it('sets accessToken and refreshToken from auth response', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockSessionObj.accessToken).toBe('at_test');
      expect(mockSessionObj.refreshToken).toBe('rt_test');
    });

    it('calls session.save()', async () => {
      setupHappyPath();
      await verifyEmailAction(validInput());
      expect(mockSave).toHaveBeenCalledOnce();
    });
  });

  describe('success response', () => {
    it('returns { success: true, data: { needsOnboarding: true, ... } }', async () => {
      setupHappyPath();
      const result = await verifyEmailAction(validInput());
      expect(result).toEqual({
        success: true,
        data: {
          needsOnboarding: true,
          userId: 'user-1',
          email: 'jane@example.com',
          activeMode: 'client',
          platformRole: 'user',
        },
      });
    });
  });

  describe('error when company not found', () => {
    it('returns error when findWithCompany returns no memberships', async () => {
      mockAuthenticateWithEmailVerification.mockResolvedValue(mockAuthResponse());
      mockFindByWorkosId.mockResolvedValue(null);
      mockCreateWithWorkspace.mockResolvedValue(mockDbResult());
      mockFindWithCompany.mockResolvedValue({ companyMemberships: [] });

      const result = await verifyEmailAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Account setup incomplete. Please try signing in.',
      });
    });
  });
});
