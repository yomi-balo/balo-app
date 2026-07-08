'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { track, DOMAIN_JOIN_EVENTS } from '@/lib/analytics';

type PendingPhase = 'pending' | 'approved' | 'declined';

interface DomainJoinPendingProps {
  companyName: string;
  isBusy: boolean;
  actionError: string | null;
  /** "Explore Balo while you wait" — parent completes onboarding + navigates. */
  onExplore: () => void;
  /** "Set up my own company instead" / declined "Create my own company". */
  onCreateInstead: () => void;
  /**
   * Default `'pending'`. `approved` / `declined` are BUILT + component-testable
   * here but have NO production entry point in this ticket — their real trigger is
   * a notification deep-link owned by BAL-348.
   */
  initialPhase?: PendingPhase;
  /** approved CTA (deferred deep-link; no-op default). */
  onContinueToCompany?: () => void;
}

const HEADING_CLASS = 'text-foreground text-xl font-semibold outline-none sm:text-2xl';

const BADGE_TONE: Record<PendingPhase, string> = {
  pending: 'bg-primary text-primary-foreground',
  approved: 'bg-success text-success-foreground',
  declined: 'bg-muted text-muted-foreground',
};

/**
 * The three request-mode terminal states surfaced after a client files a join
 * request against a domain-matched company: waiting (`pending`), admin-approved
 * (`approved`), admin-declined (`declined`). Presentational only — the parent
 * (`company-step`) owns the actions, router, and onboarding-completion analytics;
 * this component owns its local sub-phase and the pending-viewed event. Copy names
 * the PARTY (company) and the declined tone is neutral (no admin named, no
 * "rejected"). Standalone onboarding interstitial — no wizard dots.
 *
 * DORMANT in v1: reachable only when the resolve action returns `matched`, which
 * cannot occur until the shared-org creation seam ships.
 */
export function DomainJoinPending({
  companyName,
  isBusy,
  actionError,
  onExplore,
  onCreateInstead,
  initialPhase = 'pending',
  onContinueToCompany,
}: Readonly<DomainJoinPendingProps>): React.JSX.Element {
  // No in-flow transitions in this ticket (the preview links are dropped); the
  // sub-phase is seeded once and only varies by the `initialPhase` prop.
  const [phase] = useState<PendingPhase>(initialPhase);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus the heading once it mounts / the phase settles (wizard convention).
  useEffect(() => {
    const timer = setTimeout(() => headingRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [phase]);

  // join_request_pending_viewed fires only while the user is waiting.
  useEffect(() => {
    if (phase !== 'pending') return;
    track(DOMAIN_JOIN_EVENTS.REQUEST_PENDING_VIEWED, { party_type: 'company' });
  }, [phase]);

  const handleContinue = useCallback((): void => {
    onContinueToCompany?.();
  }, [onContinueToCompany]);

  const firstLetter = companyName.charAt(0);
  const company = <span className="text-foreground font-medium">{companyName}</span>;

  const copy: Record<PendingPhase, { heading: string; subcopy: ReactNode }> = {
    pending: {
      heading: `Request sent to ${companyName}`,
      subcopy: (
        <>
          Your request to join {company} is with their admins. There&apos;s nothing you need to do
          right now.
        </>
      ),
    },
    approved: {
      heading: `You're in — welcome to ${companyName}`,
      subcopy: (
        <>{company}&apos;s admins approved your request. You now share their workspace on Balo.</>
      ),
    },
    declined: {
      heading: 'Set up your own workspace',
      subcopy: (
        <>
          {company}&apos;s admins weren&apos;t able to add you this time. You can create your own
          company on Balo and get started right away.
        </>
      ),
    },
  };

  const { heading, subcopy } = copy[phase];

  return (
    <div className="flex w-full flex-col items-center text-center">
      <div
        aria-hidden="true"
        className={`mb-5 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl font-semibold ${BADGE_TONE[phase]}`}
      >
        {firstLetter}
      </div>
      <h1 ref={headingRef} tabIndex={-1} className={HEADING_CLASS}>
        {heading}
      </h1>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">{subcopy}</p>

      {phase === 'pending' && (
        <>
          <NextSteps companyName={companyName} />
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
              onClick={onExplore}
              disabled={isBusy}
              className="h-11 w-full rounded-lg text-sm font-medium"
              shimmerColor="rgba(255, 255, 255, 0.15)"
              background="var(--primary)"
            >
              {isBusy ? (
                <span className="flex items-center" aria-live="polite">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Working&hellip;
                </span>
              ) : (
                'Explore Balo while you wait'
              )}
            </ShimmerButton>
            <Button
              variant="outline"
              size="lg"
              onClick={onCreateInstead}
              disabled={isBusy}
              className="h-11 w-full"
            >
              Set up my own company instead
            </Button>
          </div>
        </>
      )}

      {phase === 'approved' && (
        <div className="mt-7 flex w-full max-w-sm flex-col gap-3">
          <ShimmerButton
            type="button"
            onClick={handleContinue}
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            Continue to {companyName}
          </ShimmerButton>
        </div>
      )}

      {phase === 'declined' && (
        <div className="mt-7 flex w-full max-w-sm flex-col gap-3">
          <ShimmerButton
            type="button"
            onClick={onCreateInstead}
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            Create my own company
          </ShimmerButton>
        </div>
      )}
    </div>
  );
}

const NEXT_STEPS = (companyName: string): ReadonlyArray<{ key: string; text: ReactNode }> => [
  {
    key: 'notified',
    text: <>{companyName}&apos;s admins have been notified and will review your request.</>,
  },
  {
    key: 'email',
    text: <>We&apos;ll email you the moment they respond &mdash; no need to wait here.</>,
  },
  {
    key: 'outcome',
    text: <>If they approve, you go straight in. If not, you can set up your own company.</>,
  },
];

function NextSteps({ companyName }: Readonly<{ companyName: string }>): React.JSX.Element {
  return (
    <ol className="mx-auto mt-6 flex w-full max-w-sm list-none flex-col gap-3 text-left">
      {NEXT_STEPS(companyName).map((row, index) => (
        <li key={row.key} className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            className="bg-primary/10 text-primary mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-semibold"
          >
            {index + 1}
          </span>
          <span className="text-foreground text-sm leading-snug">{row.text}</span>
        </li>
      ))}
    </ol>
  );
}
