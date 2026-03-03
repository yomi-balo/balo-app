'use server';

import 'server-only';

import { forgotPasswordSchema, type ForgotPasswordFormData } from '@/components/balo/auth/schemas';
import { getWorkOS } from '@/lib/auth/config';
import type { AuthResult } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

/**
 * Request a password reset email.
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

  try {
    await getWorkOS().userManagement.createPasswordReset({
      email: parsed.data.email,
    });
  } catch (error) {
    // SECURITY: Swallow all errors -- do NOT return failure to prevent email enumeration.
    // If the email doesn't exist, WorkOS may throw. We still return success.
    log.warn('Password reset request failed (swallowed for enumeration protection)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  log.info('Password reset requested', { email: parsed.data.email });

  return { success: true };
}
