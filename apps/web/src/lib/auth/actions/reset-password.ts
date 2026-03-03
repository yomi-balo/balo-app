'use server';

import 'server-only';

import { resetPasswordSchema, type ResetPasswordFormData } from '@/components/balo/auth/schemas';
import { getWorkOS } from '@/lib/auth/config';
import type { AuthResult } from '@/lib/auth/errors';
import { mapWorkOSError } from '@/lib/auth/errors';
import { log } from '@/lib/logging';

export async function resetPasswordAction(input: ResetPasswordFormData): Promise<AuthResult> {
  // 1. Validate with Zod
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid input.',
    };
  }

  try {
    // 2. Call WorkOS to reset the password
    await getWorkOS().userManagement.resetPassword({
      token: parsed.data.token,
      newPassword: parsed.data.password,
    });

    log.info('Password reset completed');

    return { success: true };
  } catch (error) {
    const message = mapWorkOSError(error);

    log.error('Password reset failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Extract code for client-side error differentiation (expired vs invalid vs generic)
    const workosError = error as Error & { code?: string; rawData?: { code?: string } };
    const code = workosError.code ?? workosError.rawData?.code;

    return {
      success: false,
      error: message,
      ...(code && { code }),
    };
  }
}
