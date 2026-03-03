'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from '../auth-header';
import { AuthDivider } from '../auth-divider';
import { SocialAuthButtons } from '../social-auth-buttons';
import { emailSchema, type EmailFormData } from '../schemas';

interface EmailStepProps {
  email: string;
  formError: string | null;
  onEmailChange: (email: string) => void;
  onContinue: (email: string) => void;
  onCreateAccount: () => void;
}

export function EmailStep({
  email,
  formError,
  onEmailChange,
  onContinue,
  onCreateAccount,
}: Readonly<EmailStepProps>): React.JSX.Element {
  const form = useForm<EmailFormData>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email },
  });

  const onSubmit = (data: EmailFormData): void => {
    onEmailChange(data.email);
    onContinue(data.email);
  };

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title="Welcome to Balo" subtitle="Sign in or create an account to continue" />
      <SocialAuthButtons />
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
                    autoFocus
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
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            Continue with email
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
