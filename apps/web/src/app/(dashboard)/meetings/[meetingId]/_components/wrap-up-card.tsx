'use client';

import { useCallback, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionHead } from '@/components/balo/section/section-states';
import type { RecapResolveView } from '@/lib/meetings/recap-view-types';
import { ResolveDialog } from './resolve-dialog';

/**
 * BAL-388 §R9 — the WRAP-UP card. CLIENT LENS ONLY. Two states, one slot:
 *
 *   OFFER    — an OPEN case where the expert has NOT asked (R4 owns it when they have; the two
 *              are mutually exclusive).
 *   RESOLVED — the case is CLOSED. The card STAYS and states the outcome.
 *
 * ⚠⚠ THE RESOLVED STATE IS NOT DECORATION. Returning `null` after the one irreversible
 * action on the page unmounted the rail card the user had just used: the milestone read as a
 * form submitting rather than a wrap-up completing, the rail jumped as Files rose, and the
 * dialog promise of a review link was corroborated by nothing on the page. It is driven off
 * `resolve.resolved`, i.e. off `case_engagements.closed_at`, so a refresh re-derives it from
 * the DB rather than from optimistic client state.
 *
 * ⚠ THE REVIEW LINE IS CONDITIONAL BECAUSE THE EMAIL IS. `resolveReviewAsk` mints NO token
 * when this reviewer already rated this expert on this engagement, and an `auto_inactive` close
 * mints none at all — so `reviewLinkSent` decides the sentence rather than the copy promising
 * an email that will not arrive.
 *
 * ⚠⚠ IMPORTED ONLY BY `client-recap.tsx`. The expert composition never references it. That is
 * the structural half of the acceptance criterion; a static source-scan test over EVERY file in
 * this directory pins it.
 *
 * ⚠ THE CTA IS DELIBERATELY **OUTLINE**, NOT THE PRIMARY GRADIENT. This is an OFFER, not the
 * page main action. Chasing a close is exactly the wrong register, and the reassurance line
 * below says so out loud.
 */
export function WrapUpCard({
  meetingId,
  resolve,
}: Readonly<{ meetingId: string; resolve: RecapResolveView }>): React.JSX.Element | null {
  const [dialogOpen, setDialogOpen] = useState(false);
  const openDialog = useCallback(() => setDialogOpen(true), []);

  if (resolve.resolved !== null) {
    return (
      <section className="bg-card border-border rounded-2xl border p-6">
        <SectionHead icon={CircleCheck} title="Resolved" />
        <p className="text-muted-foreground text-sm leading-relaxed">
          Thanks for wrapping this one up. Everything from this case stays here — the summary, the
          action items and the files.
        </p>
        {resolve.resolved.reviewLinkSent && (
          <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">
            {'We have emailed you a short review link for '}
            {resolve.expertShortName}
            {' — two minutes, and only if you feel like it.'}
          </p>
        )}
      </section>
    );
  }

  if (resolve.variant !== 'offered') {
    return null;
  }

  return (
    <section className="bg-card border-border rounded-2xl border p-6">
      <SectionHead icon={CircleCheck} title="Wrap up" />
      <p className="text-muted-foreground text-sm leading-relaxed">
        Is this issue sorted? Marking it resolved closes the case — you can always start a new one.
      </p>
      <Button type="button" variant="outline" onClick={openDialog} className="mt-4 min-h-11 w-full">
        Mark resolved
      </Button>
      <p className="text-muted-foreground mt-2.5 text-xs leading-relaxed">
        {'Nothing to do if you are not finished — the case stays open.'}
      </p>

      <ResolveDialog
        meetingId={meetingId}
        expertShortName={resolve.expertShortName}
        reviewWillBeAsked={resolve.reviewWillBeAsked}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </section>
  );
}
