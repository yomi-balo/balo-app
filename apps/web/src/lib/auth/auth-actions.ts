import type {
  SignInFormData,
  SignUpFormData,
  ForgotPasswordFormData,
} from '@/components/balo/auth/auth-schemas';

/**
 * Placeholder for BAL-169.
 * Will become a Server Action calling WorkOS userManagement.authenticateWithPassword()
 */
export async function signInAction(
  data: SignInFormData
): Promise<{ success: boolean; error?: string }> {
  // TODO(BAL-169): Replace with WorkOS authenticateWithPassword()
  void data;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { success: true };
}

/**
 * Placeholder for BAL-169.
 * Will become a Server Action calling WorkOS userManagement.createUser()
 */
export async function signUpAction(
  data: SignUpFormData
): Promise<{ success: boolean; error?: string }> {
  // TODO(BAL-169): Replace with WorkOS createUser()
  void data;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { success: true };
}

/**
 * Placeholder for BAL-169.
 * Will become a Server Action calling WorkOS userManagement.sendPasswordResetEmail()
 */
export async function forgotPasswordAction(
  data: ForgotPasswordFormData
): Promise<{ success: boolean; error?: string }> {
  // TODO(BAL-169): Replace with WorkOS sendPasswordResetEmail()
  void data;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return { success: true };
}

/**
 * Placeholder for BAL-169.
 * Will become a Server Action that generates a WorkOS OAuth authorization URL.
 */
export async function oauthAction(provider: 'google' | 'microsoft'): Promise<void> {
  // TODO(BAL-169): Replace with WorkOS OAuth URL generation
  void provider;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
