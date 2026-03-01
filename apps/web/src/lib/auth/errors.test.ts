import { describe, it, expect } from 'vitest';
import { mapWorkOSError } from './errors';

// ── Helpers ─────────────────────────────────────────────────────

function errorWithCode(code: string, message = 'WorkOS error'): Error {
  return Object.assign(new Error(message), { code });
}

function errorWithRawDataCode(code: string, message = 'WorkOS error'): Error {
  return Object.assign(new Error(message), { rawData: { code } });
}

// ── Tests ───────────────────────────────────────────────────────

describe('mapWorkOSError', () => {
  describe('code-based mapping', () => {
    it.each([
      ['user_not_found', 'Invalid email or password. Please try again.'],
      ['invalid_credentials', 'Invalid email or password. Please try again.'],
      ['email_not_verified', 'Please verify your email address before signing in.'],
      ['user_suspended', 'Your account has been suspended. Please contact support.'],
      [
        'email_already_exists',
        'An account with this email already exists. Try signing in instead.',
      ],
      ['user_creation_failed', 'Could not create your account. Please try again.'],
      ['password_too_short', 'Password must be at least 8 characters.'],
      ['password_too_weak', 'Please choose a stronger password.'],
      ['password_reset_expired', 'This password reset link has expired. Please request a new one.'],
      ['oauth_failed', 'Could not connect to the authentication provider. Please try again.'],
      ['rate_limit_exceeded', 'Too many attempts. Please wait a moment and try again.'],
    ])('maps code "%s" to correct message', (code, expected) => {
      expect(mapWorkOSError(errorWithCode(code))).toBe(expected);
    });

    it('reads code from rawData.code when top-level code is absent', () => {
      expect(mapWorkOSError(errorWithRawDataCode('user_suspended'))).toBe(
        'Your account has been suspended. Please contact support.'
      );
    });

    it('prefers top-level code over rawData.code', () => {
      const error = Object.assign(new Error('msg'), {
        code: 'user_not_found',
        rawData: { code: 'user_suspended' },
      });
      expect(mapWorkOSError(error)).toBe('Invalid email or password. Please try again.');
    });

    it('falls through to message matching for unrecognized code', () => {
      const error = errorWithCode('some_unknown_code', 'already exists in system');
      expect(mapWorkOSError(error)).toBe(
        'An account with this email already exists. Try signing in instead.'
      );
    });
  });

  describe('message-based fallback', () => {
    it.each([
      ['already exists', 'An account with this email already exists. Try signing in instead.'],
      [
        'duplicate entry found',
        'An account with this email already exists. Try signing in instead.',
      ],
      ['user not found', 'Invalid email or password. Please try again.'],
      ['invalid credentials provided', 'Invalid email or password. Please try again.'],
      ['rate limit hit', 'Too many attempts. Please wait a moment and try again.'],
      ['too many requests', 'Too many attempts. Please wait a moment and try again.'],
    ])('matches message containing "%s"', (message, expected) => {
      expect(mapWorkOSError(new Error(message))).toBe(expected);
    });

    it('message match is case-insensitive', () => {
      expect(mapWorkOSError(new Error('ALREADY EXISTS'))).toBe(
        'An account with this email already exists. Try signing in instead.'
      );
    });

    it('requires both "invalid" and "credentials" in message', () => {
      expect(mapWorkOSError(new Error('invalid something'))).toBe(
        'Something went wrong. Please try again.'
      );
      expect(mapWorkOSError(new Error('bad credentials'))).toBe(
        'Something went wrong. Please try again.'
      );
      expect(mapWorkOSError(new Error('invalid credentials together'))).toBe(
        'Invalid email or password. Please try again.'
      );
    });
  });

  describe('non-Error input', () => {
    it.each([
      ['string', 'a string error'],
      ['null', null],
      ['undefined', undefined],
      ['number', 42],
      ['plain object', { code: 'user_not_found', message: 'test' }],
    ])('returns default error for %s input', (_label, input) => {
      expect(mapWorkOSError(input)).toBe('Something went wrong. Please try again.');
    });
  });

  describe('edge cases', () => {
    it('returns default error for Error with no code and no matching message', () => {
      expect(mapWorkOSError(new Error('something completely unknown'))).toBe(
        'Something went wrong. Please try again.'
      );
    });

    it('returns default error for Error with empty message and no code', () => {
      expect(mapWorkOSError(new Error(''))).toBe('Something went wrong. Please try again.');
    });
  });
});
