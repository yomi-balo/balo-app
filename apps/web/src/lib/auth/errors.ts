import 'server-only';

/**
 * Structured auth action result.
 * All auth Server Actions return this shape — never throw to the client.
 */
export type AuthResult<T = Record<string, unknown>> =
  | { success: true; data?: T }
  | { success: false; error: string; code?: string };

/**
 * Map WorkOS error codes to user-friendly messages.
 * Reference: https://workos.com/docs/reference/user-management/error-codes
 */
const ERROR_MAP: Record<string, string> = {
  // authenticateWithPassword errors
  user_not_found: 'Invalid email or password. Please try again.',
  invalid_credentials: 'Invalid email or password. Please try again.',
  email_not_verified: 'Please verify your email address before signing in.',
  user_suspended: 'Your account has been suspended. Please contact support.',

  // createUser errors
  email_already_exists: 'Invalid email or password. Please try again.',
  user_creation_failed: 'Could not create your account. Please try again.',
  password_too_short: 'Password must be at least 8 characters.',
  password_too_weak: 'Please choose a stronger password.',

  // Email verification errors
  email_verification_required: 'Please verify your email address.',
  email_verification_failed: 'Invalid or expired verification code. Please try again.',
  email_verification_code_expired: 'Your verification code has expired. Please request a new one.',

  // Password reset errors
  password_reset_expired: 'This password reset link has expired. Please request a new one.',

  // OAuth errors
  oauth_failed: 'Could not connect to the authentication provider. Please try again.',

  // Generic
  rate_limit_exceeded: 'Too many attempts. Please wait a moment and try again.',
};

const DEFAULT_ERROR = 'Something went wrong. Please try again.';

/**
 * Extract a user-friendly error message from a WorkOS SDK error.
 * WorkOS errors have shape: { code: string, message: string, ... }
 */
export function mapWorkOSError(error: unknown): string {
  if (error instanceof Error) {
    // WorkOS SDK errors typically have a `code` property
    const workosError = error as Error & { code?: string; rawData?: { code?: string } };

    // Try the code directly on the error
    const code = workosError.code ?? workosError.rawData?.code;

    if (code) {
      const mapped = ERROR_MAP[code];
      if (mapped) return mapped;
    }

    // Check message for known patterns as fallback
    const msg = error.message.toLowerCase();
    if (msg.includes('already exists') || msg.includes('duplicate')) {
      return ERROR_MAP.email_already_exists ?? DEFAULT_ERROR;
    }
    if (msg.includes('not found') || (msg.includes('invalid') && msg.includes('credentials'))) {
      return ERROR_MAP.invalid_credentials ?? DEFAULT_ERROR;
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
      return ERROR_MAP.rate_limit_exceeded ?? DEFAULT_ERROR;
    }
  }

  return DEFAULT_ERROR;
}
