'use server';

import 'server-only';

import { forgotPasswordSchema, type ForgotPasswordFormData } from '@/components/balo/auth/schemas';
import { getWorkOS } from '@/lib/auth/config';
import { type AuthResult, mapWorkOSError } from '@/lib/auth/errors';

/**
 * Send password reset email via WorkOS.
 *
 * SECURITY: Always returns success even if email doesn't exist.
 * This prevents email enumeration attacks.
 */
export async function forgotPasswordAction(input: ForgotPasswordFormData): Promise<AuthResult> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }

  try {
    // WorkOS SDK v8 uses createPasswordReset (sends the reset email).
    // The passwordResetUrl is configured in the WorkOS dashboard.
    await getWorkOS().userManagement.createPasswordReset({
      email: parsed.data.email,
    });

    // Always return success to prevent email enumeration
    return { success: true };
  } catch (error) {
    // WorkOS may throw if the email doesn't exist or rate limit is hit.
    // For non-existent emails, we still return success (security).
    // For rate limits, we return an error.
    const errorMessage = mapWorkOSError(error);
    if (errorMessage.includes('Too many attempts')) {
      return { success: false, error: errorMessage };
    }

    // For all other errors (including user_not_found), return success
    // to prevent email enumeration.
    return { success: true };
  }
}
