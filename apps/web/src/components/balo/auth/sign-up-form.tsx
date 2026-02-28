'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertCircle, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputPassword } from '@/components/enhanced/input-password';
import { SocialAuthButtons } from './social-auth-buttons';
import { AuthDivider } from './auth-divider';
import { signUpSchema, type SignUpFormData } from './auth-schemas';
import { signUpAction } from '@/lib/auth/auth-actions';

interface SignUpFormProps {
  onSuccess: () => void;
  onSwitchToSignIn: () => void;
}

export function SignUpForm({ onSuccess, onSwitchToSignIn }: SignUpFormProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);

  const form = useForm<SignUpFormData>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
    mode: 'onTouched',
  });

  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (data: SignUpFormData): Promise<void> => {
    setError(null);
    const result = await signUpAction(data);
    if (result.success) {
      onSuccess();
    } else {
      setError(result.error ?? 'Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <div>
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          Create your account
        </h2>
        <p className="text-muted-foreground mt-1.5 text-sm">Get started with Balo in seconds</p>
      </div>

      <div className="mt-6">
        <SocialAuthButtons isLoading={isSubmitting} />
      </div>

      <AuthDivider />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="First name"
                      error={!!fieldState.error}
                      disabled={isSubmitting}
                      autoComplete="given-name"
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
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="Last name"
                      error={!!fieldState.error}
                      disabled={isSubmitting}
                      autoComplete="family-name"
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

          <FormField
            control={form.control}
            name="password"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormControl>
                  <InputPassword
                    label="Password"
                    error={!!fieldState.error}
                    disabled={isSubmitting}
                    showStrength
                    autoComplete="new-password"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <motion.div whileTap={{ scale: 0.98 }}>
            <Button
              type="submit"
              className="h-11 w-full text-sm font-medium"
              disabled={isSubmitting}
            >
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create account'}
            </Button>
          </motion.div>

          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg px-4 py-3 text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </form>
      </Form>

      <p className="text-muted-foreground mt-4 text-center text-xs">
        By creating an account, you agree to our{' '}
        <a
          href="/terms"
          className="text-foreground underline underline-offset-4 hover:no-underline"
        >
          Terms of Service
        </a>{' '}
        and{' '}
        <a
          href="/privacy"
          className="text-foreground underline underline-offset-4 hover:no-underline"
        >
          Privacy Policy
        </a>
      </p>

      <p className="text-muted-foreground mt-4 text-center text-sm">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitchToSignIn}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-md font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign in
        </button>
      </p>
    </div>
  );
}
