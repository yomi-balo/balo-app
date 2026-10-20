import { describe, it, expect } from 'vitest';
import {
  signInSchema,
  forgotPasswordSchema,
  unifiedSignUpSchema,
  emailSchema,
  verifyEmailSchema,
} from './schemas';

// ── signInSchema ────────────────────────────────────────────────

describe('signInSchema', () => {
  const validInput = { email: 'user@example.com', password: 'password123' }; // NOSONAR — test fixture, not a real credential

  describe('valid input', () => {
    it('accepts valid email and password', () => {
      expect(signInSchema.safeParse(validInput).success).toBe(true);
    });

    it('accepts single-character password', () => {
      expect(signInSchema.safeParse({ ...validInput, password: 'x' }).success).toBe(true); // NOSONAR
    });
  });

  describe('email validation', () => {
    it('rejects empty email with "Email is required"', () => {
      const result = signInSchema.safeParse({ ...validInput, email: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Email is required');
      }
    });

    it('rejects invalid email format', () => {
      const result = signInSchema.safeParse({ ...validInput, email: 'not-an-email' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Please enter a valid email address');
      }
    });
  });

  describe('password validation', () => {
    it('rejects empty password with "Password is required"', () => {
      const result = signInSchema.safeParse({ ...validInput, password: '' }); // NOSONAR
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Password is required');
      }
    });
  });
});

// ── unifiedSignUpSchema ────────────────────────────────────────

describe('unifiedSignUpSchema', () => {
  const validInput = {
    email: 'john@example.com',
    password: 'kettle violet harbour', // NOSONAR — test fixture, not a real credential
  };

  describe('valid input', () => {
    it('accepts complete valid input', () => {
      expect(unifiedSignUpSchema.safeParse(validInput).success).toBe(true);
    });

    it('accepts a password of exactly 10 characters', () => {
      const pwd = 'abcdefghij'; // NOSONAR — test fixture, not a real credential
      expect(unifiedSignUpSchema.safeParse({ ...validInput, password: pwd }).success).toBe(true);
    });

    it.each([
      ['all lowercase', 'kettleviolet'],
      ['all uppercase', 'KETTLEVIOLET'],
      ['no digit or symbol', 'KettleViolet'],
    ])('accepts a %s password (no composition rules)', (_label, pwd) => {
      expect(unifiedSignUpSchema.safeParse({ ...validInput, password: pwd }).success).toBe(true);
    });
  });

  describe('email validation', () => {
    it('rejects empty email', () => {
      const result = unifiedSignUpSchema.safeParse({ ...validInput, email: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Email is required');
      }
    });

    it('rejects invalid email format', () => {
      const result = unifiedSignUpSchema.safeParse({ ...validInput, email: 'bad' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Please enter a valid email address');
      }
    });
  });

  describe('password validation', () => {
    it.each([
      ['Aa1!bbbbb', 'Password must be at least 10 characters'], // NOSONAR — 9 characters
      ['Aa1!', 'Password must be at least 10 characters'], // NOSONAR — far too short
    ])('rejects "%s" with expected error', (pwd, expectedMsg) => {
      const result = unifiedSignUpSchema.safeParse({ ...validInput, password: pwd }); // NOSONAR
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message === expectedMsg)).toBe(true);
      }
    });
  });

  describe('multiple errors', () => {
    it('returns all failing validations when multiple rules fail', () => {
      const result = unifiedSignUpSchema.safeParse({
        email: 'bad',
        password: 'x', // NOSONAR
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

// ── emailSchema ────────────────────────────────────────────────

describe('emailSchema', () => {
  it('accepts valid email', () => {
    expect(emailSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
  });

  it('rejects empty email', () => {
    const result = emailSchema.safeParse({ email: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email', () => {
    const result = emailSchema.safeParse({ email: 'bad' });
    expect(result.success).toBe(false);
  });
});

// ── verifyEmailSchema ────────────────────────────────────────

describe('verifyEmailSchema', () => {
  it('accepts valid token and code', () => {
    expect(
      verifyEmailSchema.safeParse({ pendingAuthToken: 'token123', code: '123456' }).success
    ).toBe(true);
  });

  it('rejects empty token', () => {
    const result = verifyEmailSchema.safeParse({ pendingAuthToken: '', code: '123456' });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric code', () => {
    const result = verifyEmailSchema.safeParse({ pendingAuthToken: 'token', code: 'abcdef' });
    expect(result.success).toBe(false);
  });

  it('rejects code shorter than 6 digits', () => {
    const result = verifyEmailSchema.safeParse({ pendingAuthToken: 'token', code: '12345' });
    expect(result.success).toBe(false);
  });
});

// ── forgotPasswordSchema ────────────────────────────────────────

describe('forgotPasswordSchema', () => {
  describe('valid input', () => {
    it('accepts valid email', () => {
      expect(forgotPasswordSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
    });
  });

  describe('email validation', () => {
    it('rejects empty email with "Email is required"', () => {
      const result = forgotPasswordSchema.safeParse({ email: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Email is required');
      }
    });

    it('rejects invalid email format', () => {
      const result = forgotPasswordSchema.safeParse({ email: 'not-an-email' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Please enter a valid email address');
      }
    });
  });
});
