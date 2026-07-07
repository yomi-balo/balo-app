'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { suggestCompanyNameFromEmail } from '@balo/shared/domains';
import {
  Form,
  FormField,
  FormItem,
  FormControl,
  FormDescription,
  FormMessage,
} from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputPassword } from '@/components/enhanced/input-password';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { AuthHeader } from '../auth-header';
import { SocialAuthButtons } from '../social-auth-buttons';
import { AuthDivider } from '../auth-divider';
import { signUpAction, checkSignupDomainAction } from '@/lib/auth/actions';
import { track, AUTH_EVENTS, analytics } from '@/lib/analytics';
import {
  unifiedSignUpSchema,
  emailSchema,
  type UnifiedSignUpFormData,
  type SignupDomainStatus,
} from '../schemas';

interface SignupStepProps {
  email: string;
  formError: string | null;
  onEmailChange: (email: string) => void;
  onVerificationRequired: (pendingAuthToken: string, companyName?: string) => void;
  onSuccess: () => void;
  onSignInInstead: () => void;
  onError: (error: string) => void;
}

export function SignupStep({
  email,
  formError,
  onEmailChange,
  onVerificationRequired,
  onSuccess,
  onSignInInstead,
  onError,
}: Readonly<SignupStepProps>): React.JSX.Element {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [domainStatus, setDomainStatus] = useState<SignupDomainStatus | null>(null);
  const [isCheckingDomain, setIsCheckingDomain] = useState(false);
  // Tracks which email the current `domainStatus` was resolved for, so the
  // submit-time guard can detect a status left stale by an in-flight email edit.
  const checkedEmailRef = useRef<string | null>(null);

  const form = useForm<UnifiedSignUpFormData>({
    resolver: zodResolver(unifiedSignUpSchema),
    defaultValues: { email, password: '', companyName: '' },
  });

  // The compulsory field is shown for a blocked domain or an unmatched ('new')
  // domain; hidden for an actionable 'matched' domain and while status is null
  // (the submit-time guard covers the not-yet-resolved case).
  const showCompanyField = domainStatus === 'blocked' || domainStatus === 'new';

  /**
   * Read-only pre-submit domain check. Sets the effective status and, on a fresh
   * 'new' transition with an untouched field, prefills an editable company-name
   * suggestion. Fails open to 'new' (the action already fails open; this is a
   * defensive backstop so a throw never blocks signup).
   */
  const runDomainCheck = useCallback(
    async (candidateEmail: string): Promise<SignupDomainStatus> => {
      setIsCheckingDomain(true);
      let status: SignupDomainStatus = 'new';
      try {
        const result = await checkSignupDomainAction(candidateEmail);
        status = result.status;
      } catch {
        status = 'new';
      } finally {
        setIsCheckingDomain(false);
      }
      setDomainStatus(status);
      checkedEmailRef.current = candidateEmail;
      if (status === 'new' && !form.getFieldState('companyName').isDirty) {
        form.setValue('companyName', suggestCompanyNameFromEmail(candidateEmail), {
          shouldDirty: false,
        });
      }
      return status;
    },
    [form]
  );

  // Trigger the check: immediately on the first valid email (mount / arrival), then
  // debounced (350 ms) on subsequent edits so the field state stays live without
  // per-keystroke server chatter. Partial/invalid emails are never checked.
  const watchedEmail = form.watch('email');
  const isFirstCheck = useRef(true);
  useEffect(() => {
    if (!emailSchema.safeParse({ email: watchedEmail }).success) return;
    if (isFirstCheck.current) {
      isFirstCheck.current = false;
      void runDomainCheck(watchedEmail);
      return;
    }
    const timer = setTimeout(() => void runDomainCheck(watchedEmail), 350);
    return () => clearTimeout(timer);
  }, [watchedEmail, runDomainCheck]);

  const onSubmit = async (data: UnifiedSignUpFormData): Promise<void> => {
    setIsSubmitting(true);
    onEmailChange(data.email);
    try {
      // Submit-time guard: (re)resolve the status when we have none yet, or when
      // the cached status belongs to a different (older) email than the one being
      // submitted — so a debounce that hasn't landed, or a stale pre-edit status,
      // can never wave through an unnamed workspace on an unmatched domain.
      const needsCheck = domainStatus === null || checkedEmailRef.current !== data.email;
      const status = needsCheck ? await runDomainCheck(data.email) : domainStatus;
      const showField = status === 'blocked' || status === 'new';

      // Read the LIVE form value — a prefill applied by the guard above lands in
      // the form store, not in the react-hook-form snapshot captured at submit.
      const trimmedName = (form.getValues('companyName') ?? '').trim();

      // Compulsory enforcement (imperative — the field is conditional on visibility).
      if (showField && trimmedName === '') {
        form.setError('companyName', { message: 'Company name is required' });
        form.setFocus('companyName');
        return;
      }

      const companyName = showField ? trimmedName : undefined;
      const result = await signUpAction({
        email: data.email,
        password: data.password,
        companyName,
      });

      if (result.success) {
        track(AUTH_EVENTS.SIGNUP_COMPLETED, { method: 'email' });
        if (showField && companyName) {
          track(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
            domain_type: status === 'blocked' ? 'blocked' : 'new',
          });
        }

        if (result.data?.verified) {
          // Fallback path: no verification required
          analytics.identify(result.data.userId ?? '', {
            email: result.data.email,
            active_mode: result.data.activeMode,
            platform_role: result.data.platformRole,
          });
          if (result.data.needsOnboarding) {
            router.push('/onboarding');
          }
          onSuccess();
        } else if (result.data?.pendingAuthToken) {
          // Email verification required — carry the captured name to the verify step.
          onVerificationRequired(result.data.pendingAuthToken, companyName);
        }
      } else {
        track(AUTH_EVENTS.SIGNUP_FAILED, {
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
      <AuthHeader
        title="Create your account"
        subtitle="Join Balo to connect with expert consultants"
      />

      <SocialAuthButtons disabled={isSubmitting} />
      <AuthDivider label="or sign up with email" />

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
                    label="Create a password"
                    autoComplete="new-password"
                    disabled={isSubmitting}
                    showStrength={true}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {isCheckingDomain && !showCompanyField && (
            <div
              className="text-muted-foreground flex min-h-11 items-center gap-2 px-1 text-sm"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking your company&hellip;</span>
            </div>
          )}

          {showCompanyField && (
            <FormField
              control={form.control}
              name="companyName"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <InputFloating
                      label="Company name *"
                      autoComplete="organization"
                      aria-required
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    We&apos;ll set up your workspace under this name.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

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
                Creating account...
              </>
            ) : (
              'Create Account'
            )}
          </ShimmerButton>
        </form>
      </Form>

      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSignInInstead}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign in
        </button>
      </p>
    </div>
  );
}
