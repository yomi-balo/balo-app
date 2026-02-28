'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputPassword } from '@/components/enhanced/input-password';
import { SocialAuthButtons } from './social-auth-buttons';
import { AuthDivider } from './auth-divider';
import { AuthHeader } from './auth-header';
import { AuthSubmitButton } from './auth-submit-button';
import { AuthErrorBanner } from './auth-error-banner';
import { AuthFooterLink } from './auth-footer-link';
import { signUpSchema, type SignUpFormData } from './auth-schemas';
import { signUpAction } from '@/lib/auth/auth-actions';

interface SignUpFormProps {
  onSuccess: () => void;
  onSwitchToSignIn: () => void;
}

export function SignUpForm({ onSuccess, onSwitchToSignIn }: SignUpFormProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const form = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
    mode: 'onTouched',
  });

  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (data: SignUpFormData): Promise<void> => {
    setError(null);
    const result = await signUpAction(data);
    if (result.success) {
      onSuccess();
    } else {
      setError(result.error ?? 'Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <AuthHeader title="Create your account" subtitle="Get started with Balo in seconds" />

      <div className="mt-6">
        <SocialAuthButtons isLoading={isSubmitting} />
      </div>

      <AuthDivider />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="First name"
                      error={!!fieldState.error}
                      disabled={isSubmitting}
                      autoComplete="given-name"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="lastName"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="Last name"
                      error={!!fieldState.error}
                      disabled={isSubmitting}
                      autoComplete="family-name"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormControl>
                  <InputFloating
                    label="Email address"
                    type="email"
                    error={!!fieldState.error}
                    disabled={isSubmitting}
                    autoComplete="email"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormControl>
                  <InputPassword
                    label="Password"
                    error={!!fieldState.error}
                    disabled={isSubmitting}
                    showStrength
                    autoComplete="new-password"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <AuthSubmitButton isLoading={isSubmitting} text="Create account" />
          <AuthErrorBanner error={error} />
        </form>
      </Form>

      <p className="text-muted-foreground mt-4 text-center text-xs">
        By creating an account, you agree to our{' '}
        <a
          href="/terms"
          className="text-foreground underline underline-offset-4 hover:no-underline"
        >
          Terms of Service
        </a>{' '}
        and{' '}
        <a
          href="/privacy"
          className="text-foreground underline underline-offset-4 hover:no-underline"
        >
          Privacy Policy
        </a>
      </p>

      <AuthFooterLink
        text="Already have an account?"
        linkText="Sign in"
        onClick={onSwitchToSignIn}
      />
    </div>
  );
}
