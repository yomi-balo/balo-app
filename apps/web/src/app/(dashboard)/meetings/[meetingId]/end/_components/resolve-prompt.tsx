'use client';

import { useCallback, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { EndOfCallResolveView } from '@/lib/meetings/end-of-call-view-types';
import { ResolveDialog } from '../../_components/resolve-dialog';
import { StateSwap } from './state-swap';

/**
 * BAL-389 — the case-resolution prompt: `ask → confirm → done`, with `acknowledged` as the
 * third terminal answer.
 *
 * This is the ONE consequential thing on an otherwise throwaway screen, and it is here on
 * purpose: most cases would otherwise never be closed deliberately — the client stops booking,
 * 30 days pass, the sweep closes it, and the review email lands a month later with poor recall.
 * Asking at the moment the client actually knows the answer is the whole point.
 *
 * ⚠⚠ THE CONFIRM STEP **IS** THE SHIPPED `ResolveDialog`, IMPORTED ACROSS THE SEGMENT
 * BOUNDARY — not a re-implementation of the prototype's inline confirm box. That component
 * already carries properties this screen must inherit rather than re-earn: it CANNOT be
 * dismissed while the mutation is in flight (Esc and overlay click both blocked — apparent
 * cancellability is a trap for the one irreversible action here), it is not styled as a
 * destructive confirm, it toasts on both outcomes, and it refreshes afterwards. Keeping ONE
 * definition of the close-confirmation copy is also what the duplication gate protects.
 *
 * ⚠⚠ THE `done` STATE MUST SURVIVE THE POST-CLOSE `router.refresh()`. The dialog refreshes in
 * its `finally`, so `done` is rendered when the LOCAL step is `done` **OR** the server says
 * `alreadyClosed` — driven off `case_engagements.closed_at`, exactly as the recap's `WrapUpCard`
 * learned ("resolved IS NOT the absence of a prompt"). The parent's mount condition does not
 * depend on `alreadyClosed`, so the refresh cannot unmount this mid-transition.
 *
 * ⚠⚠ AN OUTSTANDING EXPERT REQUEST IS **CONTEXT, NOT A PENDING-APPROVAL STATE**. It prefixes
 * ONE line naming the requester (retrospective: person @ agency on first mention) and the prompt
 * stays the same ask. There is no approve/decline pair, no "awaiting" copy, and no dismissal:
 * this screen deliberately does NOT import `ResolveDismissalProvider` or
 * `dismissResolutionRequestAction`. Ignoring or declining does nothing — no penalty, and no
 * re-prompt on this screen. A source-scan test pins that absence by name.
 *
 * ⚠⚠ "Not yet" ANSWERS THE QUESTION IN PLACE, AND WRITES **NOTHING**. It used to call a handler
 * that set the step to the step it was already on: tapping it did literally nothing, so the
 * question just sat there having apparently ignored the answer — the worst reading of a control
 * whose whole promise is "declining costs you nothing". It now replaces the prompt with a
 * one-line acknowledgement that also says where the action still lives. The ticket's rule is
 * unchanged and must stay unchanged: NO server call, NO persistence, NO re-prompt — this is
 * SESSION-LOCAL component state and a reload legitimately asks again. The recap's dismissal
 * model (which DOES write) must not leak onto a surface whose answer is "nothing happens".
 *
 * ⚠ THE ACKNOWLEDGEMENT TAKES FOCUS. It replaces the two buttons the user was standing on, so
 * without the `tabIndex={-1}` + mount-time focus a keyboard user is dropped to the top of the
 * document — the same defect the rating block's swap carried. `StateSwap` explains why the ref
 * is a callback rather than an effect.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off. The resolve confirmation is flagged on the ticket's open
 * copy list.
 */
export function ResolvePrompt({
  meetingId,
  resolve,
  reviewWillBeAsked,
}: Readonly<{
  meetingId: string;
  resolve: EndOfCallResolveView;
  /**
   * Whether closing WOULD send a review email.
   *
   * ⚠⚠ COMPUTED CLIENT-SIDE BY THE PARENT, NEVER READ FROM THE SERVER VIEW. A server value is
   * computed BEFORE the user rates, so on the just-rated path it would be stale-`true` and the
   * dialog would promise an email `resolveReviewAsk` will not send (it skips the token when this
   * reviewer already rated this expert on this engagement — the SAME triple
   * `readEngagementReview` reads). Under the rate-first ordering this is therefore always
   * `false`, and it is false BY DERIVATION rather than by hardcoding.
   */
  reviewWillBeAsked: boolean;
}>): React.JSX.Element {
  const [step, setStep] = useState<'ask' | 'confirm' | 'done' | 'acknowledged'>('ask');

  const openConfirm = useCallback(() => setStep('confirm'), []);
  const acknowledge = useCallback(() => setStep('acknowledged'), []);
  const markDone = useCallback(() => setStep('done'), []);
  const focusOnMount = useCallback((node: HTMLDivElement | null) => {
    node?.focus();
  }, []);
  /**
   * ⚠⚠ CLOSING THE DIALOG MUST NEVER DOWNGRADE `done`, AND THE ORDER IS WHY. On a successful
   * close `ResolveDialog` calls `onResolved()` (→ `done`) and THEN `onOpenChange(false)`; a
   * naive `setStep(next ? 'confirm' : 'ask')` would immediately overwrite the success state and
   * re-ask the client to close a case they just closed. Only the `confirm` step reverts.
   */
  const onDialogOpenChange = useCallback((next: boolean) => {
    setStep((current) => {
      if (next) return 'confirm';
      return current === 'confirm' ? 'ask' : current;
    });
  }, []);

  /**
   * ⚠ ONE `StateSwap`, ONE KEY — NEVER THREE EARLY RETURNS EACH WRAPPING THEIR OWN. A separate
   * `AnimatePresence` per branch is a NEW `AnimatePresence` on every state change, which has no
   * outgoing child to exit and therefore animates nothing at all. The key is what swaps.
   */
  const branch = resolveBranch(step, resolve.alreadyClosed);

  return (
    <StateSwap
      swapKey={branch}
      className={branch === 'ask' ? 'flex w-full flex-col items-center' : undefined}
    >
      {branch === 'done' && (
        <div className="border-success/25 bg-success/10 flex w-full items-start gap-2.5 rounded-2xl border px-4 py-3 text-left">
          <CircleCheck className="text-success mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          {/* ⚠ ONE LINE, NOT THE PROTOTYPE'S TERNARY. Its other branch ("We'll email you a short
              review request.") is STRUCTURALLY UNREACHABLE here: this prompt only mounts once a
              rating exists, and `resolveReviewAsk` skips the token in exactly that case — so the
              close email genuinely omits its review block. A branch no code path can enter is
              dead copy. The conditional legitimately lives in `WrapUpCard` / `ResolveDialog`,
              which are reached without a rating. */}
          <p className="text-sm leading-relaxed">
            <span className="text-foreground font-medium">Case closed.</span>{' '}
            <span className="text-muted-foreground">
              Your review is saved, so nothing else to do.
            </span>
          </p>
        </div>
      )}

      {branch === 'acknowledged' && (
        <div
          ref={focusOnMount}
          tabIndex={-1}
          className="text-muted-foreground w-full text-sm leading-relaxed outline-none"
        >
          No problem — you can mark it resolved any time from the case.
        </div>
      )}

      {branch === 'ask' && (
        <>
          {resolve.requesterLabel !== null && (
            <p className="text-muted-foreground mb-1.5 text-sm">
              {resolve.requesterLabel + ' thinks this one is sorted'}
            </p>
          )}
          {/* ⚠ m6 — A HEADING, NOT A PARAGRAPH, so a screen-reader user can jump between the two
              questions this card asks. Visual weight is deliberately unchanged. */}
          <h2 className="text-foreground text-sm font-medium">Is this issue resolved?</h2>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={openConfirm}
              className="min-h-11 text-sm"
            >
              {"Yes, it's sorted"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={acknowledge}
              className="text-muted-foreground min-h-11 text-sm"
            >
              Not yet
            </Button>
          </div>

          <ResolveDialog
            meetingId={meetingId}
            expertShortName={resolve.expertShortName}
            reviewWillBeAsked={reviewWillBeAsked}
            source="end_of_call"
            onResolved={markDone}
            open={step === 'confirm'}
            onOpenChange={onDialogOpenChange}
          />
        </>
      )}
    </StateSwap>
  );
}

/**
 * Which of the three terminal presentations owns the slot. `confirm` deliberately maps to `ask`:
 * the dialog is an overlay ON TOP of the question, so the card behind it must not swap out
 * underneath — and it must not swap back in when the dialog is cancelled either.
 */
function resolveBranch(
  step: 'ask' | 'confirm' | 'done' | 'acknowledged',
  alreadyClosed: boolean
): 'ask' | 'done' | 'acknowledged' {
  if (step === 'done' || alreadyClosed) return 'done';
  if (step === 'acknowledged') return 'acknowledged';
  return 'ask';
}
