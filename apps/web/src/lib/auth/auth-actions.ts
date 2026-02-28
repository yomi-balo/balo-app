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
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log('[auth-actions] signIn called with:', { email: data.email });
  if (data.email === 'error@test.com') {
    return { success: false, error: 'Invalid email or password. Please try again.' };
  }
  return { success: true };
}

/**
 * Placeholder for BAL-169.
 * Will become a Server Action calling WorkOS userManagement.createUser()
 */
export async function signUpAction(
  data: SignUpFormData
): Promise<{ success: boolean; error?: string }> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log('[auth-actions] signUp called with:', {
    email: data.email,
    firstName: data.firstName,
    lastName: data.lastName,
  });
  if (data.email === 'exists@test.com') {
    return { success: false, error: 'An account with this email already exists.' };
  }
  return { success: true };
}

/**
 * Placeholder for BAL-169.
 * Will become a Server Action calling WorkOS userManagement.sendPasswordResetEmail()
 */
export async function forgotPasswordAction(
  data: ForgotPasswordFormData
): Promise<{ success: boolean; error?: string }> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log('[auth-actions] forgotPassword called with:', { email: data.email });
  return { success: true };
}

/**
 * Placeholder for BAL-169.
 * Will become a Server Action that generates a WorkOS OAuth authorization URL.
 */
export async function oauthAction(provider: 'google' | 'microsoft'): Promise<void> {
  console.log('[auth-actions] OAuth initiated for:', provider);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
