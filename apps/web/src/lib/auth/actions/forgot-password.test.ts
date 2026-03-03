import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

const mockCreatePasswordReset = vi.fn();
vi.mock('@/lib/auth/config', () => ({
  getWorkOS: () => ({
    userManagement: {
      createPasswordReset: (...args: unknown[]) => mockCreatePasswordReset(...args),
    },
  }),
}));

import { forgotPasswordAction } from './forgot-password';

// ── Tests ───────────────────────────────────────────────────────

describe('forgotPasswordAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePasswordReset.mockResolvedValue({
      id: 'pr_test',
      email: 'anyone@example.com',
    });
  });

  describe('validation errors', () => {
    it('returns error for empty email', async () => {
      const result = await forgotPasswordAction({ email: '' });
      expect(result).toEqual({ success: false, error: 'Email is required' });
      expect(mockCreatePasswordReset).not.toHaveBeenCalled();
    });

    it('returns error for invalid email format', async () => {
      const result = await forgotPasswordAction({ email: 'not-an-email' });
      expect(result).toEqual({ success: false, error: 'Please enter a valid email address' });
      expect(mockCreatePasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('WorkOS createPasswordReset call', () => {
    it('calls createPasswordReset with the email', async () => {
      await forgotPasswordAction({ email: 'user@example.com' });
      expect(mockCreatePasswordReset).toHaveBeenCalledWith({
        email: 'user@example.com',
      });
    });

    it('returns success after calling WorkOS', async () => {
      const result = await forgotPasswordAction({ email: 'user@example.com' });
      expect(result).toEqual({ success: true });
    });
  });

  describe('email enumeration protection', () => {
    it('returns success even when WorkOS throws user_not_found', async () => {
      mockCreatePasswordReset.mockRejectedValue(
        Object.assign(new Error('User not found'), { code: 'user_not_found' })
      );
      const result = await forgotPasswordAction({ email: 'nonexistent@example.com' });
      expect(result).toEqual({ success: true });
    });

    it('returns success even when WorkOS throws network error', async () => {
      mockCreatePasswordReset.mockRejectedValue(new Error('network error'));
      const result = await forgotPasswordAction({ email: 'anyone@example.com' });
      expect(result).toEqual({ success: true });
    });

    it('does not include error details in response', async () => {
      mockCreatePasswordReset.mockRejectedValue(new Error('some error'));
      const result = await forgotPasswordAction({ email: 'anyone@example.com' });
      expect(result).toEqual({ success: true });
      expect(result).not.toHaveProperty('error');
      expect(result).not.toHaveProperty('code');
    });
  });
});
