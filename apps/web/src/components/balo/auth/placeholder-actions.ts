// TODO(BAL-169): DELETE this entire file — replace with real WorkOS Server Actions

import type { SignInFormData, SignUpFormData, ForgotPasswordFormData } from './schemas';

/**
 * Placeholder auth actions for UI development.
 * These simulate a 1-second network delay and log to console.
 * Replace with real WorkOS Server Actions in BAL-169.
 */

export async function placeholderSignIn(data: SignInFormData): Promise<{ success: boolean }> {
  console.log('[placeholder] Sign in:', data.email);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { success: true };
}

export async function placeholderSignUp(data: SignUpFormData): Promise<{ success: boolean }> {
  console.log('[placeholder] Sign up:', data.email, data.firstName, data.lastName);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { success: true };
}

export async function placeholderForgotPassword(
  data: ForgotPasswordFormData
): Promise<{ success: boolean }> {
  console.log('[placeholder] Forgot password:', data.email);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { success: true };
}

export async function placeholderOAuth(provider: 'google' | 'microsoft'): Promise<void> {
  console.log('[placeholder] OAuth:', provider);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
