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
import { signInAction } from '@/lib/auth/actions';
import { signInSchema, type SignInFormData } from './schemas';

interface SignInFormProps {
  onSuccess: () => void;
  onSwitchToSignUp: () => void;
  onForgotPassword: () => void;
}

export function SignInForm({
  onSuccess,
  onSwitchToSignUp,
  onForgotPassword,
}: Readonly<SignInFormProps>): React.JSX.Element {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const { isSubmitting } = form.formState;

  const onSubmit = async (data: SignInFormData): Promise<void> => {
    setFormError(null);
    const result = await signInAction(data);
    if (result.success) {
      if (result.data?.needsOnboarding) {
        router.push('/onboarding');
      }
      onSuccess();
    } else {
      setFormError(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title="Welcome back" subtitle="Sign in to your Balo account to continue" />

      <SocialAuthButtons disabled={isSubmitting} />

      <AuthDivider />

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
                    label="Password"
                    autoComplete="current-password"
                    disabled={isSubmitting}
                    showStrength={false}
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
          onClick={onSwitchToSignUp}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign up
        </button>
      </p>
    </div>
  );
}
