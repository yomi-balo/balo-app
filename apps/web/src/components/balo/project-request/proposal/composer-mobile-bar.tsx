'use client';

import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { pluralise, previewCtaLabel, railTotal } from './proposal-summary-card';
import { MOBILE_DRAFTING } from './proposal-draft-indicators';
import type { ProposalDraftState, ReadinessResult } from './proposal-composer-state';

interface ComposerMobileBarProps {
  state: ProposalDraftState;
  totalCents: number;
  readiness: ReadinessResult;
  /** Revise mode relabels the CTA to "Preview and resend". */
  reviseMode: boolean;
  /** An AI draft is being written: "Drafting…" replaces the issue/ready line. */
  drafting?: boolean;
  /** Jump to the first outstanding readiness issue. */
  onJumpFirst: () => void;
  onPreview: () => void;
}

/**
 * The below-`lg` bottom bar (BAL-610): the expert's own total, a one-tap route to the
 * first outstanding issue, and the same never-disabled "Preview and send" CTA as the
 * rail. It replaces the old bottom-sheet; the rail itself is hidden at this width.
 */
export function ComposerMobileBar({
  state,
  totalCents,
  readiness,
  reviseMode,
  drafting = false,
  onJumpFirst,
  onPreview,
}: Readonly<ComposerMobileBarProps>): React.JSX.Element {
  const total = railTotal(state, totalCents);
  const issueCount = readiness.issues.length;

  return (
    <div
      className={cn(
        'border-border bg-background/95 fixed inset-x-0 z-40 border-t px-4 py-3 backdrop-blur lg:hidden',
        // Rides above the dashboard MobileTabBar (min-h-14 cells + padding + safe area).
        'bottom-[calc(4.5rem+env(safe-area-inset-bottom))]'
      )}
    >
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground text-[17px] font-semibold tabular-nums">
            {total.amount}
            {total.unit}
          </p>
          {drafting && <p className="text-violet text-[12.5px]">{MOBILE_DRAFTING}</p>}
          {!drafting && issueCount > 0 && (
            <button
              type="button"
              onClick={onJumpFirst}
              className="text-warning-strong focus-visible:ring-ring -ml-2 min-h-11 rounded px-2 text-[12.5px] focus-visible:ring-2 focus-visible:outline-none"
            >
              {issueCount} {pluralise(issueCount, 'thing', 'things')} left
            </button>
          )}
          {!drafting && issueCount === 0 && (
            <p className="text-success-strong text-[12.5px]">Ready to send</p>
          )}
        </div>
        <button
          type="button"
          onClick={onPreview}
          className={cn(
            'focus-visible:ring-ring inline-flex h-11 shrink-0 items-center justify-center rounded-[10px] px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
            PROPOSAL_CTA_GRADIENT_CLASS
          )}
        >
          {previewCtaLabel(reviseMode)}
        </button>
      </div>
    </div>
  );
}
