'use server';

import 'server-only';

import { forgotPasswordSchema, type ForgotPasswordFormData } from '@/components/balo/auth/schemas';
import type { AuthResult } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

/**
 * Forgot password placeholder.
 *
 * The reset-password page doesn't have a token handler yet, so sending
 * real WorkOS emails would confuse users. This stub validates input and
 * returns success. Replace with real WorkOS `createPasswordReset()` call
 * when the full reset flow is built.
 *
 * SECURITY: Always returns success to prevent email enumeration.
 */
export async function forgotPasswordAction(input: ForgotPasswordFormData): Promise<AuthResult> {
  const parsed = forgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }

  // TODO: Wire up WorkOS createPasswordReset() once /reset-password
  // accepts a token and calls resetPassword(). See BAL-169 follow-up.
  log.info('Password reset requested', { email: parsed.data.email });

  return { success: true };
}
