import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockResetPassword = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({
    userManagement: {
      resetPassword: (...args: unknown[]) => mockResetPassword(...args),
    },
  }),
}));

import { resetPasswordAction } from './reset-password';
import type { ResetPasswordFormData } from '@/components/balo/auth/schemas';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'SecurePass1'; // NOSONAR — test fixture, not a real credential

function validInput(): ResetPasswordFormData {
  return {
    token: 'valid-reset-token-123',
    password: TEST_PASSWORD,
    confirmPassword: TEST_PASSWORD,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('resetPasswordAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it.each([
      {
        name: 'empty token',
        input: { token: '', password: TEST_PASSWORD, confirmPassword: TEST_PASSWORD },
        errorMatch: 'Missing reset token',
      },
      {
        name: 'password under 8 chars',
        input: { token: 'tok', password: 'Short1a', confirmPassword: 'Short1a' },
        errorMatch: 'at least 8 characters',
      },
      {
        name: 'password without lowercase',
        input: { token: 'tok', password: 'ALLCAPS123', confirmPassword: 'ALLCAPS123' },
        errorMatch: 'lowercase',
      },
      {
        name: 'password without uppercase',
        input: { token: 'tok', password: 'alllower1', confirmPassword: 'alllower1' },
        errorMatch: 'uppercase',
      },
      {
        name: 'password without number',
        input: { token: 'tok', password: 'NoNumbersHere', confirmPassword: 'NoNumbersHere' },
        errorMatch: 'number',
      },
      {
        name: 'passwords do not match',
        input: { token: 'tok', password: TEST_PASSWORD, confirmPassword: 'DifferentPass1' },
        errorMatch: "don't match",
      },
    ])('returns error for $name', async ({ input, errorMatch }) => {
      const result = await resetPasswordAction(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain(errorMatch);
      }
      expect(mockResetPassword).not.toHaveBeenCalled();
    });
  });

  describe('WorkOS resetPassword call', () => {
    it('calls resetPassword with token and newPassword', async () => {
      mockResetPassword.mockResolvedValue({ user: { id: 'user-1' } });
      await resetPasswordAction(validInput());
      expect(mockResetPassword).toHaveBeenCalledWith({
        token: 'valid-reset-token-123',
        newPassword: TEST_PASSWORD,
      });
    });

    it('returns { success: true } on success', async () => {
      mockResetPassword.mockResolvedValue({ user: { id: 'user-1' } });
      const result = await resetPasswordAction(validInput());
      expect(result).toEqual({ success: true });
    });

    it('returns mapped error when token is expired', async () => {
      mockResetPassword.mockRejectedValue(
        Object.assign(new Error('Token expired'), { code: 'password_reset_expired' })
      );
      const result = await resetPasswordAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'This password reset link has expired. Please request a new one.',
        code: 'password_reset_expired',
      });
    });

    it('returns mapped error for password_too_weak', async () => {
      mockResetPassword.mockRejectedValue(
        Object.assign(new Error('Password too weak'), { code: 'password_too_weak' })
      );
      const result = await resetPasswordAction(validInput());
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('stronger password');
        expect(result.code).toBe('password_too_weak');
      }
    });

    it('returns default error for unknown errors', async () => {
      mockResetPassword.mockRejectedValue(new Error('network failure'));
      const result = await resetPasswordAction(validInput());
      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again.',
      });
    });

    it('includes error code in response when available', async () => {
      mockResetPassword.mockRejectedValue(
        Object.assign(new Error('Rate limited'), { code: 'rate_limit_exceeded' })
      );
      const result = await resetPasswordAction(validInput());
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.code).toBe('rate_limit_exceeded');
      }
    });

    it('does not include code when error has no code property', async () => {
      mockResetPassword.mockRejectedValue(new Error('generic'));
      const result = await resetPasswordAction(validInput());
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result).not.toHaveProperty('code');
      }
    });
  });
});
