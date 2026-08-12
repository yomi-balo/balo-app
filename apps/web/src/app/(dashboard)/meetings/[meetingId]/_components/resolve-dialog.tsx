'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { resolveCaseAction } from '../_actions/resolve-case';

/**
 * BAL-388 — THE ONE resolve confirmation dialog, with TWO entry points (R4 banner and R9 rail
 * card). One component, one mutation, one copy — the page asks the question once.
 *
 * ⚠ MJ COPY CHECKPOINT — the most sensitive copy on the page. Three or four facts, in a warm
 * milestone register. This is NOT a deletion confirm: no red, no `AlertTriangle`, no
 * destructive variant.
 *
 * ⚠ THE REVIEW-LINK FACT IS CONDITIONAL, BECAUSE THE EMAIL IS. `resolveReviewAsk` mints NO
 * token when this reviewer already rated this expert on this engagement, so for a REPEAT client
 * an unconditional promise is simply untrue. Three facts is fine.
 *
 * ⚠ THERE IS NO `lens` PROP. Both entry points are client-lens by construction (the expert
 * composition never imports either), so a prop that can only ever hold one value would make
 * `recap_cta_clicked.lens` look like a dimension when it is a constant.
 *
 * ⚠⚠ THE DIALOG CANNOT BE DISMISSED WHILE THE MUTATION IS IN FLIGHT. Disabling the two
 * buttons is not enough: Esc and an overlay click both go through `onOpenChange`, so a user who
 * pressed Esc mid-flight watched the dialog vanish and reasonably believed they had cancelled —
 * while the case closed IRREVERSIBLY a moment later. Apparent cancellability is a trap for the
 * one mutation on this page that cannot be undone. Matches the shipped `EditActionItemDialog`.
 *
 * ⚠ DOUBLE-SUBMIT IS SAFE. The action is idempotent server-side (`CaseAlreadyClosedError` is
 * treated as success and the close email does NOT publish twice), so a second click can never
 * send a second email.
 *
 * ⚠ TOAST ON BOTH OUTCOMES (balo-ui: never a silent mutation), then `router.refresh()` so the
 * server-rendered chip, the closed-case note and the wrap-up card all re-derive from the DB
 * rather than from optimistic client state.
 */
export function ResolveDialog({
  meetingId,
  expertShortName,
  reviewWillBeAsked,
  open,
  onOpenChange,
}: Readonly<{
  meetingId: string;
  expertShortName: string;
  /** FALSE when this reviewer already rated this expert — no email will be sent. */
  reviewWillBeAsked: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}>): React.JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const inFlight = busy || isPending;

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const requestOpenChange = useCallback(
    (next: boolean) => {
      if (inFlight) return;
      onOpenChange(next);
    },
    [inFlight, onOpenChange]
  );

  const confirm = useCallback(() => {
    setBusy(true);
    resolveCaseAction({ meetingId })
      .then((result) => {
        if (result.success) {
          track(RECAP_EVENTS.CTA_CLICKED, { cta: 'case_resolved', lens: 'client' });
          toast.success('Case resolved — nice work.');
          onOpenChange(false);
          return;
        }
        toast.error(result.error);
      })
      .catch(() => {
        toast.error('Something went wrong. Please try again.');
      })
      .finally(() => {
        setBusy(false);
        startTransition(() => router.refresh());
      });
  }, [meetingId, onOpenChange, router]);

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Mark this case resolved?</DialogTitle>
          <DialogDescription>
            A few things worth knowing before you wrap this one up.
          </DialogDescription>
        </DialogHeader>

        <ul className="text-muted-foreground space-y-2 text-sm leading-relaxed">
          <li>It closes the case for both of you.</li>
          <li>{'It cannot be reopened.'}</li>
          <li>You can start a new case with {expertShortName} any time.</li>
          {reviewWillBeAsked && (
            <li>{'We will send you a short review link — completely optional.'}</li>
          )}
        </ul>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={inFlight}
            onClick={close}
            className="min-h-11"
          >
            Not yet
          </Button>
          <Button type="button" disabled={inFlight} onClick={confirm} className="min-h-11 gap-2">
            {inFlight && (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {inFlight ? 'Marking resolved…' : 'Yes, mark it resolved'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
