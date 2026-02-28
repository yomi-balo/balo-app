'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form } from '@/components/ui/form';
import { SocialAuthButtons } from './social-auth-buttons';
import { AuthDivider } from './auth-divider';
import { AuthHeader } from './auth-header';
import { AuthSubmitButton } from './auth-submit-button';
import { AuthErrorBanner } from './auth-error-banner';
import { AuthFooterLink } from './auth-footer-link';
import { AuthEmailField, AuthPasswordField } from './auth-form-fields';
import { signInSchema, type SignInFormData } from './auth-schemas';
import { signInAction } from '@/lib/auth/auth-actions';

interface SignInFormProps {
  onSuccess: () => void;
  onSwitchToSignUp: () => void;
  onForgotPassword: () => void;
}

export function SignInForm({
  onSuccess,
  onSwitchToSignUp,
  onForgotPassword,
}: SignInFormProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const form = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onTouched',
  });

  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (data: SignInFormData): Promise<void> => {
    setError(null);
    const result = await signInAction(data);
    if (result.success) {
      onSuccess();
    } else {
      setError(result.error ?? 'Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <AuthHeader title="Welcome back" subtitle="Sign in to your Balo account" />

      <div className="mt-6">
        <SocialAuthButtons isLoading={isSubmitting} />
      </div>

      <AuthDivider />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <AuthEmailField />
          <AuthPasswordField autoComplete="current-password" />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onForgotPassword}
              className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Forgot password?
            </button>
          </div>

          <AuthSubmitButton isLoading={isSubmitting} text="Sign in" />
          <AuthErrorBanner error={error} />
        </form>
      </Form>

      <AuthFooterLink text="Don't have an account?" linkText="Sign up" onClick={onSwitchToSignUp} />
    </div>
  );
}
