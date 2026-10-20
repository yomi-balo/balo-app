'use client';

import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Loader2 } from 'lucide-react';
import type { PassableRelationshipStatus } from '@balo/shared/project-requests';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
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
import { passOnRequestAction } from '@/app/(dashboard)/projects/[requestId]/_actions/pass-on-request';

interface PassOnRequestControlProps {
  requestId: string;
  requestTitle: string;
  /** The viewer's track stage; `proposal_requested` adds the draft-withdrawal sentence. */
  relationshipStatus: PassableRelationshipStatus;
}

const UNEXPECTED_FAILURE = 'Something went wrong. Please try again.';

/**
 * Expert-side "Pass on this project" control (BAL-604): a quiet text trigger that opens an
 * AlertDialog confirm. "Keep it" is the default focus; "Pass" is a ghost button with destructive
 * text, never the primary.
 *
 * Mounted by the shell only while the viewer's track is at a passable stage, so there is no
 * empty state. A plain `useState` flag drives the pending state (not `useTransition`) and the
 * Action click calls `preventDefault`, so the dialog stays mounted while the action runs and is
 * dismissed only on failure or by the redirect.
 */
export function PassOnRequestControl({
  requestId,
  requestTitle,
  relationshipStatus,
}: Readonly<PassOnRequestControlProps>): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [passing, setPassing] = useState(false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (passing) return;
      setOpen(next);
    },
    [passing]
  );

  const handleConfirm = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (passing) return;
      setPassing(true);
      (async () => {
        const result = await passOnRequestAction({ requestId });
        if (result.success) {
          toast.success(`You've passed on ${requestTitle}`);
          router.push('/projects');
          return;
        }
        toast.error(result.error);
        if (result.code === 'not_passable') router.refresh();
        setPassing(false);
        setOpen(false);
      })().catch((error: unknown) => {
        toast.error(UNEXPECTED_FAILURE);
        Sentry.captureException(error);
        setPassing(false);
        setOpen(false);
      });
    },
    [passing, requestId, requestTitle, router]
  );

  return (
    <div className="flex justify-end">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center rounded-[10px] px-3 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        Pass on this project
      </button>

      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pass on this project?</AlertDialogTitle>
            <AlertDialogDescription>
              Balo will look for other experts. You won&apos;t be able to rejoin this request
              yourself.
              {relationshipStatus === 'proposal_requested' && (
                // pending-MJ
                <> Any draft proposal you&apos;ve started will be withdrawn.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:items-center sm:justify-between">
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={passing}
              className={cn(
                buttonVariants({ variant: 'ghost' }),
                'text-destructive hover:bg-destructive/10 hover:text-destructive bg-transparent sm:-ml-3.5'
              )}
            >
              {passing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Passing…
                </>
              ) : (
                'Pass'
              )}
            </AlertDialogAction>
            <AlertDialogCancel disabled={passing}>Keep it</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
