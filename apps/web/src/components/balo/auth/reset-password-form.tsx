'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, CheckCircle2, Loader2, AlertCircle, Clock } from 'lucide-react';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { InputPassword } from '@/components/enhanced/input-password';
import { BlurFade } from '@/components/magicui/blur-fade';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from '@/components/balo/auth/auth-header';
import { resetPasswordAction } from '@/lib/auth/actions';
import { track, AUTH_EVENTS } from '@/lib/analytics';
import { resetPasswordSchema, type ResetPasswordFormData } from '@/components/balo/auth/schemas';

type ViewState = 'form' | 'success' | 'error-missing' | 'error-expired';

interface ResetPasswordFormProps {
  token: string | undefined;
}

export function ResetPasswordForm({ token }: Readonly<ResetPasswordFormProps>): React.JSX.Element {
  const router = useRouter();
  const [viewState, setViewState] = useState<ViewState>(
    !token || token.trim() === '' ? 'error-missing' : 'form'
  );
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: {
      token: token ?? '',
      password: '',
      confirmPassword: '',
    },
  });

  const { isSubmitting } = form.formState;

  useEffect(() => {
    if (!token || token.trim() === '') {
      track(AUTH_EVENTS.PASSWORD_RESET_TOKEN_MISSING, {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async (data: ResetPasswordFormData): Promise<void> => {
    setFormError(null);
    const result = await resetPasswordAction(data);

    if (result.success) {
      track(AUTH_EVENTS.PASSWORD_RESET_COMPLETED, {});
      setViewState('success');
    } else {
      track(AUTH_EVENTS.PASSWORD_RESET_FAILED, { error_message: result.error });

      // Differentiate token errors from form errors
      if (result.code === 'password_reset_expired') {
        setViewState('error-expired');
      } else if (
        result.error?.toLowerCase().includes('expired') ||
        result.error?.toLowerCase().includes('invalid reset') ||
        result.error?.toLowerCase().includes('invalid or expired')
      ) {
        // Fallback: if WorkOS returns an error message indicating token issues
        // but with a different/missing code
        setViewState('error-expired');
      } else {
        // Generic or password-too-weak errors: show inline, keep form active
        setFormError(result.error);
      }
    }
  };

  return (
    <div className="bg-card w-full max-w-sm rounded-xl border p-8 shadow-sm">
      <AnimatePresence mode="wait">
        {viewState === 'form' && (
          <BlurFade
            key="form"
            managed
            duration={0.3}
            direction="up"
            className="flex flex-col gap-6"
          >
            <AuthHeader
              title="Set your new password"
              subtitle="Choose a strong password to secure your account"
            />

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                {/* New password with strength indicator */}
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <InputPassword
                          label="New password"
                          autoComplete="new-password"
                          autoFocus
                          disabled={isSubmitting}
                          showStrength={true}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Confirm password without strength indicator */}
                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <InputPassword
                          label="Confirm password"
                          autoComplete="new-password"
                          disabled={isSubmitting}
                          showStrength={false}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Inline form error (generic/password-too-weak errors) */}
                {formError && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="text-destructive text-center text-sm"
                    role="alert"
                  >
                    {formError}
                  </motion.p>
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
                      Resetting password...
                    </>
                  ) : (
                    'Reset Password'
                  )}
                </ShimmerButton>
              </form>
            </Form>

            <Button variant="ghost" className="mx-auto" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to sign in
              </Link>
            </Button>
          </BlurFade>
        )}

        {viewState === 'success' && (
          <BlurFade
            key="success"
            managed
            duration={0.3}
            direction="up"
            className="flex flex-col items-center gap-4 py-4 text-center"
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="bg-success/10 flex h-14 w-14 items-center justify-center rounded-full"
            >
              <CheckCircle2 className="text-success h-7 w-7" />
            </motion.div>

            <div className="space-y-2">
              <h2 className="text-foreground text-xl font-semibold">Password reset successful</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Your password has been updated. You can now sign in with your new password.
              </p>
            </div>

            <ShimmerButton
              className="h-11 w-full rounded-lg text-sm font-medium"
              shimmerColor="rgba(255, 255, 255, 0.15)"
              background="var(--primary)"
              onClick={() => router.push('/login')}
            >
              Sign in to your account
            </ShimmerButton>

            <p className="text-muted-foreground text-xs">
              Having trouble?{' '}
              <a
                href="mailto:support@getbalo.com"
                className="text-primary hover:text-primary/80 font-medium transition-colors"
              >
                Contact support@getbalo.com
              </a>
            </p>
          </BlurFade>
        )}

        {viewState === 'error-missing' && (
          <BlurFade
            key="error-missing"
            managed
            duration={0.3}
            direction="up"
            className="flex flex-col items-center gap-4 py-4 text-center"
          >
            <div className="bg-destructive/10 flex h-14 w-14 items-center justify-center rounded-full">
              <AlertCircle className="text-destructive h-7 w-7" />
            </div>

            <div className="space-y-2">
              <h2 className="text-foreground text-xl font-semibold">Invalid reset link</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                This password reset link appears to be invalid or incomplete. Please go back to sign
                in and request a new reset link.
              </p>
            </div>

            <Button variant="outline" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to sign in
              </Link>
            </Button>
          </BlurFade>
        )}

        {viewState === 'error-expired' && (
          <BlurFade
            key="error-expired"
            managed
            duration={0.3}
            direction="up"
            className="flex flex-col items-center gap-4 py-4 text-center"
          >
            <div className="bg-warning/10 flex h-14 w-14 items-center justify-center rounded-full">
              <Clock className="text-warning h-7 w-7" />
            </div>

            <div className="space-y-2">
              <h2 className="text-foreground text-xl font-semibold">Reset link expired</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                For your security, password reset links expire after a short time. Please go back to
                sign in and request a new link.
              </p>
            </div>

            <Button variant="outline" asChild>
              <Link href="/login">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to sign in
              </Link>
            </Button>
          </BlurFade>
        )}
      </AnimatePresence>
    </div>
  );
}
