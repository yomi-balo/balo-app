import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log as mockLog } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────

// BAL-489 — the guest-conversion call is scheduled with `after()`, not awaited
// inline. Capture callbacks rather than running them, so the action
// can be asserted NOT to have called the helper synchronously; tests run the captured
// callback(s) explicitly. sign-up.ts does not import `@/lib/analytics/server`, so this
// array only ever holds our own scheduling.
let capturedAfter: Array<() => unknown> = [];
vi.mock('next/server', () => ({
  after: (cb: () => unknown) => {
    capturedAfter.push(cb);
  },
}));

/** Run every callback captured via `after()` so far, awaiting each in turn. */
async function runCapturedAfterCallbacks(): Promise<void> {
  const callbacks = capturedAfter;
  capturedAfter = [];
  for (const cb of callbacks) {
    await cb();
  }
}

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
    capturedAfter = [];
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
    it('is not called synchronously; schedules exactly one callback that calls the helper once with the same facts as domain-join', async () => {
      setupFallbackPath({ emailVerified: true });
      const result = await signUpAction(validInput());

      expect(result.success).toBe(true);
      expect(mockRunGuestConversionAndEmit).not.toHaveBeenCalled();
      expect(capturedAfter).toHaveLength(1);

      await runCapturedAfterCallbacks();

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
      await runCapturedAfterCallbacks();
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledWith(
        expect.objectContaining({ emailVerified: false })
      );
    });

    it('does NOT schedule linkage on the verification-required path (no user created)', async () => {
      mockCreateUser.mockResolvedValue(mockWorkOSUser());
      mockAuthenticateWithPassword.mockResolvedValue({
        pendingAuthenticationToken: 'pat_test_123',
        user: mockWorkOSUser(),
      });

      await signUpAction(validInput());
      await runCapturedAfterCallbacks();
      expect(mockRunGuestConversionAndEmit).not.toHaveBeenCalled();
    });

    it('a linkage rejection inside the scheduled callback is swallowed — logged without the email', async () => {
      setupFallbackPath({ emailVerified: true });
      mockRunGuestConversionAndEmit.mockRejectedValueOnce(new Error('linkage boom'));
      const result = await signUpAction(validInput());
      expect(result.success).toBe(true);

      await expect(runCapturedAfterCallbacks()).resolves.toBeUndefined();

      const warnCall = vi
        .mocked(mockLog.warn)
        .mock.calls.find(
          ([, data]) => (data as Record<string, unknown> | undefined)?.userId === 'user-1'
        );
      expect(warnCall).toBeDefined();
      const serialized = JSON.stringify(warnCall);
      expect(serialized).toContain('user-1');
      expect(serialized).not.toContain('jane@example.com');
    });

    it('independence (R10): a domain-join rejection does not stop the linkage from being scheduled, and sign-up still succeeds', async () => {
      setupFallbackPath({ emailVerified: true });
      mockRunDomainJoinAndEmit.mockRejectedValueOnce(new Error('domain-join boom'));
      const result = await signUpAction(validInput());
      expect(result.success).toBe(true);
      expect(capturedAfter).toHaveLength(1);

      await runCapturedAfterCallbacks();
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledTimes(1);
    });
  });

  // BAL-489 — the R10 tests above cover a REJECTED CALL to each helper. These cover a
  // REJECTED DYNAMIC IMPORT (a failed chunk load), which the chained `.catch` must absorb
  // instead of letting it escape into the outer catch after the Balo user + session
  // exist. `vi.doMock` + `vi.resetModules()` makes the import genuinely
  // reject (not just the resolved module's export throw) inside THIS test's own module
  // registry — re-imported dynamically below so the mocked rejection is picked up.
  //
  // ⚠ Each test `vi.doMock`s BOTH dynamic imports explicitly (the "other" one with a
  // working re-implementation of the outer static `vi.mock`, never left to fall back to
  // it). MEASURED: `vi.doUnmock` after a THROWING/rejecting `vi.doMock` does not reliably
  // restore the file-level static `vi.mock` for that specifier on the next
  // `vi.resetModules()` cycle — the module falls through to the REAL implementation
  // instead (confirmed via `mockRunDomainJoinAndEmit.mock.calls.length === 0` while the
  // real domain-join module ran and pushed the unrelated `flushServerAnalytics` callback
  // from `@balo/analytics/server` into `capturedAfter`, corrupting the "exactly one
  // scheduled callback" assertion). Re-doMocking both specifiers in every test sidesteps
  // that harness quirk entirely rather than depending on restoration.
  describe('dynamic-import chunk-load failures (BAL-489)', () => {
    afterEach(async () => {
      vi.doUnmock('@/lib/domain-join/run-domain-join');
      vi.doUnmock('@/lib/guest-conversion/run-guest-conversion');
      vi.resetModules();
    });

    it('a rejected domain-join chunk import is swallowed via .catch, sign-up still succeeds, and linkage is still scheduled', async () => {
      setupFallbackPath({ emailVerified: true });
      vi.resetModules();
      vi.doMock('@/lib/domain-join/run-domain-join', () =>
        Promise.reject(new Error('chunk load failed'))
      );
      vi.doMock('@/lib/guest-conversion/run-guest-conversion', () => ({
        runGuestConversionAndEmit: (...args: unknown[]) => mockRunGuestConversionAndEmit(...args),
      }));

      const { signUpAction: signUpActionFresh } = await import('./sign-up');
      const result = await signUpActionFresh(validInput());

      expect(result.success).toBe(true);
      expect(vi.mocked(mockLog.warn)).toHaveBeenCalledWith(
        'Domain join failed after sign-up (auth unaffected)',
        expect.objectContaining({ userId: 'user-1' })
      );
      // The domain-join import failure must not stop guest-conversion from being scheduled.
      expect(capturedAfter).toHaveLength(1);
      await runCapturedAfterCallbacks();
      expect(mockRunGuestConversionAndEmit).toHaveBeenCalledTimes(1);
    });

    it('a rejected guest-conversion chunk import inside the scheduled callback resolves without throwing and is logged', async () => {
      setupFallbackPath({ emailVerified: true });
      vi.resetModules();
      vi.doMock('@/lib/domain-join/run-domain-join', () => ({
        runDomainJoinAndEmit: (...args: unknown[]) => mockRunDomainJoinAndEmit(...args),
      }));
      vi.doMock('@/lib/guest-conversion/run-guest-conversion', () => {
        throw new Error('chunk load failed');
      });

      const { signUpAction: signUpActionFresh } = await import('./sign-up');
      const result = await signUpActionFresh(validInput());

      expect(result.success).toBe(true);
      expect(mockRunDomainJoinAndEmit).toHaveBeenCalledTimes(1);
      expect(capturedAfter).toHaveLength(1);

      await expect(runCapturedAfterCallbacks()).resolves.toBeUndefined();

      expect(vi.mocked(mockLog.warn)).toHaveBeenCalledWith(
        'Guest conversion rejected after sign-up (auth unaffected)',
        expect.objectContaining({ userId: 'user-1' })
      );
    });
  });
});
