import { describe, it, expect } from 'vitest';
import { forgotPasswordAction } from './forgot-password';

describe('forgotPasswordAction', () => {
  describe('validation errors', () => {
    it('returns error for empty email', async () => {
      const result = await forgotPasswordAction({ email: '' });
      expect(result).toEqual({ success: false, error: 'Email is required' });
    });

    it('returns error for invalid email format', async () => {
      const result = await forgotPasswordAction({ email: 'not-an-email' });
      expect(result).toEqual({ success: false, error: 'Please enter a valid email address' });
    });
  });

  describe('success — email enumeration protection', () => {
    it('returns success for valid email regardless of account existence', async () => {
      const result = await forgotPasswordAction({ email: 'anyone@example.com' });
      expect(result.success).toBe(true);
    });

    it('does not include data property on success', async () => {
      const result = await forgotPasswordAction({ email: 'anyone@example.com' });
      expect(result).toEqual({ success: true });
    });
  });
});
