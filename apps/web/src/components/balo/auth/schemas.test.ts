import { describe, it, expect } from 'vitest';
import { signInSchema, signUpSchema, forgotPasswordSchema } from './schemas';

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

// ── signUpSchema ────────────────────────────────────────────────

describe('signUpSchema', () => {
  const validInput = {
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    password: 'Passw0rd', // NOSONAR — test fixture, not a real credential
  };

  describe('valid input', () => {
    it('accepts complete valid input', () => {
      expect(signUpSchema.safeParse(validInput).success).toBe(true);
    });

    it('accepts firstName at exactly 50 chars', () => {
      expect(signUpSchema.safeParse({ ...validInput, firstName: 'a'.repeat(50) }).success).toBe(
        true
      );
    });

    it('accepts lastName at exactly 50 chars', () => {
      expect(signUpSchema.safeParse({ ...validInput, lastName: 'a'.repeat(50) }).success).toBe(
        true
      );
    });

    it('accepts password at exactly 8 chars meeting all requirements', () => {
      expect(signUpSchema.safeParse({ ...validInput, password: 'Passwo1d' }).success).toBe(true); // NOSONAR
    });
  });

  describe('firstName validation', () => {
    it('rejects empty firstName', () => {
      const result = signUpSchema.safeParse({ ...validInput, firstName: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('First name is required');
      }
    });

    it('rejects firstName exceeding 50 chars', () => {
      const result = signUpSchema.safeParse({ ...validInput, firstName: 'a'.repeat(51) });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('First name is too long');
      }
    });
  });

  describe('lastName validation', () => {
    it('rejects empty lastName', () => {
      const result = signUpSchema.safeParse({ ...validInput, lastName: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Last name is required');
      }
    });

    it('rejects lastName exceeding 50 chars', () => {
      const result = signUpSchema.safeParse({ ...validInput, lastName: 'a'.repeat(51) });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Last name is too long');
      }
    });
  });

  describe('email validation', () => {
    it('rejects empty email', () => {
      const result = signUpSchema.safeParse({ ...validInput, email: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe('Email is required');
      }
    });

    it('rejects invalid email format', () => {
      const result = signUpSchema.safeParse({ ...validInput, email: 'bad' });
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
      const result = signUpSchema.safeParse({ ...validInput, password: pwd }); // NOSONAR
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message === expectedMsg)).toBe(true);
      }
    });
  });

  describe('multiple errors', () => {
    it('returns all failing validations when multiple rules fail', () => {
      const result = signUpSchema.safeParse({
        firstName: '',
        lastName: '',
        email: 'bad',
        password: 'x', // NOSONAR
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThanOrEqual(4);
      }
    });
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
