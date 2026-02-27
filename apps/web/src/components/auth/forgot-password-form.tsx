'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion, AnimatePresence } from 'motion/react';
import { AlertCircle, ArrowLeft, Loader2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { forgotPasswordSchema, type ForgotPasswordFormData } from './auth-schemas';

interface ForgotPasswordFormProps {
  onBack: () => void;
}

export function ForgotPasswordForm({ onBack }: ForgotPasswordFormProps): React.JSX.Element {
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(data: ForgotPasswordFormData): Promise<void> {
    setAuthError(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log('[Auth Placeholder] Forgot password:', data);
      setSubmittedEmail(data.email);
      setIsSubmitted(true);
    } catch {
      setAuthError('Could not send reset link. Please try again.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <AnimatePresence mode="wait">
        {isSubmitted ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="flex flex-col items-center gap-4 py-4 text-center"
          >
            {/* Success icon */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.4, ease: 'easeOut', delay: 0.1 }}
              className="bg-primary/10 flex size-14 items-center justify-center rounded-full"
            >
              <Mail className="text-primary size-7" />
            </motion.div>

            <div>
              <h2 className="text-foreground text-xl font-semibold tracking-tight">
                Check your email
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">
                We sent a password reset link to{' '}
                <span className="text-foreground font-medium">{submittedEmail}</span>
              </p>
            </div>

            <p className="text-muted-foreground text-xs">
              Didn&apos;t receive the email? Check your spam folder or{' '}
              <button
                type="button"
                onClick={() => setIsSubmitted(false)}
                className="text-primary focus-visible:ring-ring rounded-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                try again
              </button>
            </p>

            <Button variant="outline" onClick={onBack} className="mt-2 gap-2">
              <ArrowLeft className="size-4" />
              Back to sign in
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col gap-6"
          >
            {/* Header */}
            <div className="text-center">
              <h2 className="text-foreground text-xl font-semibold tracking-tight">
                Reset your password
              </h2>
              <p className="text-muted-foreground mt-1.5 text-sm">
                Enter your email and we&apos;ll send you a reset link
              </p>
            </div>

            {/* Auth error */}
            <AnimatePresence>
              {authError && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2 }}
                  className="bg-destructive/10 border-destructive/20 flex items-center gap-2 rounded-lg border px-3 py-2.5"
                  role="alert"
                >
                  <AlertCircle className="text-destructive size-4 shrink-0" />
                  <p className="text-destructive text-sm">{authError}</p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Form */}
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  placeholder="you@company.com"
                  autoComplete="email"
                  disabled={isSubmitting}
                  aria-invalid={!!errors.email}
                  aria-describedby={errors.email ? 'forgot-email-error' : undefined}
                  {...register('email')}
                />
                {errors.email && (
                  <p id="forgot-email-error" className="text-destructive text-xs" role="alert">
                    {errors.email.message}
                  </p>
                )}
              </div>

              <motion.div whileTap={{ scale: 0.98 }}>
                <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Sending…
                    </>
                  ) : (
                    'Send reset link'
                  )}
                </Button>
              </motion.div>
            </form>

            {/* Back link */}
            <button
              type="button"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mx-auto flex items-center gap-1.5 rounded-sm text-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <ArrowLeft className="size-3.5" />
              Back to sign in
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
