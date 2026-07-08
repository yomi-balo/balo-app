import { z } from 'zod';

export const signInSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
export type SignInFormData = z.infer<typeof signInSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Please enter a valid email address'),
});
export type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

// ---- New schemas for unified auth flow (BAL-184) ----

/** Email-only schema for the email step */
export const emailSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Please enter a valid email address'),
});
export type EmailFormData = z.infer<typeof emailSchema>;

/** Shared password requirements — single source of truth for signup + reset */
const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[a-z]/, 'Must contain a lowercase letter')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/\d/, 'Must contain a number');

/**
 * Shared company-name validation — single source for client + server (BAL-350).
 * Trimmed; max 120 (companies.name is unbounded text — 120 gives generous headroom
 * over real company/workspace names while preventing overflow/abuse in the UI and
 * logs). NO .min() here: the field is compulsory only when SHOWN, enforced
 * imperatively client-side; the server tolerates absent/empty and falls back.
 */
export const companyNameField = z
  .string()
  .trim()
  .max(120, 'Company name must be 120 characters or less');

/** Pre-submit domain-check contract (see check-signup-domain action, BAL-350). */
export type SignupDomainStatus = 'blocked' | 'new' | 'matched';
export interface CheckSignupDomainResult {
  status: SignupDomainStatus;
}

/** Unified sign-up schema -- no firstName/lastName (collected in onboarding) */
export const unifiedSignUpSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Please enter a valid email address'),
  password: passwordField,
  companyName: companyNameField.optional(), // BAL-350 — only sent when the field is shown
});
export type UnifiedSignUpFormData = z.infer<typeof unifiedSignUpSchema>;

/** Password reset form schema -- token from URL + new password + confirmation */
export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Missing reset token'),
    password: passwordField,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
export type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

/** Verification code schema */
export const verifyEmailSchema = z.object({
  pendingAuthToken: z.string().min(1, 'Missing verification token'),
  code: z
    .string()
    .length(6, 'Code must be 6 digits')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
  companyName: companyNameField.optional(), // BAL-350 — carried from signup into verify
});
export type VerifyEmailFormData = z.infer<typeof verifyEmailSchema>;
