'use client';

import { motion, useReducedMotion } from 'motion/react';
import { AlertCircle } from 'lucide-react';
import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';
import { cn } from '@/lib/utils';

interface CopyEntry {
  readonly headline: string;
  readonly clause: string;
}

/** Copy map (gender-neutral, never blames the client's files). */
const COPY_BY_REASON: Record<ProjectBriefFailureReason, CopyEntry> = {
  unreadable: {
    headline: "We couldn't draft a brief from these files.",
    clause: "The documents didn't have enough readable text.",
  },
  empty_extraction: {
    headline: "We couldn't draft a brief from these files.",
    clause: "The documents didn't have enough readable text.",
  },
  too_large: {
    headline: 'These files are a bit much to read in one go.',
    clause: 'Try again with fewer or smaller documents.',
  },
  truncated: {
    headline: 'Something went wrong generating your brief.',
    clause: 'Your files are still attached.',
  },
  invalid_output: {
    headline: 'Something went wrong generating your brief.',
    clause: 'Your files are still attached.',
  },
  model_unavailable: {
    headline: 'Something went wrong generating your brief.',
    clause: 'Your files are still attached.',
  },
  unknown: {
    headline: 'Something went wrong generating your brief.',
    clause: 'Your files are still attached.',
  },
  not_found: {
    headline: 'Something went wrong generating your brief.',
    clause: 'Your files are still attached.',
  },
  enqueue_failed: {
    headline: 'Something went wrong generating your brief.',
    clause: 'Your files are still attached.',
  },
  timed_out: {
    headline: 'This is taking longer than expected.',
    clause: 'Your files are still attached — try again, or write it yourself.',
  },
  // BAL-589 — case-source failures. Never surfaced through `COPY_BY_REASON` on the `case`
  // variant below (which has ONE copy for every reason), but every member of
  // `ProjectBriefFailureReason` still needs an entry here so this map stays total — the
  // `review`/`upload` variants on a DOCUMENTS mount fall back to this table too.
  case_unavailable: {
    headline: "We couldn't draft a brief from this case.",
    clause: 'Write your brief yourself below.',
  },
  no_case_history: {
    headline: 'This case has no messages or call notes to draft from yet.',
    clause: 'Write your brief yourself below.',
  },
};

export interface GenerationErrorBannerProps {
  reason: ProjectBriefFailureReason;
  /** BAL-589 — `'case'` is the case-conversion manual step's failure state: one copy for every
   *  reason but `no_case_history` (the client never sees which internal check failed), Try
   *  again + Dismiss. `no_case_history` gets its own copy and drops Try again (fix round 4,
   *  X4a) — there is nothing to retry until the case itself has more history. */
  variant: 'upload' | 'review' | 'case';
  /**
   * BAL-589 fix round 4 (X4c) — the case variant's start-action error (the hourly rate limit,
   * the wrong-workspace check), shown in place of {@link CASE_VARIANT_COPY} when present. Only
   * read on `variant === 'case'`; ignored otherwise.
   */
  startError?: string | null;
  onRetry?: () => void;
  onWriteItMyself?: () => void;
  onDismiss?: () => void;
}

/** The ONE copy for a case-source failure with no more specific message to show, regardless
 *  of reason. */
const CASE_VARIANT_COPY: CopyEntry = {
  headline: "We couldn't draft a brief from this case — write it yourself below.",
  clause: '',
};

/** X4a — a case with no message/call history to draft from: no retry makes this succeed, so
 *  the banner offers none. */
const CASE_NO_HISTORY_COPY: CopyEntry = {
  headline:
    "This case doesn't have any messages or call notes to draft from yet — write the brief yourself below.",
  clause: '',
};

/** The review variant's copy — a regenerate attempt failed, the prior draft is untouched. */
const REVIEW_VARIANT_COPY: CopyEntry = {
  headline: "Couldn't regenerate — your previous draft is unchanged.",
  clause: '',
};

/** The banner's headline/clause for a given variant — an if/else chain, not a nested ternary
 *  (SonarCloud S3358), since `case` and `review` each need their own fixed copy, and only
 *  `upload`/the default case look up `reason` in {@link COPY_BY_REASON}. */
function copyFor(
  variant: GenerationErrorBannerProps['variant'],
  reason: ProjectBriefFailureReason,
  startError: string | null | undefined
): CopyEntry {
  if (variant === 'case') {
    if (reason === 'no_case_history') return CASE_NO_HISTORY_COPY;
    if (startError !== null && startError !== undefined && startError.length > 0) {
      return { headline: startError, clause: '' };
    }
    return CASE_VARIANT_COPY;
  }
  if (variant === 'review') return REVIEW_VARIANT_COPY;
  return COPY_BY_REASON[reason];
}

interface ErrorBannerActionsProps {
  variant: GenerationErrorBannerProps['variant'];
  reason: ProjectBriefFailureReason;
  onRetry?: () => void;
  onWriteItMyself?: () => void;
  onDismiss?: () => void;
}

/** The banner's action row — extracted so `GenerationErrorBanner` itself needs no nested
 *  ternary to pick between three variants' very different button sets. */
function ErrorBannerActions({
  variant,
  reason,
  onRetry,
  onWriteItMyself,
  onDismiss,
}: Readonly<ErrorBannerActionsProps>): React.JSX.Element {
  if (variant === 'upload') {
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onRetry}
          className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center rounded-[11px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none sm:w-auto"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onWriteItMyself}
          className={cn(
            'from-primary inline-flex min-h-11 w-full items-center justify-center rounded-[11px] bg-gradient-to-r to-violet-600 px-4 text-sm font-semibold text-white shadow-sm transition-all focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:outline-none sm:w-auto dark:to-violet-500'
          )}
        >
          Write it myself instead
        </button>
      </div>
    );
  }

  // X4a — no_case_history has nothing a retry can fix: Dismiss only, same as `review`.
  if (variant === 'case' && reason !== 'no_case_history') {
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onRetry}
          className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center rounded-[11px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none sm:w-auto"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center justify-center rounded-[11px] px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none sm:w-auto"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onDismiss}
        className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center justify-center rounded-[11px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * BAL-254 — the inline failure banner shown in place of the spinner on `upload`, in place of
 * the AI banner's position on `review` (never both at once), and (BAL-589) above an empty
 * editor on a case mount's `manual` step. Mount animation reuses the EXISTING shake vocabulary
 * from `document-uploader.tsx` (`x: [0, -4, 4, 0]` on a failed row) — zero new animation
 * vocabulary introduced for this surface.
 */
export function GenerationErrorBanner({
  reason,
  variant,
  startError,
  onRetry,
  onWriteItMyself,
  onDismiss,
}: Readonly<GenerationErrorBannerProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const copy = copyFor(variant, reason, startError);

  return (
    <motion.div
      role="alert"
      initial={reduce ? false : { opacity: 0 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, x: [0, -4, 4, 0] }}
      transition={{ duration: 0.3 }}
      className="border-destructive/30 bg-destructive/5 flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle className="text-destructive mt-0.5 h-4.5 w-4.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-semibold">{copy.headline}</p>
          {copy.clause.length > 0 && (
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{copy.clause}</p>
          )}
        </div>
      </div>

      <ErrorBannerActions
        variant={variant}
        reason={reason}
        onRetry={onRetry}
        onWriteItMyself={onWriteItMyself}
        onDismiss={onDismiss}
      />
    </motion.div>
  );
}
