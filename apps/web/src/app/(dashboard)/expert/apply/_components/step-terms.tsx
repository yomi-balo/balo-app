'use client';

import { useEffect, useCallback, useState, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { ChevronDown, Loader2, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { termsStepSchema, type TermsStepData, STEP_CONFIG } from '../_actions/schemas';
import { useWizard } from './expert-application-context';

interface StepTermsProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

type SubmitState = 'idle' | 'submitting' | 'success';

export function StepTerms({ headingRef }: Readonly<StepTermsProps>): React.JSX.Element {
  const router = useRouter();
  const {
    termsData,
    productsData,
    certificationsData,
    workHistoryData,
    profileData,
    inviteData,
    updateStepData,
    registerValidation,
    submitApplication,
    goToStep,
  } = useWizard();

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);

  const form = useForm<TermsStepData>({
    resolver: zodResolver(termsStepSchema),
    defaultValues: {
      termsAccepted: termsData.termsAccepted ?? false,
    },
    mode: 'onSubmit',
  });

  const termsAccepted = form.watch('termsAccepted');

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

  const handleSubmit = async (): Promise<void> => {
    const isValid = await form.trigger();
    if (!isValid) return;

    setSubmitState('submitting');
    const result = await submitApplication();

    if (result.success) {
      setSubmitState('success');

      track(EXPERT_EVENTS.APPLICATION_SUBMITTED, {
        products_count: productsData.skillIds?.length ?? 0,
        certs_count: certificationsData.certifications?.length ?? 0,
        work_history_count: workHistoryData.entries?.length ?? 0,
        referrals_count: inviteData.emails?.length ?? 0,
      });

      // Hold success state for 1.2 seconds then redirect
      setTimeout(() => {
        router.push('/expert/apply/success');
      }, 1200);
    } else {
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
  };

  // Build summary data
  const summaryItems = [
    {
      label: 'Products',
      value:
        (productsData.skillIds?.length ?? 0) > 0
          ? `${productsData.skillIds?.length} selected`
          : 'None',
      stepIndex: 1,
    },
    {
      label: 'Certifications',
      value:
        (certificationsData.certifications?.length ?? 0) > 0
          ? `${certificationsData.certifications?.length} added`
          : 'Skipped',
      stepIndex: 3,
    },
    {
      label: 'Work history',
      value:
        (workHistoryData.entries?.length ?? 0) > 0
          ? `${workHistoryData.entries?.length} positions`
          : 'Skipped',
      stepIndex: 4,
    },
    {
      label: 'Languages',
      value:
        (profileData.languages?.length ?? 0) > 0
          ? `${profileData.languages?.length} languages`
          : 'None',
      stepIndex: 0,
    },
    {
      label: 'Industries',
      value:
        (profileData.industryIds?.length ?? 0) > 0
          ? `${profileData.industryIds?.length} selected`
          : 'None',
      stepIndex: 0,
    },
    {
      label: 'Referrals',
      value:
        (inviteData.emails?.length ?? 0) > 0 ? `${inviteData.emails?.length} invitations` : 'None',
      stepIndex: 5,
    },
  ];

  return (
    <Form {...form}>
      <form className="mx-auto max-w-2xl space-y-6">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-xl font-semibold outline-none"
        >
          Terms & Conditions
        </h2>
        <p className="text-muted-foreground -mt-2 text-sm">
          Please review and accept the Balo expert terms before submitting your application.
        </p>

        {/* T&C container */}
        <div className="border-border relative overflow-hidden rounded-xl border">
          <ScrollArea className="max-h-[50vh] sm:max-h-[400px]">
            <div
              ref={scrollViewportRef}
              className="prose prose-sm dark:prose-invert max-h-[50vh] max-w-none overflow-y-auto p-6 sm:max-h-[400px]"
            >
              <h3 className="text-foreground text-sm font-semibold">
                1. Expert Platform Agreement
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                By registering as an expert on Balo, you agree to provide professional consulting
                services in accordance with the standards outlined in this agreement. You represent
                that all information provided in your application is accurate and complete.
              </p>

              <h3 className="text-foreground text-sm font-semibold">2. Service Standards</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                As a Balo expert, you commit to maintaining high professional standards in all
                client interactions. This includes responding to client inquiries within a
                reasonable timeframe, delivering work that meets the agreed-upon scope, and
                maintaining confidentiality of client information.
              </p>

              <h3 className="text-foreground text-sm font-semibold">3. Payment Terms</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Balo operates on a prepaid credit system with a 25% platform fee. Your earnings will
                be calculated based on your set hourly rate minus the platform fee. Payments are
                processed through Stripe Connect and deposited to your linked bank account on a
                regular schedule.
              </p>

              <h3 className="text-foreground text-sm font-semibold">4. Intellectual Property</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Work product created during engagements belongs to the client unless otherwise
                agreed upon in the project scope. You retain ownership of your pre-existing tools,
                templates, and methodologies.
              </p>

              <h3 className="text-foreground text-sm font-semibold">5. Community Standards</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                You agree to treat all clients, fellow experts, and Balo staff with respect and
                professionalism. Harassment, discrimination, or any form of misconduct may result in
                immediate removal from the platform.
              </p>

              <h3 className="text-foreground text-sm font-semibold">
                6. Account Suspension & Termination
              </h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Balo reserves the right to suspend or terminate your expert account for violations
                of these terms, consistently poor service quality, or fraudulent activity. You may
                voluntarily deactivate your expert profile at any time.
              </p>

              <h3 className="text-foreground text-sm font-semibold">7. Amendments</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                These terms may be updated from time to time. Material changes will be communicated
                via email with reasonable notice. Continued use of the platform after changes take
                effect constitutes acceptance of the updated terms.
              </p>
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
                By submitting, you agree to our platform guidelines, community standards, and
                payment terms.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Application summary */}
        <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="border-border flex w-full items-center justify-between border-t py-3"
            >
              <span className="text-foreground text-sm font-semibold">Review your application</span>
              <ChevronDown
                className={cn(
                  'text-muted-foreground h-4 w-4 transition-transform duration-200',
                  summaryOpen && 'rotate-180'
                )}
                aria-hidden="true"
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 pt-3">
              {summaryItems.map((item) => (
                <div key={item.label} className="flex items-center justify-between">
                  <div>
                    <span className="text-muted-foreground text-sm">{item.label}</span>
                    <span className="text-foreground ml-2 text-sm font-medium">{item.value}</span>
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="text-xs"
                    onClick={() => goToStep(item.stepIndex)}
                  >
                    Edit
                  </Button>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Submit button */}
        <div className="mt-6">
          <Button
            type="button"
            size="lg"
            className={cn(
              'w-full transition-all duration-300 sm:w-auto',
              submitState === 'success' && 'bg-success hover:bg-success text-success-foreground',
              !termsAccepted && 'cursor-not-allowed opacity-50',
              termsAccepted && submitState === 'idle' && 'hover:shadow-primary/20 hover:shadow-lg'
            )}
            disabled={!termsAccepted || submitState !== 'idle'}
            onClick={() => void handleSubmit()}
          >
            <AnimatePresence mode="wait">
              {submitState === 'idle' && (
                <motion.span
                  key="idle"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  Submit Application
                </motion.span>
              )}
              {submitState === 'submitting' && (
                <motion.span
                  key="submitting"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="inline-flex items-center gap-2"
                >
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Submitting your application...
                </motion.span>
              )}
              {submitState === 'success' && (
                <motion.span
                  key="success"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="inline-flex items-center gap-2"
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Submitted!
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
        </div>

        <p className="text-muted-foreground mt-3 text-center text-xs">
          You can continue using Balo as a client while we review your application. We&apos;ll email
          you within 2&ndash;3 business days.
        </p>
      </form>
    </Form>
  );
}
