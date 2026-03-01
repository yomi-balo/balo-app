'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { InputFloating } from '@/components/enhanced/input-floating';
import { BlurFade } from '@/components/magicui/blur-fade';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from './auth-header';
import { forgotPasswordAction } from '@/lib/auth/actions';
import { forgotPasswordSchema, type ForgotPasswordFormData } from './schemas';

interface ForgotPasswordFormProps {
  onSuccess: () => void;
  onBackToSignIn: () => void;
}

export function ForgotPasswordForm({
  onSuccess,
  onBackToSignIn,
}: Readonly<ForgotPasswordFormProps>): React.JSX.Element {
  const [isSuccess, setIsSuccess] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: {
      email: '',
    },
  });

  const { isSubmitting } = form.formState;

  const onSubmit = async (data: ForgotPasswordFormData): Promise<void> => {
    setFormError(null);
    const result = await forgotPasswordAction(data);
    if (result.success) {
      setSubmittedEmail(data.email);
      setIsSuccess(true);
      onSuccess();
    } else {
      setFormError(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AnimatePresence mode="wait">
        {isSuccess ? (
          <BlurFade
            key="success"
            managed
            duration={0.3}
            direction="up"
            className="flex flex-col items-center gap-4 py-4 text-center"
          >
            <div className="bg-success/10 flex h-14 w-14 items-center justify-center rounded-full">
              <CheckCircle2 className="text-success h-7 w-7" />
            </div>

            <div className="space-y-2">
              <h2 className="text-foreground text-xl font-semibold">Check your email</h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                We&apos;ve sent a password reset link to{' '}
                <span className="text-foreground font-medium">{submittedEmail}</span>
              </p>
            </div>

            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              Didn&apos;t receive the email? Check your spam folder or{' '}
              <button
                type="button"
                onClick={() => {
                  setIsSuccess(false);
                  form.reset();
                }}
                className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                try again
              </button>
            </p>

            <Button type="button" variant="outline" className="mt-2" onClick={onBackToSignIn}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to sign in
            </Button>
          </BlurFade>
        ) : (
          <BlurFade
            key="form"
            managed
            duration={0.2}
            direction="up"
            className="flex flex-col gap-6"
          >
            <AuthHeader
              title="Reset your password"
              subtitle="Enter your email and we'll send you a link to reset your password"
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
                      Sending link...
                    </>
                  ) : (
                    'Send Reset Link'
                  )}
                </ShimmerButton>
              </form>
            </Form>

            <Button type="button" variant="ghost" className="mx-auto" onClick={onBackToSignIn}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to sign in
            </Button>
          </BlurFade>
        )}
      </AnimatePresence>
    </div>
  );
}
