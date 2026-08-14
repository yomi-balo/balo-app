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
import type { CaseResolveSource } from '@balo/analytics/events';
import { resolveCaseAction } from '../_actions/resolve-case';

/**
 * BAL-388 — THE ONE resolve confirmation dialog, now with THREE entry points across TWO
 * surfaces (the R4 banner, the R9 rail card, and BAL-389's end-of-call resolve prompt). One
 * component, one mutation, one copy — each surface asks the question once.
 *
 * ⚠⚠ BAL-389 WRAPS IT IN PLACE RATHER THAN HOISTING IT to `components/balo/meetings/`. Moving
 * the file would turn `expert-recap.test.tsx` red for nothing: its `ALLOWED` set names
 * `resolve-dialog.tsx` and its "guards the guard" test asserts every allow-listed name is
 * genuinely present in the scanned directory. The end route's own structural test scans its own
 * `_components/` regardless, and keeping ONE definition of the close-confirmation copy is the
 * property the duplication gate actually protects.
 *
 * ⚠ THE HARD-WON PROPERTIES BELOW ARE INHERITED BY THE END-OF-CALL SCREEN, NOT RE-EARNED:
 * undismissable in flight, non-destructive styling, toast on both outcomes, refresh afterwards.
 * That is the whole reason it is reused instead of re-implemented.
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
  source,
  onResolved,
  open,
  onOpenChange,
}: Readonly<{
  meetingId: string;
  expertShortName: string;
  /** FALSE when this reviewer already rated this expert — no email will be sent. */
  reviewWillBeAsked: boolean;
  /**
   * WHICH SURFACE is asking. Threaded into `case_resolved.source`; gates nothing.
   *
   * ⚠⚠ `Extract`ED FROM `CaseResolveSource` RATHER THAN BEING IT, AND NOT AS A STYLE CHOICE.
   * That union gained `case_surface` in BAL-421, but this dialog hardcodes `resolveCaseAction`
   * — the MEETING-anchored close — and the case surface closes through its own action from its
   * own confirm step. Typing the prop as the full union would let a caller hand this dialog a
   * `case_surface` source it would then report on a meeting-anchored close, mislabelling the one
   * distribution the property exists to measure. The `Extract` keeps `tsc` bound to the analytics
   * union (a renamed member still breaks here) while making the third value unrepresentable.
   */
  source: Extract<CaseResolveSource, 'recap' | 'end_of_call'>;
  /** Fired after a CONFIRMED close, so each surface can state its own outcome in place. */
  onResolved?: () => void;
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
    resolveCaseAction({ meetingId, source })
      .then((result) => {
        if (result.success) {
          // ⚠ RECAP-ONLY. `recap_cta_clicked` measures the RECAP's forward actions; pumping it
          // from the end-of-call screen would silently corrupt the shipped recap CTA funnel with
          // clicks that never happened there. The end-of-call surface fires its own event from
          // `onResolved`, and the SURFACE-AGNOSTIC business fact is the server-side
          // `case_resolved{source}` this action already emits.
          if (source === 'recap') {
            track(RECAP_EVENTS.CTA_CLICKED, { cta: 'case_resolved', lens: 'client' });
          }
          toast.success('Case resolved — nice work.');
          onResolved?.();
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
  }, [meetingId, onOpenChange, onResolved, router, source]);

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
          {/* ⚠ THE SAME FACT AS "It cannot be reopened.", IN THE WARM MILESTONE REGISTER
              CLAUDE.md ASKS FOR — and it is the PROTOTYPE's own wording
              (`.claude/design-references/end-of-call.jsx`), not a softening invented here.
              "Cannot be reopened" reads as a penalty on what is meant to be a completion; the
              reframing states the identical irreversibility while answering the question the
              client is actually asking, which is "do I lose anything?". Both surfaces improve
              together — this dialog is shared with the recap's R9 wrap-up card. */}
          <li>{'Everything stays available, and booking again starts a new one.'}</li>
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
            {/* ⚠⚠ "Go back", NOT "Not yet" — ONE LABEL MUST NOT MEAN TWO THINGS IN ONE FLOW.
                BAL-389's end-of-call prompt asks "Is this issue resolved?" with a "Not yet"
                answer, and pressing "Yes, it's sorted" opens THIS dialog, which had a second
                "Not yet" one tap later. The first answers the question; the second only dismisses
                the confirmation. Same words, same flow, two different meanings. This one is a
                cancel, so it is named like one. */}
            Go back
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
