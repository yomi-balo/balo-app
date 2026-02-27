'use client';

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, EyeOff, Loader2, AlertCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SocialButtons } from './social-buttons';
import { signUpSchema, type SignUpFormData } from './auth-schemas';
import { cn } from '@/lib/utils';

interface SignUpFormProps {
  onSuccess: () => void;
  onSwitchToSignIn: () => void;
}

const PASSWORD_RULES = [
  { label: '8+ characters', test: (pw: string) => pw.length >= 8 },
  { label: 'Uppercase letter', test: (pw: string) => /[A-Z]/.test(pw) },
  { label: 'Number', test: (pw: string) => /[0-9]/.test(pw) },
] as const;

export function SignUpForm({ onSuccess, onSwitchToSignIn }: SignUpFormProps): React.JSX.Element {
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
  });

  const password = watch('password');

  const passwordStrength = useMemo(() => {
    if (!password) return { score: 0, met: [] as boolean[] };
    const met = PASSWORD_RULES.map((rule) => rule.test(password));
    const score = met.filter(Boolean).length;
    return { score, met };
  }, [password]);

  async function onSubmit(data: SignUpFormData): Promise<void> {
    setAuthError(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log('[Auth Placeholder] Sign up:', data);
      onSuccess();
    } catch {
      setAuthError('Could not create account. Please try again.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-foreground text-xl font-semibold tracking-tight">
          Create your account
        </h2>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Start finding expert consultants in minutes
        </p>
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
        {/* Name fields — side by side */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="signup-first-name">First name</Label>
            <Input
              id="signup-first-name"
              type="text"
              placeholder="Jane"
              autoComplete="given-name"
              disabled={isSubmitting}
              aria-invalid={!!errors.firstName}
              aria-describedby={errors.firstName ? 'signup-firstname-error' : undefined}
              {...register('firstName')}
            />
            {errors.firstName && (
              <p id="signup-firstname-error" className="text-destructive text-xs" role="alert">
                {errors.firstName.message}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="signup-last-name">Last name</Label>
            <Input
              id="signup-last-name"
              type="text"
              placeholder="Smith"
              autoComplete="family-name"
              disabled={isSubmitting}
              aria-invalid={!!errors.lastName}
              aria-describedby={errors.lastName ? 'signup-lastname-error' : undefined}
              {...register('lastName')}
            />
            {errors.lastName && (
              <p id="signup-lastname-error" className="text-destructive text-xs" role="alert">
                {errors.lastName.message}
              </p>
            )}
          </div>
        </div>

        {/* Email */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="signup-email">Email</Label>
          <Input
            id="signup-email"
            type="email"
            placeholder="jane@company.com"
            autoComplete="email"
            disabled={isSubmitting}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'signup-email-error' : undefined}
            {...register('email')}
          />
          {errors.email && (
            <p id="signup-email-error" className="text-destructive text-xs" role="alert">
              {errors.email.message}
            </p>
          )}
        </div>

        {/* Password */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="signup-password">Password</Label>
          <div className="relative">
            <Input
              id="signup-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Create a password"
              autoComplete="new-password"
              disabled={isSubmitting}
              aria-invalid={!!errors.password}
              aria-describedby="signup-password-strength"
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

          {/* Password strength indicator */}
          {password && (
            <div id="signup-password-strength" className="flex flex-col gap-2">
              {/* Strength bar */}
              <div className="flex gap-1">
                {[1, 2, 3].map((level) => (
                  <div
                    key={level}
                    className={cn(
                      'h-1 flex-1 rounded-full transition-colors duration-300',
                      passwordStrength.score >= level
                        ? passwordStrength.score === 3
                          ? 'bg-success'
                          : passwordStrength.score === 2
                            ? 'bg-warning'
                            : 'bg-destructive'
                        : 'bg-muted'
                    )}
                  />
                ))}
              </div>
              {/* Rule checklist */}
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {PASSWORD_RULES.map((rule, i) => (
                  <span
                    key={rule.label}
                    className={cn(
                      'flex items-center gap-1 text-xs transition-colors duration-200',
                      passwordStrength.met[i] ? 'text-success' : 'text-muted-foreground'
                    )}
                  >
                    <Check
                      className={cn(
                        'size-3 transition-transform duration-200',
                        passwordStrength.met[i] ? 'scale-100' : 'scale-75 opacity-50'
                      )}
                    />
                    {rule.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {errors.password && !password && (
            <p className="text-destructive text-xs" role="alert">
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
                Creating account…
              </>
            ) : (
              'Create account'
            )}
          </Button>
        </motion.div>
      </form>

      {/* Switch to signin */}
      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitchToSignIn}
          className="text-primary focus-visible:ring-ring rounded-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign in
        </button>
      </p>
    </div>
  );
}
