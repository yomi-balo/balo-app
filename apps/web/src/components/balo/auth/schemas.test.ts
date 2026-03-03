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
    password: 'Passw0rd', // NOSONAR — test fixture, not a real credential
  };

  describe('valid input', () => {
    it('accepts complete valid input', () => {
      expect(unifiedSignUpSchema.safeParse(validInput).success).toBe(true);
    });

    it('accepts password at exactly 8 chars meeting all requirements', () => {
      expect(unifiedSignUpSchema.safeParse({ ...validInput, password: 'Passwo1d' }).success).toBe(
        true
      ); // NOSONAR
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
      ['Aa1bbbb', 'Password must be at least 8 characters'], // too short
      ['PASSWORD1', 'Must contain a lowercase letter'], // NOSONAR — no lowercase
      ['password1', 'Must contain an uppercase letter'], // NOSONAR — no uppercase
      ['Passwords', 'Must contain a number'], // NOSONAR — no digit
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
