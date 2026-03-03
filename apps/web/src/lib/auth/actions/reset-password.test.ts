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
    it('returns error for empty token', async () => {
      const result = await resetPasswordAction({
        token: '',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      });
      expect(result).toEqual({ success: false, error: 'Missing reset token' });
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('returns error for password under 8 chars', async () => {
      const result = await resetPasswordAction({
        token: 'tok',
        password: 'Short1a',
        confirmPassword: 'Short1a',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('at least 8 characters');
      }
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('returns error for password without lowercase', async () => {
      const result = await resetPasswordAction({
        token: 'tok',
        password: 'ALLCAPS123',
        confirmPassword: 'ALLCAPS123',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('lowercase');
      }
    });

    it('returns error for password without uppercase', async () => {
      const result = await resetPasswordAction({
        token: 'tok',
        password: 'alllower1',
        confirmPassword: 'alllower1',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('uppercase');
      }
    });

    it('returns error for password without number', async () => {
      const result = await resetPasswordAction({
        token: 'tok',
        password: 'NoNumbersHere',
        confirmPassword: 'NoNumbersHere',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('number');
      }
    });

    it('returns error when passwords do not match', async () => {
      const result = await resetPasswordAction({
        token: 'tok',
        password: TEST_PASSWORD,
        confirmPassword: 'DifferentPass1',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("don't match");
      }
    });

    it('does not call WorkOS when validation fails', async () => {
      await resetPasswordAction({ token: '', password: '', confirmPassword: '' });
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
