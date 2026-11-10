'use client';

import { useEffect, useCallback, useMemo, useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { ClipboardCheck, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { ExpertTermsDocument } from '@/components/balo/legal/expert-terms-document';
import { summaryFromDraft, type SummaryEditTarget } from '@/lib/expert/application-summary';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { termsStepSchema, type TermsStepData, STEP_CONFIG } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { StepHeading } from './design-system';
import { ApplicationSummarySections } from './application-summary-sections';

interface StepTermsProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepTerms({ headingRef }: Readonly<StepTermsProps>): React.JSX.Element {
  const router = useRouter();
  const authModal = useAuthModal();
  const {
    termsData,
    productsData,
    certificationsData,
    workHistoryData,
    profileData,
    assessmentData,
    referenceData,
    updateStepData,
    registerValidation,
    submitApplication,
    goToStep,
    submitState,
    setSubmitState,
    registerSubmit,
    isAnonymous,
    saveAnonymousDraftNow,
  } = useWizard();

  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);

  const form = useForm<TermsStepData>({
    resolver: zodResolver(termsStepSchema),
    defaultValues: {
      termsAccepted: termsData.termsAccepted ?? false,
    },
    mode: 'onSubmit',
  });

  // Scroll/focus target for the unchecked-box path. The ref lives on a wrapping
  // <div> because FormItem/FormControl are plain function components (not
  // forwardRef); the checkbox is then located by role.
  const termsFieldRef = useRef<HTMLDivElement>(null);

  // Synchronous double-submit latch. The reactive `submitState` guard reads a
  // render snapshot, so two synchronous submit() dispatches before the first
  // click's 'submitting' state commits would both pass and fire duplicate server
  // mutations. This ref flips synchronously (before any await), closing that window.
  const isSubmittingRef = useRef(false);

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('terms', values);
    });
    return () => subscription.unsubscribe();
  }, [form, updateStepData]);

  // Register validation
  const validate = useCallback(async (): Promise<boolean> => {
    return form.trigger();
  }, [form]);

  useEffect(() => {
    registerValidation(validate);
  }, [registerValidation, validate]);

  const scrollViewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const handleScroll = (): void => {
      const isNearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 20;
      if (isNearBottom) {
        setHasScrolledToBottom(true);
      }
    };
    viewport.addEventListener('scroll', handleScroll);
    // Check initial state (content shorter than container)
    handleScroll();
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // BAL-502 §22.4 — anonymous submit gate. The wizard is fully filled and valid;
  // rather than a hard redirect (which would destroy it), write the envelope
  // SYNCHRONOUSLY and open the unified auth modal in place. No submit call — the
  // wizard resumes after auth via the context's post-auth flush (§22.9).
  //
  // Extracted to its own callback (FIX round) — inlining it in `handleSubmit`
  // pushed that function's cognitive complexity past SonarCloud's gate (16 > 15)
  // once WARNING 7's failure branch was added.
  const handleAnonymousSubmitGate = useCallback((): void => {
    // WARNING 7 (FIX round) — `saveAnonymousDraftNow` can fail (Safari private
    // mode, storage quota near the ~5MB origin cap) and its result was
    // previously discarded: the visitor would fill the whole wizard,
    // authenticate, and arrive at an EMPTY resume with no explanation. Surface
    // the failure HERE, before they commit to creating an account, and refuse
    // to open the auth modal — signing in now would silently lose everything.
    const persisted = saveAnonymousDraftNow();
    isSubmittingRef.current = false;
    if (!persisted) {
      toast.error(
        "We couldn't save your progress in this browser (private browsing, or storage is full). " +
          "Signing in now would lose what you've filled in — try a normal browser window, or " +
          'free up space, then submit again.'
      );
      return;
    }
    track(EXPERT_EVENTS.APPLICATION_AUTH_GATE_REACHED, {
      last_step: 'terms',
      step_number: STEP_CONFIG.length,
    });
    authModal.open({ onSuccess: () => router.refresh() });
  }, [saveAnonymousDraftNow, authModal, router]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    // Guard double-clicks while submitting/success — the button is intentionally
    // NOT disabled (per BAL-327), so this prevents a duplicate server call. The
    // ref latch is the airtight guard (flips synchronously before the first
    // await); the reactive `submitState` check is defense-in-depth for the
    // post-commit case.
    if (isSubmittingRef.current || submitState !== 'idle') return;
    isSubmittingRef.current = true;

    const isValid = await form.trigger();
    if (!isValid) {
      // Release the latch first — an unchecked click must never permanently lock
      // the button. Then surface the zod message, bring the checkbox into view,
      // and focus it for screen-reader announcement.
      isSubmittingRef.current = false;
      const container = termsFieldRef.current;
      container?.scrollIntoView({ block: 'center' });
      container?.querySelector<HTMLElement>('[role="checkbox"]')?.focus({ preventScroll: true });
      return;
    }

    if (isAnonymous) {
      handleAnonymousSubmitGate();
      return;
    }

    setSubmitState('submitting');
    try {
      const result = await submitApplication();

      if (result.success) {
        setSubmitState('success');

        track(EXPERT_EVENTS.APPLICATION_SUBMITTED, {
          products_count: productsData.productIds?.length ?? 0,
          certs_count: certificationsData.certifications?.length ?? 0,
          work_history_count: workHistoryData.entries?.length ?? 0,
        });

        // Hold success state for 1.2 seconds then redirect. The latch stays set —
        // the component navigates away, so no re-submit is possible.
        setTimeout(() => {
          router.push('/expert/apply/success');
        }, 1200);
      } else {
        // Release the latch so the user can retry after a failed submit.
        isSubmittingRef.current = false;
        setSubmitState('idle');

        if (result.failingStep) {
          toast.error("Some fields need your attention. We've taken you to the first one.");
          const stepIndex = STEP_CONFIG.findIndex((s) => s.key === result.failingStep);
          if (stepIndex !== -1) {
            goToStep(stepIndex);
          }
        } else {
          toast.error(
            result.error ?? 'Something went wrong submitting your application. Please try again.'
          );
        }

        track(EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED, {
          error_message: result.error ?? 'Unknown error',
        });
      }
    } catch (error) {
      // The server action threw (e.g. network failure) instead of returning
      // `{ success: false }`. Release the latch and reset state so the
      // never-disabled button stays retryable rather than locking forever.
      isSubmittingRef.current = false;
      setSubmitState('idle');
      toast.error('Something went wrong submitting your application. Please try again.');
      track(EXPERT_EVENTS.APPLICATION_SUBMIT_FAILED, {
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [
    submitState,
    form,
    submitApplication,
    setSubmitState,
    productsData,
    certificationsData,
    workHistoryData,
    router,
    goToStep,
    isAnonymous,
    handleAnonymousSubmitGate,
  ]);

  // Register the submit handler so the relocated bar button can invoke it
  // (mirrors the registerValidation effect above).
  useEffect(() => {
    registerSubmit(handleSubmit);
  }, [registerSubmit, handleSubmit]);

  const summary = useMemo(
    () =>
      summaryFromDraft(
        {
          profile: profileData,
          products: productsData,
          assessment: assessmentData,
          certifications: certificationsData,
          workHistory: workHistoryData,
        },
        referenceData
      ),
    [profileData, productsData, assessmentData, certificationsData, workHistoryData, referenceData]
  );

  // Each Edit jumps to its step by KEY, so inserting or reordering steps never leaves a link
  // pointing at the wrong step.
  const handleEdit = useCallback(
    (target: SummaryEditTarget): void => {
      const stepIndex = STEP_CONFIG.findIndex((s) => s.key === target);
      if (stepIndex !== -1) goToStep(stepIndex);
    },
    [goToStep]
  );

  return (
    <Form {...form}>
      <form className="mx-auto max-w-2xl space-y-6">
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <StepHeading
            icon={ClipboardCheck}
            title="Review and submit"
            subtitle="Check your application, then accept the expert terms to submit it."
          />
        </div>

        <ApplicationSummarySections summary={summary} onEdit={handleEdit} />

        <section aria-labelledby="expert-terms-heading" className="space-y-4">
          <div className="flex items-center gap-2">
            <Shield className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <h3 id="expert-terms-heading" className="text-foreground text-sm font-semibold">
              Expert terms
            </h3>
          </div>

          {/* T&C container */}
          <div className="border-border relative overflow-hidden rounded-xl border">
            <ScrollArea className="max-h-[50vh] sm:max-h-[400px]">
              <div
                ref={scrollViewportRef}
                tabIndex={0}
                role="region"
                aria-label="Balo Expert Terms & Conditions"
                className="prose prose-sm dark:prose-invert focus-visible:ring-ring max-h-[50vh] max-w-none overflow-y-auto p-6 focus-visible:ring-2 focus-visible:outline-none sm:max-h-[400px]"
              >
                <ExpertTermsDocument />
              </div>
            </ScrollArea>

            {/* Scroll gradient indicator */}
            <AnimatePresence>
              {!hasScrolledToBottom && (
                <motion.div
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="from-card via-card/80 pointer-events-none absolute right-0 bottom-0 left-0 h-12 bg-gradient-to-t to-transparent"
                />
              )}
            </AnimatePresence>
          </div>

          {/* Checkbox agreement */}
          <div ref={termsFieldRef}>
            <FormField
              control={form.control}
              name="termsAccepted"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-3">
                    <FormControl>
                      <Checkbox
                        id="terms-accepted"
                        checked={field.value === true}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <label
                      htmlFor="terms-accepted"
                      className="text-foreground cursor-pointer text-sm leading-snug font-medium"
                    >
                      I have read and agree to the Balo Expert Terms & Conditions
                    </label>
                  </div>
                  <p className="text-muted-foreground mt-2 ml-7 text-xs">
                    By submitting, you agree to these terms in full.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <p className="text-muted-foreground mt-3 text-center text-xs">
          You can continue using Balo as a client while we review your application. We&apos;ll email
          you within 2&ndash;3 business days.
        </p>
      </form>
    </Form>
  );
}
