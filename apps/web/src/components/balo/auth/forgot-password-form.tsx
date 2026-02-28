'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Mail } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { InputFloating } from '@/components/enhanced/input-floating';
import { AuthHeader } from './auth-header';
import { AuthSubmitButton } from './auth-submit-button';
import { AuthErrorBanner } from './auth-error-banner';
import { forgotPasswordSchema, type ForgotPasswordFormData } from './auth-schemas';
import { forgotPasswordAction } from '@/lib/auth/auth-actions';

interface ForgotPasswordFormProps {
  onBack: () => void;
}

export function ForgotPasswordForm({ onBack }: ForgotPasswordFormProps): React.JSX.Element {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
    mode: 'onTouched',
  });

  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (data: ForgotPasswordFormData): Promise<void> => {
    setError(null);
    const result = await forgotPasswordAction(data);
    if (result.success) {
      setSent(true);
    } else {
      setError(result.error ?? 'Something went wrong. Please try again.');
    }
  };

  return (
    <AnimatePresence mode="wait">
      {!sent ? (
        <motion.div
          key="form"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <button
            type="button"
            onClick={onBack}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </button>

          <div className="mt-4">
            <AuthHeader
              title="Reset your password"
              subtitle="Enter your email and we'll send you a reset link"
            />
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="mt-6 space-y-4">
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

              <AuthSubmitButton isLoading={isSubmitting} text="Send reset link" />
              <AuthErrorBanner error={error} />
            </form>
          </Form>
        </motion.div>
      ) : (
        <motion.div
          key="success"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col items-center text-center"
        >
          <div className="bg-primary/10 rounded-xl p-4">
            <Mail className="text-primary h-8 w-8" />
          </div>
          <h2 className="text-foreground mt-4 text-xl font-semibold">Check your email</h2>
          <p className="text-muted-foreground mt-1.5 text-sm">
            If an account exists with that email, we&apos;ve sent a password reset link.
          </p>
          <Button variant="outline" className="mt-6 w-full" onClick={onBack}>
            Back to sign in
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
