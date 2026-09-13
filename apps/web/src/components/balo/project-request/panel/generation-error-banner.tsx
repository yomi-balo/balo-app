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
};

export interface GenerationErrorBannerProps {
  reason: ProjectBriefFailureReason;
  variant: 'upload' | 'review';
  onRetry?: () => void;
  onWriteItMyself?: () => void;
  onDismiss?: () => void;
}

/**
 * BAL-254 — the inline failure banner shown in place of the spinner on `upload` and in place
 * of the AI banner's position on `review` (never both at once). Mount animation reuses the
 * EXISTING shake vocabulary from `document-uploader.tsx` (`x: [0, -4, 4, 0]` on a failed row) —
 * zero new animation vocabulary introduced for this surface.
 */
export function GenerationErrorBanner({
  reason,
  variant,
  onRetry,
  onWriteItMyself,
  onDismiss,
}: Readonly<GenerationErrorBannerProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const copy =
    variant === 'review'
      ? { headline: "Couldn't regenerate — your previous draft is unchanged.", clause: '' }
      : COPY_BY_REASON[reason];

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

      {variant === 'upload' ? (
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
      ) : (
        <div>
          <button
            type="button"
            onClick={onDismiss}
            className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center justify-center rounded-[11px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            Dismiss
          </button>
        </div>
      )}
    </motion.div>
  );
}
