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
const mockFindWithCompany = vi.fn();
const mockCreateWithWorkspace = vi.fn();
const mockTouch = vi.fn();
const mockExpertProfileFindFirst = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findByWorkosId: (...args: unknown[]) => mockFindByWorkosId(...args),
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

import { signInAction } from './sign-in';
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
});
