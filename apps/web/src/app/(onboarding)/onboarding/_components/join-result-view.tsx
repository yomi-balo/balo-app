'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { completeOnboardingAction } from '@/lib/auth/actions';
import { DomainJoinPending } from './domain-join-pending';

type JoinPhase = 'approved' | 'declined';

interface JoinResultViewProps {
  status: JoinPhase;
  companyName: string;
  /** Whether the requester already completed onboarding (e.g. explored while waiting). */
  alreadyOnboarded: boolean;
}

const DASHBOARD = '/dashboard';

/**
 * BAL-348 — thin `'use client'` wrapper around the already-built `DomainJoinPending`
 * terminal phases, driven by `initialPhase`. Renders the approved / declined screen for
 * a request-mode requester who followed a notification deep-link. Onboarding completion
 * + navigation live here; the server page already re-validated the relationship (so no
 * DB read — and no `@balo/db` value-import — crosses into this client bundle).
 *
 * NOTE (activation item #3, deferred to a follow-up ticket): the approved "Continue"
 * completes onboarding and routes to /dashboard but does NOT switch the session's active
 * company to the joined org. That active-company switch is intentionally out of scope
 * here — it matches `joinMatchedCompanyAction`, which also only creates the membership.
 */
export function JoinResultView({
  status,
  companyName,
  alreadyOnboarded,
}: Readonly<JoinResultViewProps>): React.JSX.Element {
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);
  const [isBusy, startTransition] = useTransition();

  // Both terminal CTAs (approved "Continue", declined "Create my own company") finish
  // onboarding — only if the requester never completed it (request mode leaves it
  // incomplete) — then navigate to /dashboard. Fails CLOSED: a completion failure shows
  // an inline banner and keeps the user on the screen. `onExplore` is a pending-only
  // prop that this route never renders, so it safely shares the same handler.
  const finishAndGoToDashboard = useCallback((): void => {
    setActionError(null);
    startTransition(async () => {
      if (!alreadyOnboarded) {
        const result = await completeOnboardingAction('client');
        if (!result.success) {
          setActionError(result.error);
          return;
        }
      }
      router.push(DASHBOARD);
    });
  }, [alreadyOnboarded, router]);

  return (
    <DomainJoinPending
      initialPhase={status}
      companyName={companyName}
      isBusy={isBusy}
      actionError={actionError}
      onExplore={finishAndGoToDashboard}
      onContinueToCompany={finishAndGoToDashboard}
      onCreateInstead={finishAndGoToDashboard}
    />
  );
}
