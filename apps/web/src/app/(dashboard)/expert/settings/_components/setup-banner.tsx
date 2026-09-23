import Link from 'next/link';
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CHECKLIST_ITEMS,
  expertSettingsHrefFor,
  expertSettingsTabFor,
  type ChecklistItemKey,
} from '@/lib/constants/expert-checklist';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';

interface SetupBannerProps {
  readonly status: ChecklistStatus;
  /** The settings tab on screen (the page's resolved `?tab=`). */
  readonly activeTab: string;
  /** The page's validated `?setup=` — the checklist step the expert followed a link to do. */
  readonly setupStep: string | null;
}

interface SetupStep {
  readonly key: ChecklistItemKey;
  readonly label: string;
  /** 1-based position in `CHECKLIST_ITEMS`. */
  readonly position: number;
  /** The other incomplete items, so "N more after that" never counts `key` itself. */
  readonly remainingAfter: number;
  /** True when this is the `?setup=` step the expert arrived to do, not simply the next one. */
  readonly chosen: boolean;
}

/**
 * The step the banner names: the `?setup=` step while it is still incomplete, otherwise the
 * first incomplete item in `CHECKLIST_ITEMS` order. Counted from `items` against the real
 * checklist — never a hard-coded total — so a step being worked on is only ever reported as
 * done once `items[key]` says so.
 */
function findSetupStep(
  items: ChecklistStatus['items'],
  setupStep: string | null
): SetupStep | null {
  const open = CHECKLIST_ITEMS.filter((item) => !items[item.key]);
  const chosen = open.find((item) => item.key === setupStep);
  const [first] = open;
  const step = chosen ?? first;
  if (step === undefined) return null;
  return {
    key: step.key,
    label: step.label,
    position: CHECKLIST_ITEMS.findIndex((item) => item.key === step.key) + 1,
    remainingAfter: open.length - 1,
    chosen: chosen !== undefined,
  };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * BAL-414 (D11) — the expert-settings listing-status surface, derived from the ALREADY-FETCHED
 * `ChecklistStatus` (no second query, no shape change).
 *
 * Not listed: an amber banner naming a step (invitation-framed — what to do, never what is
 * missing) with a "Continue setup" link to that step's tab. The link is hidden while that tab
 * is already on screen, so it is never a no-op. Arriving from the dashboard checklist
 * (`?setup=`) names THAT step with its "step N of M" position while it is still open, and adds
 * a way back to the dashboard. Listed: a quiet one-line confirmation.
 */
export function SetupBanner({
  status,
  activeTab,
  setupStep,
}: Readonly<SetupBannerProps>): React.JSX.Element | null {
  if (status.allComplete) {
    return (
      <p className="text-success-strong flex items-center gap-1.5 text-sm font-medium">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        You&apos;re appearing in search.
      </p>
    );
  }

  // `allComplete` false with every item true is an inconsistent snapshot: say nothing rather
  // than name a step that is already done or claim a listing that is not live.
  const step = findSetupStep(status.items, setupStep);
  if (!step) return null;

  const showContinue = expertSettingsTabFor(step.key) !== activeTab;
  const showDashboard = setupStep !== null;
  const stepNoun = step.remainingAfter === 1 ? 'step' : 'steps';

  return (
    <div className="border-warning/40 bg-warning/10 flex flex-col gap-3 rounded-[10px] border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="text-warning-strong mt-px h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="text-warning-strong text-[13px] leading-[18px]">
          Not visible to clients yet —{' '}
          {step.chosen ? `step ${step.position} of ${CHECKLIST_ITEMS.length}, ` : 'next, '}
          <strong className="font-semibold">{lowerFirst(step.label)}</strong>
          {step.remainingAfter > 0 && (
            <span>
              {' '}
              ({step.remainingAfter} more {stepNoun} after {step.chosen ? 'this' : 'that'})
            </span>
          )}
        </p>
      </div>
      {(showDashboard || showContinue) && (
        <div className="ml-[26px] flex items-center gap-1 self-start sm:ml-0 sm:self-auto">
          {showDashboard && (
            <Link
              href="/dashboard"
              className="text-warning-strong focus-visible:ring-ring/50 inline-flex h-11 items-center gap-1 rounded-lg px-2 text-[13px] font-medium outline-none hover:underline focus-visible:ring-[3px] sm:h-8"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Dashboard
            </Link>
          )}
          {showContinue && (
            <Button
              asChild
              size="sm"
              className="bg-warning-strong hover:bg-warning-strong/90 dark:text-warning-foreground h-11 rounded-lg px-3.5 text-[13px] text-white has-[>svg]:px-3.5 sm:h-8"
            >
              <Link href={expertSettingsHrefFor(step.key)}>
                Continue setup
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
