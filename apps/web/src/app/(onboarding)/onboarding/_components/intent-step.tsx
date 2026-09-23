'use client';

import { useState, useTransition, forwardRef, useEffect, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { ArrowLeft, ArrowRight, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { completeOnboardingAction } from '@/lib/auth/actions/complete-onboarding';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import {
  FindExpertIllustration,
  BecomeExpertIllustration,
  FindExpertIcon,
  BecomeExpertIcon,
} from './illustrations';

interface IntentStepProps {
  onBack: () => void;
  timezone?: string | null;
  stepNumber?: number;
  // BAL-350: the CLIENT branch ADVANCES to the company step (client terminal)
  // instead of completing here. The EXPERT branch still completes at Intent.
  onClientContinue: () => void;
  /** HIGH 3 (BAL-502 FIX round) — non-null only for a signup that started at the
   * anonymous /expert/apply wizard. Overrides the computed terminal redirect so
   * that population always lands back there, regardless of which intent they
   * pick here — losing the filled application because they clicked "Find an
   * Expert" first is a worse outcome than a redirect override. */
  pendingApplyReturnTo?: string | null;
}

type Intent = 'client' | 'expert';

interface Choice {
  intent: Intent;
  eyebrow: string;
  title: string;
  description: string;
  cta: string;
  Illustration: (props: { className?: string }) => React.JSX.Element;
  Icon: (props: { className?: string }) => React.JSX.Element;
}

const CHOICES: readonly Choice[] = [
  {
    intent: 'client',
    eyebrow: 'For businesses',
    title: 'Find an Expert',
    description: 'Get matched with top Salesforce consultants for your business.',
    cta: 'Get started',
    Illustration: FindExpertIllustration,
    Icon: FindExpertIcon,
  },
  {
    intent: 'expert',
    eyebrow: 'For consultants',
    title: 'Become an Expert',
    description: 'Apply to join our consultant network and grow your practice.',
    cta: 'Apply now',
    Illustration: BecomeExpertIllustration,
    Icon: BecomeExpertIcon,
  },
];

/**
 * Per-intent colour — Balo Blue for the client path, violet for the expert path.
 * `--tint` is the OPAQUE panel colour (a token mixed into the card), so the artwork's badge
 * rings can stroke with it and read as cut-outs against the panel.
 */
const TONE: Record<Intent, { tint: string; hover: string; eyebrow: string; cta: string }> = {
  client: {
    tint: '[--tint:color-mix(in_oklch,var(--primary)_7%,var(--card))] dark:[--tint:color-mix(in_oklch,var(--primary)_14%,var(--card))]',
    hover:
      'hover:border-primary/30 hover:shadow-[0_1px_2px_rgb(15_23_42/0.04),0_18px_40px_-12px_color-mix(in_oklch,var(--primary)_22%,transparent)]',
    eyebrow: 'text-primary',
    cta: 'text-primary md:bg-primary md:text-primary-foreground md:hover:bg-[color-mix(in_oklch,var(--primary)_94%,black)]',
  },
  expert: {
    tint: '[--tint:color-mix(in_oklch,var(--violet)_8%,var(--card))] dark:[--tint:color-mix(in_oklch,var(--violet)_16%,var(--card))]',
    hover:
      'hover:border-violet/30 hover:shadow-[0_1px_2px_rgb(15_23_42/0.04),0_18px_40px_-12px_color-mix(in_oklch,var(--violet)_22%,transparent)]',
    eyebrow: 'text-violet-deep dark:text-violet-400',
    cta: 'text-violet-deep dark:text-violet-400 md:border md:border-violet/25 md:bg-card md:hover:border-violet/40 md:hover:bg-violet/5',
  },
};

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

interface IntentChoiceProps {
  choice: Choice;
  /** This choice was picked and is completing. */
  pending: boolean;
  disabled: boolean;
  onSelect: () => void;
}

/**
 * One intent card: a horizontal row (icon tile, copy, chevron) on mobile; a tall card
 * (illustration panel, copy, full-width CTA) on desktop. The CTA is the card's only
 * interactive element — its `::after` stretches over the whole card, so the entire card
 * is the click target without nesting a button inside a button.
 *
 * The overlay resolves against the card only while the button itself is NOT a containing
 * block: no `filter`, `transform`/`translate`, `will-change` or `contain` on the button in
 * any state, or the overlay collapses onto the button and most of the card stops taking
 * clicks. Hover feedback on the button is therefore colour-only.
 */
function IntentChoice({
  choice,
  pending,
  disabled,
  onSelect,
}: Readonly<IntentChoiceProps>): React.JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const ctaId = `${id}-cta`;
  const tone = TONE[choice.intent];
  const { Illustration, Icon } = choice;

  return (
    <motion.div variants={item} className="flex">
      <div
        className={cn(
          'bg-card relative flex w-full items-center gap-4 rounded-[20px] border p-4',
          'shadow-[0_1px_2px_rgb(15_23_42/0.04),0_8px_24px_-14px_rgb(15_23_42/0.12)]',
          'transition-[translate,box-shadow,border-color,opacity] duration-200 ease-out',
          'md:flex-col md:items-stretch md:gap-6 md:rounded-[22px] md:p-3',
          'md:shadow-[0_1px_2px_rgb(15_23_42/0.04),0_8px_24px_-12px_rgb(15_23_42/0.10)]',
          // Mobile has no visible button chrome to ring, so the focus ring moves to the card.
          'max-md:has-[button:focus-visible]:ring-ring/50 max-md:has-[button:focus-visible]:ring-[3px]',
          tone.tint,
          !disabled && cn('motion-safe:hover:-translate-y-[3px]', tone.hover),
          disabled && !pending && 'opacity-50'
        )}
      >
        <div
          aria-hidden="true"
          className="flex size-18 shrink-0 items-center justify-center rounded-2xl bg-(--tint) md:hidden"
        >
          <Icon />
        </div>
        <div
          aria-hidden="true"
          className="hidden h-50 items-center justify-center overflow-hidden rounded-[14px] bg-(--tint) md:flex"
        >
          <Illustration />
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-4 md:flex-col md:items-stretch md:gap-6 md:px-4 md:pb-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1 md:gap-2">
            <p
              className={cn('text-xs font-semibold tracking-[0.02em] md:text-[13px]', tone.eyebrow)}
            >
              {choice.eyebrow}
            </p>
            <h2
              id={titleId}
              className="text-foreground text-lg leading-[1.3] font-semibold tracking-[-0.02em] md:text-[22px] md:leading-[1.25]"
            >
              {choice.title}
            </h2>
            <p
              id={descriptionId}
              className="text-muted-foreground text-sm leading-[1.45] md:text-[15px] md:leading-[1.55]"
            >
              {choice.description}
            </p>
          </div>

          <button
            type="button"
            onClick={onSelect}
            disabled={disabled}
            aria-busy={pending || undefined}
            aria-labelledby={`${titleId} ${ctaId}`}
            aria-describedby={descriptionId}
            className={cn(
              'flex shrink-0 cursor-pointer items-center justify-center gap-2 outline-none disabled:cursor-default',
              'after:absolute after:inset-0 after:rounded-[20px] md:after:rounded-[22px]',
              'md:h-12 md:w-full md:rounded-[12px] md:text-[15px] md:font-semibold',
              'md:transition-[background-color,border-color] md:duration-150',
              'md:focus-visible:ring-ring/50 md:focus-visible:ring-[3px]',
              tone.cta
            )}
          >
            <span id={ctaId} className="sr-only md:not-sr-only">
              {pending ? 'Setting up...' : choice.cta}
            </span>
            {pending ? (
              <Loader2 aria-hidden="true" className="size-5 animate-spin md:size-4" />
            ) : (
              <>
                <ChevronRight aria-hidden="true" strokeWidth={2.2} className="size-5 md:hidden" />
                <ArrowRight
                  aria-hidden="true"
                  strokeWidth={2.2}
                  className="hidden size-4 md:block"
                />
              </>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export const IntentStep = forwardRef<HTMLHeadingElement, IntentStepProps>(function IntentStep(
  { onBack, timezone, stepNumber = 3, onClientContinue, pendingApplyReturnTo = null },
  ref
) {
  const router = useRouter();
  const [selectedIntent, setSelectedIntent] = useState<Intent | null>(null);
  const [isPending, startTransition] = useTransition();
  // Synchronous re-entry latch: the client branch advances (and unmounts) without
  // ever entering `startTransition`, so `isPending` stays false and `selectedIntent`
  // only guards re-entry AFTER the next render. A ref updates immediately, closing
  // the same-tick double-fire window (double-click / Enter+click) so STEP_COMPLETED
  // and `onClientContinue` can't fire twice.
  const submittingRef = useRef(false);

  useEffect(() => {
    track(ONBOARDING_EVENTS.STEP_VIEWED, { step: 'intent', step_number: stepNumber });
  }, [stepNumber]);

  function handleSelect(intent: Intent): void {
    if (submittingRef.current || isPending || selectedIntent !== null) return;
    submittingRef.current = true;

    setSelectedIntent(intent);

    if (intent === 'client') {
      // Client branch ADVANCES to the company step (the client terminal). Do NOT
      // complete onboarding or fire COMPLETED here — the company step owns both.
      track(ONBOARDING_EVENTS.STEP_COMPLETED, {
        step: 'intent',
        step_number: stepNumber,
        value: 'client',
      });
      onClientContinue();
      return;
    }

    // Expert branch — the expert TERMINAL (unchanged): complete + redirect.
    startTransition(async () => {
      const result = await completeOnboardingAction('expert');
      if (result.success) {
        track(ONBOARDING_EVENTS.STEP_COMPLETED, {
          step: 'intent',
          step_number: stepNumber,
          value: 'expert',
        });
        track(ONBOARDING_EVENTS.COMPLETED, {
          intent: 'expert',
          timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        // HIGH 3 — `pendingApplyReturnTo` wins when present; otherwise unchanged
        // (the expert intent's computed `redirectTo` is already `/expert/apply`
        // today, so this is a no-op for that branch and only matters as a
        // defensive floor / for future redirectTo changes).
        router.push(pendingApplyReturnTo ?? result.data?.redirectTo ?? '/dashboard');
      } else {
        // Allow a retry after a failed expert completion.
        submittingRef.current = false;
        toast.error(result.error);
        setSelectedIntent(null);
      }
    });
  }

  const isDisabled = isPending || selectedIntent !== null;

  return (
    <div className="flex w-full flex-1 flex-col gap-7 md:flex-none md:items-center md:gap-10">
      <div className="flex flex-col gap-2.5 md:items-center md:gap-3 md:text-center">
        <h1
          ref={ref}
          tabIndex={-1}
          className="text-foreground text-3xl leading-[1.15] font-semibold tracking-[-0.03em] outline-none md:text-[40px] md:leading-[1.1]"
        >
          What brings you to Balo?
        </h1>
        <p className="text-muted-foreground text-base leading-normal md:text-[17px]">
          Choose how you&apos;d like to get started. You can always switch later.
        </p>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-3.5 md:grid md:w-full md:grid-cols-2 md:gap-6"
      >
        {CHOICES.map((choice) => (
          <IntentChoice
            key={choice.intent}
            choice={choice}
            pending={selectedIntent === choice.intent}
            disabled={isDisabled}
            onSelect={() => handleSelect(choice.intent)}
          />
        ))}
      </motion.div>

      {/* Mobile pins Back to the bottom of the screen; desktop keeps it under the cards. */}
      <div aria-hidden="true" className="flex-1 md:hidden" />

      <Button
        variant="ghost"
        onClick={onBack}
        disabled={isDisabled}
        className="text-foreground/80 hover:text-foreground h-11 self-center rounded-[10px] text-[15px] has-[>svg]:px-4"
      >
        <ArrowLeft />
        Back
      </Button>
    </div>
  );
});
