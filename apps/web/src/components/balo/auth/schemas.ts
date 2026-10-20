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

/**
 * Mirrors the WorkOS password policy: minimum length 10, strength score >= 3,
 * breached-password check, no composition rules. Only the length is checkable
 * here; WorkOS rejects guessable or breached passwords and `mapWorkOSError`
 * explains why.
 */
export const PASSWORD_MIN_LENGTH = 10;

/** Shared password requirements — single source of truth for signup + reset */
const passwordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);

/** Unified sign-up schema -- no firstName/lastName (collected in onboarding) */
export const unifiedSignUpSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Please enter a valid email address'),
  password: passwordField,
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
});
export type VerifyEmailFormData = z.infer<typeof verifyEmailSchema>;
