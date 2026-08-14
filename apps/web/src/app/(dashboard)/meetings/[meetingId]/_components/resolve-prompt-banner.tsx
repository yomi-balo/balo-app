'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { RecapResolveView } from '@/lib/meetings/recap-view-types';
import { dismissResolutionRequestAction } from '../_actions/dismiss-resolution-request';
import { useResolveDismissal } from './resolve-dismissal';
import { ResolveDialog } from './resolve-dialog';

/**
 * BAL-388 §R4 — the EXPERT'S RESOLUTION REQUEST banner. CLIENT LENS ONLY.
 *
 * ⚠⚠ THIS MODULE IS IMPORTED **ONLY** BY `client-recap.tsx`. The expert composition never
 * references it, which is what makes "the expert lens never shows the resolve prompt"
 * STRUCTURAL rather than conditional — there is no `if (lens === expert)` anywhere to get
 * wrong. A static source-scan test pins that.
 *
 * ⚠ R4 AND R9 ARE MUTUALLY EXCLUSIVE. When the expert has ASKED, this banner carries the
 * question — louder, and attributed. Otherwise the quieter rail card offers it. Never both.
 *
 * ⚠ ATTRIBUTION IS RETROSPECTIVE: it names the PERSON who asked, with "@ agency" on first
 * mention (CLAUDE.md). An independent expert renders bare. NEVER an email address.
 *
 * ⚠ DISMISSAL IS A SERVER MUTATION, NOT LOCAL STATE — it clears the paired request columns,
 * so the banner does not reappear on refresh. It publishes NOTHING (owner decision D-E): the
 * expert is not told.
 *
 * ⚠⚠ AND IT MUST NOT FALL BACK TO R9 IN THE SAME SESSION — a client who said "not yet" must
 * not be asked again two inches lower. That is NOT free: clearing the request columns is
 * exactly what makes the next server render report `variant: 'offered'`, which fills the §R9
 * slot. So the answer is recorded ABOVE both prompts, in `ResolveDismissalProvider`, and
 * `UnlessDismissed` in the layout suppresses BOTH slots (wrapper included) for the rest of the
 * session. This component therefore keeps NO `dismissed` state of its own: one owner, one rule,
 * and it survives the `router.refresh()` that unmounts this banner.
 */
export function ResolvePromptBanner({
  meetingId,
  resolve,
}: Readonly<{ meetingId: string; resolve: RecapResolveView }>): React.JSX.Element | null {
  const router = useRouter();
  const { markDismissed } = useResolveDismissal();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const openDialog = useCallback(() => setDialogOpen(true), []);

  const dismiss = useCallback(() => {
    setBusy(true);
    dismissResolutionRequestAction({ meetingId })
      .then((result) => {
        if (result.success) {
          markDismissed();
          toast.success('No problem — the case stays open.');
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
  }, [markDismissed, meetingId, router]);

  if (resolve.variant !== 'requested') {
    return null;
  }

  const inFlight = busy || isPending;
  const headline =
    resolve.requesterLabel === null
      ? 'This one looks sorted'
      : resolve.requesterLabel + ' thinks this one is sorted';

  return (
    <section className="border-primary/15 bg-primary/5 dark:bg-primary/10 rounded-2xl border px-5 py-4">
      <div className="flex items-start gap-3">
        <Sparkles size={17} className="text-primary mt-0.5 flex-none" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground text-[15px] font-semibold">{headline}</h2>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            If your issue is resolved, closing the case wraps it up — you can always start a new
            one.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            <Button type="button" onClick={openDialog} disabled={inFlight} className="min-h-11">
              Yes, mark it resolved
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={dismiss}
              disabled={inFlight}
              className="min-h-11"
            >
              Not yet
            </Button>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={dismiss}
          disabled={inFlight}
          aria-label="Dismiss this request"
          className="min-h-11 min-w-11 flex-none"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <ResolveDialog
        meetingId={meetingId}
        expertShortName={resolve.expertShortName}
        reviewWillBeAsked={resolve.reviewWillBeAsked}
        source="recap"
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </section>
  );
}
