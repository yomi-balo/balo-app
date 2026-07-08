'use client';

import { forwardRef, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Loader2 } from 'lucide-react';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormMessage,
} from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { InputFloating } from '@/components/enhanced/input-floating';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import {
  resolveOnboardingCompanyAction,
  nameWorkspaceAndCompleteAction,
  type ResolveOnboardingCompanyResult,
} from '@/lib/auth/actions';
import type { AuthMethodSignal } from '@/lib/auth/auth-method';
import { companyNameSchema, type CompanyNameForm } from '@/lib/auth/company-name-schema';
import { track, AUTH_EVENTS, ONBOARDING_EVENTS } from '@/lib/analytics';

type Phase = 'resolving' | 'create' | 'join';

type JoinCompany = { name: string; memberCount: number; joinMode: 'auto' | 'request' };

interface CompanyStepProps {
  authMethod?: AuthMethodSignal;
  timezone?: string | null;
  stepNumber: number;
  onBack: () => void;
}

/**
 * BAL-350 onboarding company step (client terminal). Resolves the workspace
 * identity on mount (fail-open) and either renames it (CREATE branch) or, when an
 * actionable domain match exists, offers to JOIN the existing company (JOIN
 * branch — DORMANT in v1, unreachable until the shared-org creation seam ships;
 * coded, not deleted). Email is read server-side by the resolve action, never
 * passed as a prop.
 */
export const CompanyStep = forwardRef<HTMLHeadingElement, CompanyStepProps>(function CompanyStep(
  { authMethod, timezone, stepNumber, onBack },
  ref
) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('resolving');
  const [resolvedStatus, setResolvedStatus] = useState<'new' | 'blocked'>('new');
  const [joinCompany, setJoinCompany] = useState<JoinCompany | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Analytics inputs known only after resolve — kept in refs so they don't
  // re-trigger effects or renders.
  const initialSuggestionRef = useRef('');
  const resolveFailedOpenRef = useRef(false);

  const form = useForm<CompanyNameForm>({
    resolver: zodResolver(companyNameSchema),
    defaultValues: { companyName: '' },
  });

  // STEP_VIEWED fires once on mount (mirrors every existing step).
  useEffect(() => {
    track(ONBOARDING_EVENTS.STEP_VIEWED, {
      step: 'company',
      step_number: stepNumber,
      auth_method: authMethod,
    });
  }, [stepNumber, authMethod]);

  // Resolve the workspace identity on mount. The action already fails open
  // server-side; this client `catch` is the belt-and-suspenders RPC-level guard.
  useEffect(() => {
    let live = true;
    const applyCreate = (status: 'new' | 'blocked', suggestion: string): void => {
      initialSuggestionRef.current = suggestion;
      setResolvedStatus(status);
      form.reset({ companyName: suggestion });
      setPhase('create');
    };

    (async () => {
      try {
        const result: ResolveOnboardingCompanyResult = await resolveOnboardingCompanyAction();
        if (!live) return;
        if (result.status === 'matched') {
          setJoinCompany(result.company);
          setPhase('join');
          return;
        }
        applyCreate(result.status, result.status === 'blocked' ? '' : result.suggestion);
      } catch {
        if (!live) return;
        // Fail open: behave as an unmatched corporate domain, empty prefill.
        resolveFailedOpenRef.current = true;
        applyCreate('new', '');
      }
    })();

    return () => {
      live = false;
    };
  }, [form]);

  // Focus the heading once the phase settles (wizard convention — the wizard's
  // own focus effect no-ops while `resolving` has no heading).
  useEffect(() => {
    if (phase === 'resolving') return;
    const timer = setTimeout(() => {
      if (ref && typeof ref === 'object' && 'current' in ref) {
        ref.current?.focus();
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [phase, ref]);

  const onCreateSubmit = useCallback(
    (data: CompanyNameForm): void => {
      setActionError(null);
      startTransition(async () => {
        const result = await nameWorkspaceAndCompleteAction(data.companyName);
        if (!result.success) {
          setActionError(result.error);
          return;
        }
        const initialSuggestion = initialSuggestionRef.current;
        const prefillUsed = initialSuggestion !== '';
        const prefillEdited = prefillUsed && data.companyName !== initialSuggestion;
        track(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
          domain_type: resolvedStatus === 'blocked' ? 'blocked' : 'new',
          prefill_used: prefillUsed,
          prefill_edited: prefillEdited,
          auth_method: authMethod,
        });
        track(ONBOARDING_EVENTS.STEP_COMPLETED, {
          step: 'company',
          step_number: stepNumber,
          auth_method: authMethod,
          resolve_failed_open: resolveFailedOpenRef.current || undefined,
        });
        track(ONBOARDING_EVENTS.COMPLETED, {
          intent: 'client',
          timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        router.push(result.data?.redirectTo ?? '/dashboard');
      });
    },
    [authMethod, resolvedStatus, stepNumber, timezone, router]
  );

  // Escape hatch from the JOIN branch — "This isn't my company / start my own".
  const handleCreateInstead = useCallback((): void => {
    resolveFailedOpenRef.current = false;
    initialSuggestionRef.current = '';
    setJoinCompany(null);
    setResolvedStatus('new');
    form.reset({ companyName: '' });
    setPhase('create');
  }, [form]);

  // JOIN submit (DORMANT in v1 — unreachable until `status: 'matched'` can occur;
  // the membership-join mutation lands with the shared-org seam, BAL-346).
  const handleJoin = useCallback((): void => {
    setActionError(null);
    startTransition(async () => {
      track(ONBOARDING_EVENTS.STEP_COMPLETED, {
        step: 'company',
        step_number: stepNumber,
        auth_method: authMethod,
      });
      track(ONBOARDING_EVENTS.COMPLETED, {
        intent: 'client',
        timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      router.push('/dashboard');
    });
  }, [authMethod, stepNumber, timezone, router]);

  if (phase === 'resolving') {
    return (
      <div className="flex w-full flex-col items-center gap-3 py-10 text-center" aria-live="polite">
        <Loader2 className="text-primary h-7 w-7 animate-spin" aria-hidden="true" />
        <p className="text-muted-foreground text-sm">Setting up your workspace&hellip;</p>
      </div>
    );
  }

  if (phase === 'join' && joinCompany !== null) {
    return (
      <div className="flex w-full flex-col items-center text-center">
        <div
          aria-hidden="true"
          className="bg-primary text-primary-foreground mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl font-semibold"
        >
          {joinCompany.name.charAt(0)}
        </div>
        <h1
          ref={ref}
          tabIndex={-1}
          className="text-foreground text-xl font-semibold outline-none sm:text-2xl"
        >
          Join {joinCompany.name}?
        </h1>
        <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
          Your email domain is managed by{' '}
          <span className="text-foreground font-medium">{joinCompany.name}</span>. You&apos;ll join
          their workspace with {joinCompany.memberCount} teammates already on Balo.
        </p>

        {actionError !== null && (
          <div
            role="alert"
            className="border-destructive/25 bg-destructive/10 text-destructive mt-4 w-full max-w-sm rounded-lg border px-3 py-2.5 text-left text-sm"
          >
            {actionError}
          </div>
        )}

        <div className="mt-7 flex w-full max-w-sm flex-col gap-3">
          <ShimmerButton
            type="button"
            onClick={handleJoin}
            disabled={isPending}
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Joining&hellip;
              </>
            ) : (
              `Join ${joinCompany.name}`
            )}
          </ShimmerButton>
          <Button
            variant="outline"
            size="lg"
            onClick={handleCreateInstead}
            disabled={isPending}
            className="w-full"
          >
            This isn&apos;t my company
          </Button>
        </div>
      </div>
    );
  }

  // CREATE branch (status: new | blocked).
  const helperCopy =
    resolvedStatus === 'blocked'
      ? 'Tell us your company or team name.'
      : 'We suggested this from your email — edit if it’s not right.';

  return (
    <div className="flex w-full flex-col items-center text-center">
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-foreground text-xl font-semibold outline-none sm:text-2xl"
      >
        Name your workspace
      </h1>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
        This is how your company appears to consultants on Balo. You can change it anytime in
        settings.
      </p>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onCreateSubmit)}
          className="mt-8 w-full max-w-sm space-y-4 text-left"
        >
          <FormField
            control={form.control}
            name="companyName"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormControl>
                  <InputFloating
                    label="Company name"
                    autoComplete="organization"
                    autoFocus
                    aria-required="true"
                    disabled={isPending}
                    {...field}
                  />
                </FormControl>
                {fieldState.error ? (
                  <FormMessage />
                ) : (
                  <FormDescription>{helperCopy}</FormDescription>
                )}
              </FormItem>
            )}
          />

          {actionError !== null && (
            <div
              role="alert"
              className="border-destructive/25 bg-destructive/10 text-destructive rounded-lg border px-3 py-2.5 text-sm"
            >
              {actionError}
            </div>
          )}

          <ShimmerButton
            type="submit"
            disabled={isPending}
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving&hellip;
              </>
            ) : (
              'Continue'
            )}
          </ShimmerButton>
        </form>
      </Form>

      <Button variant="ghost" size="sm" onClick={onBack} disabled={isPending} className="mt-4">
        <ArrowLeft className="mr-2 h-4 w-4" />
        Back
      </Button>
    </div>
  );
});
