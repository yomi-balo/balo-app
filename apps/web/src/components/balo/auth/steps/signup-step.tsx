'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputPassword } from '@/components/enhanced/input-password';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from '../auth-header';
import { signUpAction } from '@/lib/auth/actions';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
import { unifiedSignUpSchema, type UnifiedSignUpFormData } from '../schemas';

interface SignupStepProps {
  email: string;
  formError: string | null;
  onEmailChange: (email: string) => void;
  onVerificationRequired: (pendingAuthToken: string) => void;
  onSuccess: () => void;
  onSignInInstead: () => void;
  onError: (error: string) => void;
}

export function SignupStep({
  email,
  formError,
  onEmailChange,
  onVerificationRequired,
  onSuccess,
  onSignInInstead,
  onError,
}: Readonly<SignupStepProps>): React.JSX.Element {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<UnifiedSignUpFormData>({
    resolver: zodResolver(unifiedSignUpSchema),
    defaultValues: { email, password: '' },
  });

  const onSubmit = async (data: UnifiedSignUpFormData): Promise<void> => {
    setIsSubmitting(true);
    onEmailChange(data.email);
    try {
      const result = await signUpAction(data);
      if (result.success) {
        track(AUTH_EVENTS.SIGNUP_COMPLETED, { method: 'email' });

        if (result.data?.verified) {
          // Fallback path: no verification required
          analytics.identify(result.data.userId ?? '', {
            email: result.data.email,
            active_mode: result.data.activeMode,
            platform_role: result.data.platformRole,
          });
          if (result.data.needsOnboarding) {
            router.push('/onboarding');
          }
          onSuccess();
        } else if (result.data?.pendingAuthToken) {
          // Email verification required
          onVerificationRequired(result.data.pendingAuthToken);
        }
      } else {
        track(AUTH_EVENTS.SIGNUP_FAILED, {
          method: 'email',
          error_message: result.error,
        });
        onError(result.error);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader
        title="Create your account"
        subtitle="Join Balo to connect with expert consultants"
      />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
          onClick={onSignInInstead}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign in
        </button>
      </p>
    </div>
  );
}
