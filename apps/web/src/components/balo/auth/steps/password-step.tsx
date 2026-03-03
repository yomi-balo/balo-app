'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputPassword } from '@/components/enhanced/input-password';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from '../auth-header';
import { signInAction } from '@/lib/auth/actions';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
import { signInSchema, type SignInFormData } from '../schemas';

interface PasswordStepProps {
  email: string;
  formError: string | null;
  onSuccess: () => void;
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  onBack: () => void;
  onError: (error: string) => void;
}

export function PasswordStep({
  email,
  formError,
  onSuccess,
  onForgotPassword,
  onCreateAccount,
  onBack,
  onError,
}: Readonly<PasswordStepProps>): React.JSX.Element {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email, password: '' },
  });

  const onSubmit = async (data: SignInFormData): Promise<void> => {
    setIsSubmitting(true);
    try {
      const result = await signInAction(data);
      if (result.success) {
        track(AUTH_EVENTS.LOGIN_COMPLETED, {
          method: 'email',
          is_returning_user: !result.data?.needsOnboarding,
        });
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
        track(AUTH_EVENTS.LOGIN_FAILED, {
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
      <div className="flex items-start">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 rounded-sm p-1 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          aria-label="Back to email"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      </div>

      <AuthHeader title="Welcome back" subtitle="Enter your password to sign in" />

      {/* Email pill display */}
      <div className="bg-muted/50 flex items-center justify-between rounded-lg px-4 py-3">
        <span className="text-foreground text-sm font-medium">{email}</span>
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm p-1 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          aria-label="Change email"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Hidden email field for password managers */}
          <input type="hidden" name="email" value={email} autoComplete="email" />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <InputPassword
                    label="Password"
                    autoComplete="current-password"
                    disabled={isSubmitting}
                    showStrength={false}
                    autoFocus
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex justify-end">
            <button
              type="button"
              onClick={onForgotPassword}
              className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Forgot password?
            </button>
          </div>

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
                Signing in...
              </>
            ) : (
              'Sign In'
            )}
          </ShimmerButton>
        </form>
      </Form>

      <p className="text-muted-foreground text-center text-sm">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          onClick={onCreateAccount}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Create one
        </button>
      </p>
    </div>
  );
}
