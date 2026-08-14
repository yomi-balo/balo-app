'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck } from 'lucide-react';
import { toast } from 'sonner';
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
import { Button } from '@/components/ui/button';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { resolveCaseAction } from '../_actions/resolve-case';
import { requestResolutionAction } from '../_actions/request-resolution';

/**
 * BAL-421 — the two rail mutations, and the confirmation the client one deserves.
 *
 * ⚠⚠ "MARK RESOLVED" IS CLIENT-ONLY (BAL-417), AND THE EXPERT MAY ONLY *ASK*. That asymmetry
 * is enforced three times over and none of them is decoration: the `CaseSurfaceView`
 * discriminant means an expert-lens view has no `canClose` field at all, `resolveCaseAction`
 * asserts the lens before it checks any capability, and `caseEngagementsRepository.close()`
 * re-asserts live company membership as a data-integrity invariant.
 *
 * ⚠ CLOSING IS CONFIRMED, ASKING IS NOT. A close is a TERMINAL state change that ends the
 * conversation's writability, so it gets an `AlertDialog` that says what happens. The expert's
 * ask changes nothing the expert can see and sends no notification — a confirmation there
 * would be ceremony around a no-op.
 *
 * ⚠ TOAST ON EVERY OUTCOME, success and failure (balo-ui). No silent successes.
 */
export function MarkResolvedButton({
  engagementId,
}: Readonly<{ engagementId: string }>): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const confirm = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'mark_resolved', lens: 'client' });
    startTransition(async () => {
      const result = await resolveCaseAction({ engagementId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setOpen(false);
      toast.success('Case marked resolved.');
      router.refresh();
    });
  }, [engagementId, router]);

  const onOpen = useCallback(() => {
    setOpen(true);
  }, []);

  return (
    <>
      <Button type="button" variant="outline" className="min-h-11 w-full gap-2" onClick={onOpen}>
        <CircleCheck className="h-4 w-4" aria-hidden="true" />
        Mark resolved
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this case resolved?</AlertDialogTitle>
            <AlertDialogDescription>
              {
                'Everything here stays available — consultations, files and the conversation. The conversation becomes read-only, and you can always start a new case.'
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={confirm} disabled={pending}>
              {pending ? 'Marking resolved…' : 'Yes, mark it resolved'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The expert's ask.
 *
 * ⚠ IT RENDERS ONLY WHEN `canRequestResolution` — i.e. the case is OPEN and no ask is already
 * outstanding. It is never rendered disabled: a re-ask is technically allowed by the
 * repository (last-ask-wins), but offering the button again while the banner is already up on
 * the client's surface would invite pointless re-asks.
 *
 * ⚠ THE GATE IS THE ENGAGEMENT AXIS, SERVER-SIDE. An agency colleague with role `expert` can
 * SEE this whole surface (visibility is deliberately wider) and will be refused here — which
 * is correct, and is why the failure path toasts a real message rather than assuming success.
 */
export function RequestResolutionButton({
  engagementId,
}: Readonly<{ engagementId: string }>): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const ask = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'request_resolution', lens: 'expert' });
    startTransition(async () => {
      const result = await requestResolutionAction({ engagementId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success('Asked if the case is resolved.');
      router.refresh();
    });
  }, [engagementId, router]);

  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 w-full gap-2"
      onClick={ask}
      disabled={pending}
    >
      <CircleCheck className="h-4 w-4" aria-hidden="true" />
      {pending ? 'Asking…' : "Ask if it's resolved"}
    </Button>
  );
}
