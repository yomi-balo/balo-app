'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SocialButtons } from './social-buttons';
import { signInSchema, type SignInFormData } from './auth-schemas';

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
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInFormData>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(data: SignInFormData): Promise<void> {
    setAuthError(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log('[Auth Placeholder] Sign in:', data);
      onSuccess();
    } catch {
      setAuthError('Invalid email or password. Please try again.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-foreground text-xl font-semibold tracking-tight">Welcome back</h2>
        <p className="text-muted-foreground mt-1.5 text-sm">Sign in to your Balo account</p>
      </div>

      {/* Social auth */}
      <SocialButtons disabled={isSubmitting} />

      {/* Divider */}
      <div className="relative flex items-center">
        <div className="border-border flex-1 border-t" />
        <span className="text-muted-foreground bg-background px-3 text-xs tracking-wider uppercase">
          or
        </span>
        <div className="border-border flex-1 border-t" />
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
        {/* Email */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="signin-email">Email</Label>
          <Input
            id="signin-email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            disabled={isSubmitting}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'signin-email-error' : undefined}
            {...register('email')}
          />
          {errors.email && (
            <p id="signin-email-error" className="text-destructive text-xs" role="alert">
              {errors.email.message}
            </p>
          )}
        </div>

        {/* Password */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="signin-password">Password</Label>
            <button
              type="button"
              onClick={onForgotPassword}
              className="text-primary focus-visible:ring-ring rounded-sm text-xs font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              Forgot password?
            </button>
          </div>
          <div className="relative">
            <Input
              id="signin-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Enter your password"
              autoComplete="current-password"
              disabled={isSubmitting}
              aria-invalid={!!errors.password}
              aria-describedby={errors.password ? 'signin-password-error' : undefined}
              className="pr-10"
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {errors.password && (
            <p id="signin-password-error" className="text-destructive text-xs" role="alert">
              {errors.password.message}
            </p>
          )}
        </div>

        {/* Submit */}
        <motion.div whileTap={{ scale: 0.98 }}>
          <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </motion.div>
      </form>

      {/* Switch to signup */}
      <p className="text-muted-foreground text-center text-sm">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          onClick={onSwitchToSignUp}
          className="text-primary focus-visible:ring-ring rounded-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign up
        </button>
      </p>
    </div>
  );
}
