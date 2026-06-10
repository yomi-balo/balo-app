'use client';

import { useCallback, useState, useTransition } from 'react';
import { CheckCircle2, Loader2, Send, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import {
  RichTextEditor,
  RichTextViewer,
  validateDescription,
  plainTextLength,
  DESCRIPTION_MAX_TEXT,
} from '@/components/balo/rich-text-editor';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { RequestCard } from './request-card';
import { submitEoiAction } from '@/app/(dashboard)/projects/[requestId]/_actions/submit-eoi';
import { withdrawEoiAction } from '@/app/(dashboard)/projects/[requestId]/_actions/withdraw-eoi';

interface EoiEntryProps {
  requestId: string;
  /** Seed: does the viewer-expert already have a live EOI? (from `view.viewerEoi`). */
  initialHasEoi: boolean;
  /** Seed: the viewer-expert's own submitted pitch HTML (re-rendered read-only). */
  initialMessageHtml: string | null;
  /** Compact placement (Phase-2 right column) trims padding/copy. */
  compact?: boolean;
}

const EDITOR_PLACEHOLDER =
  "Why you're a strong fit, relevant experience, your approach… A short, specific pitch starts the conversation.";

/**
 * Expert EOI-entry island (BAL-270 / A3). Toggles between two states, seeded from
 * `view.viewerEoi`:
 *  - COMPOSE (no live EOI): a locked-format rich-text editor gated by
 *    `validateDescription`; submit calls `submitEoiAction`, on success flips to
 *    submitted + fires `PROJECT_EOI_SUBMITTED`.
 *  - SUBMITTED (live EOI): the pitch rendered read-only via `RichTextViewer`, with
 *    a withdraw affordance behind an `AlertDialog` confirm; on confirm calls
 *    `withdrawEoiAction`, fires `PROJECT_EOI_WITHDRAWN`, and flips back to compose
 *    (cleared) so the expert can resubmit.
 *
 * Four async states: loading = spinner on the active button while pending; empty =
 * the editor's invitation framing; error = `toast.error` keeping the draft;
 * success = `toast.success` + state flip. Errors never discard the typed draft.
 */
export function EoiEntry({
  requestId,
  initialHasEoi,
  initialMessageHtml,
  compact = false,
}: Readonly<EoiEntryProps>): React.JSX.Element {
  const [submitted, setSubmitted] = useState(initialHasEoi);
  const [submittedHtml, setSubmittedHtml] = useState(initialMessageHtml ?? '');
  const [draft, setDraft] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Gating reuses the shared `validateDescription` contract (non-null ⇒ invalid),
  // but the inline COPY is EOI-framed for an expert pitching themselves — distinct
  // from the project-brief voice the shared validator emits. Derived locally from
  // the plain-text length so we don't fork the shared `plain-text.ts` strings (the
  // project-drawer brief still depends on those). Mirrors submit-eoi.ts's copy.
  const validationError = validateDescription(draft);
  const validationMessage =
    validationError === null
      ? null
      : plainTextLength(draft) > DESCRIPTION_MAX_TEXT
        ? `Keep your pitch under ${DESCRIPTION_MAX_TEXT} characters.`
        : 'Add a few words about why you’re a strong fit.';

  const handleSubmit = useCallback((): void => {
    if (validateDescription(draft) !== null) {
      setShowValidation(true);
      return;
    }
    startTransition(async () => {
      const result = await submitEoiAction({ requestId, message: draft });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      track(PROJECT_EVENTS.PROJECT_EOI_SUBMITTED, {
        request_id: requestId,
        relationship_id: result.relationshipId,
        expert_id: result.expertProfileId,
        time_to_eoi_ms: result.timeToEoiMs,
      });
      setSubmittedHtml(draft);
      setSubmitted(true);
      setShowValidation(false);
      toast.success('Your interest has been sent — the client has been notified.');
    });
  }, [draft, requestId]);

  const handleWithdraw = useCallback((): void => {
    startTransition(async () => {
      const result = await withdrawEoiAction({ requestId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      track(PROJECT_EVENTS.PROJECT_EOI_WITHDRAWN, {
        request_id: requestId,
        relationship_id: result.relationshipId,
        expert_id: result.expertProfileId,
      });
      setWithdrawOpen(false);
      setSubmitted(false);
      setSubmittedHtml('');
      setDraft('');
      toast.success('Interest withdrawn. You can resubmit any time.');
    });
  }, [requestId]);

  if (submitted) {
    return (
      <RequestCard
        className={cn(
          'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none',
          compact ? 'p-4' : 'p-6'
        )}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="bg-success/10 text-success flex h-7 w-7 items-center justify-center rounded-md">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-foreground text-sm font-semibold">Interest sent</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              The client can read your pitch and message you.
            </p>
          </div>
        </div>

        <div className="border-border bg-muted/30 text-foreground rounded-xl border p-3.5 text-sm leading-relaxed">
          <RichTextViewer value={submittedHtml} />
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setWithdrawOpen(true)}
            disabled={isPending}
            className="text-destructive hover:bg-destructive/10 focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60"
          >
            Withdraw interest
          </button>
        </div>

        <AlertDialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Withdraw your interest?</AlertDialogTitle>
              <AlertDialogDescription>
                You can resubmit later, but the client will no longer see this pitch.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Keep my interest</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  // Keep the dialog mounted while the action runs — close on success.
                  event.preventDefault();
                  handleWithdraw();
                }}
                disabled={isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  'Withdraw'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </RequestCard>
    );
  }

  return (
    <RequestCard
      className={cn(
        'animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none',
        compact ? 'p-4' : 'p-6'
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="bg-primary/10 text-primary flex h-7 w-7 items-center justify-center rounded-md">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <div>
          <p className="text-foreground text-sm font-semibold">Express your interest</p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            A short, specific pitch starts the conversation with the client.
          </p>
        </div>
      </div>

      <RichTextEditor
        value={draft}
        onChange={setDraft}
        placeholder={EDITOR_PLACEHOLDER}
        ariaLabel="Your expression of interest"
      />

      {showValidation && validationMessage !== null && (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {validationMessage}
        </p>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isPending || validationError !== null}
          className="from-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-gradient-to-r to-violet-600 px-4 text-[13.5px] font-semibold text-white transition-opacity focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 dark:to-violet-500"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Send interest
        </button>
      </div>
    </RequestCard>
  );
}
