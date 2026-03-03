'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputPassword } from '@/components/enhanced/input-password';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from './auth-header';
import { AuthDivider } from './auth-divider';
import { SocialAuthButtons } from './social-auth-buttons';
import { useRouter } from 'next/navigation';
import { signUpAction } from '@/lib/auth/actions';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
import { signUpSchema, type SignUpFormData } from './schemas';

interface SignUpFormProps {
  onSuccess: () => void;
  onSwitchToSignIn: () => void;
}

export function SignUpForm({
  onSuccess,
  onSwitchToSignIn,
}: Readonly<SignUpFormProps>): React.JSX.Element {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      password: '',
    },
  });

  const { isSubmitting } = form.formState;

  const onSubmit = async (data: SignUpFormData): Promise<void> => {
    setFormError(null);
    const result = await signUpAction(data);
    if (result.success) {
      track(AUTH_EVENTS.SIGNUP_COMPLETED, { method: 'email' });
      analytics.identify(result.data?.userId ?? '', {
        email: result.data?.email,
        active_mode: result.data?.activeMode,
        platform_role: result.data?.platformRole,
      });
      if (result.data?.needsOnboarding) {
        router.push('/onboarding');
      }
      onSuccess();
    } else {
      track(AUTH_EVENTS.SIGNUP_FAILED, { method: 'email', error_message: result.error });
      setFormError(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader
        title="Create your account"
        subtitle="Join Balo to connect with expert consultants"
      />

      <SocialAuthButtons disabled={isSubmitting} />

      <AuthDivider />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="First name"
                      autoComplete="given-name"
                      disabled={isSubmitting}
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
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="Last name"
                      autoComplete="family-name"
                      disabled={isSubmitting}
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
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <InputFloating
                    label="Email address"
                    type="email"
                    autoComplete="email"
                    disabled={isSubmitting}
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
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <InputPassword
                    label="Create a password"
                    autoComplete="new-password"
                    disabled={isSubmitting}
                    showStrength={true}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {formError && (
            <p className="text-destructive text-center text-sm" role="alert">
              {formError}
            </p>
          )}

          <ShimmerButton
            type="submit"
            disabled={isSubmitting}
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating account...
              </>
            ) : (
              'Create Account'
            )}
          </ShimmerButton>
        </form>
      </Form>

      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitchToSignIn}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign in
        </button>
      </p>
    </div>
  );
}
