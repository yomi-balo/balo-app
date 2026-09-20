'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { RESERVED_BASE_PARTICIPANTS } from '@balo/shared/meetings';
import { GUEST_ACTION_COPY } from '@/lib/meetings/guests-copy';
import { GuestInviteComposer, type GuestDraft } from './guest-invite-composer';
import { inviteConsultationGuestsAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/invite-consultation-guests';

/**
 * BAL-573 — "Invite a colleague" from a consultation row on the case surface. Structure copies
 * the house pattern from `reschedule-dialog.tsx`: desktop `Dialog` / mobile `Sheet` via
 * `useIsMobile(768)`.
 *
 * ⚠⚠ AC 6 — THE SEND BUTTON IS NEVER PRE-EMPTIVELY DISABLED BY THE CAP. `disabled={submitting ||
 * drafts.length === 0}` — and NOTHING ELSE. The seat counter and the queue counter are separate
 * resources and the count is unsynchronised with the insert (`countLiveByMeeting`'s docblock); a
 * client-side `count >= cap` gate would reintroduce the invite lockout the counter split exists
 * to close, moved from the server to the client. The server answers `409`, and this dialog turns
 * it into a sentence. Disabling on an EMPTY draft list is a different thing — there is nothing to
 * send — and is not a cap pre-emption.
 *
 * ⚠ `existingGuestCount` IS A SERVER-RENDER SNAPSHOT, NOT A LIVE READ, so `capAdvisoryOnly` is
 * passed to `GuestInviteComposer`: its `atCap` warning still renders, but it no longer disables
 * the email input or the Add button. Without it, a guest removed since render opens the dialog
 * with the input already locked, with no round trip able to correct it short of a page refresh.
 * The two booking call sites never pass it — their `otherParticipantCount` is a literal `2` that
 * cannot go stale, so `atCap` there still blocks adding a draft exactly as shipped.
 */

export interface InviteColleagueDialogProps {
  open: boolean;
  onClose: () => void;
  /** Success. The caller closes, restores focus and `router.refresh()`es the row's count. */
  onInvited: () => void;
  meetingId: string;
  caseTitle: string;
  scheduledStartIso: string;
  ordinal: number | null;
  /** Live seats already held on this meeting; `RESERVED_BASE_PARTICIPANTS` is added below. */
  existingGuestCount: number;
  clientCompanyName: string | null;
  caseScopeDomains: readonly string[];
  /**
   * BAL-573 (F1) — which side of the case the viewer is on. COPY ONLY, never an authorization
   * input (CLAUDE.md / ADR-1029): it decides whether the composer's counter carries the "guests
   * don't change what you pay" clause, which is false on the expert lens (an expert pays nothing
   * here).
   */
  lens: 'client' | 'expert';
}

export function InviteColleagueDialog({
  open,
  onClose,
  onInvited,
  meetingId,
  caseTitle,
  scheduledStartIso,
  ordinal,
  existingGuestCount,
  clientCompanyName,
  caseScopeDomains,
  lens,
}: Readonly<InviteColleagueDialogProps>): React.JSX.Element {
  const isMobile = useIsMobile(768);
  const [drafts, setDrafts] = useState<readonly GuestDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetAndClose = useCallback(() => {
    setDrafts([]);
    setSubmitting(false);
    setError(null);
    onClose();
  }, [onClose]);

  const handleSend = useCallback(() => {
    if (drafts.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);

    (async () => {
      const result = await inviteConsultationGuestsAction({
        meetingId,
        emails: drafts.map((draft) => draft.email),
      });

      if (!result.success) {
        // ⚠⚠ THE DIALOG STAYS OPEN AND THE DRAFTS SURVIVE — `participant_cap_reached` and
        // `guest_already_invited` are both fixed by editing the list, not by starting over.
        setError(result.error);
        setSubmitting(false);
        // ⚠ `outcome: 'failed'` also covers an expired session (`GUEST_ACTION_COPY.unauthenticated`)
        // — an expected condition the person is told about inline, not an exception to report.
        if (result.outcome === 'failed' && result.error !== GUEST_ACTION_COPY.unauthenticated) {
          Sentry.captureException(new Error(`invite failed: ${result.outcome}`));
        }
        return;
      }

      toast.success(result.invitedCount === 1 ? 'Invite sent.' : 'Invites sent.');
      setDrafts([]);
      setSubmitting(false);
      setError(null);
      onInvited();
    })().catch((thrown: unknown) => {
      setError('Something went wrong. Please try again.');
      Sentry.captureException(thrown);
      setSubmitting(false);
    });
  }, [drafts, submitting, meetingId, onInvited]);

  const sendDisabled = submitting || drafts.length === 0;

  const body = (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="text-foreground text-base font-semibold">Invite a colleague</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {caseTitle} · consultation on{' '}
          <LocalDateTime iso={scheduledStartIso} variant="day-month-time" />
        </p>
      </div>

      <fieldset disabled={submitting} className="contents">
        <GuestInviteComposer
          guests={drafts}
          onChange={setDrafts}
          otherParticipantCount={RESERVED_BASE_PARTICIPANTS + existingGuestCount}
          viewerEmailDomain={null}
          caseAccessDomains={caseScopeDomains}
          clientCompanyName={clientCompanyName}
          accessScope="case"
          showPricingNote={lens === 'client'}
          capAdvisoryOnly
        />
      </fieldset>

      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={handleSend} disabled={sendDisabled}>
          {submitting ? 'Sending…' : 'Send invites'}
        </Button>
      </div>
    </div>
  );

  const consultationSuffix = ordinal === null ? '' : ` to consultation ${ordinal}`;
  const programmaticTitle = `Invite a colleague${consultationSuffix} — ${caseTitle}`;

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(next) => !next && resetAndClose()}>
        <SheetContent side="bottom" className="max-h-[94dvh] overflow-y-auto rounded-t-2xl p-0">
          <SheetTitle className="sr-only">{programmaticTitle}</SheetTitle>
          <SheetDescription className="sr-only">
            Invite someone to this consultation by email.
          </SheetDescription>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && resetAndClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-xl p-0 sm:max-w-[480px]">
        <DialogTitle className="sr-only">{programmaticTitle}</DialogTitle>
        <DialogDescription className="sr-only">
          Invite someone to this consultation by email.
        </DialogDescription>
        {body}
      </DialogContent>
    </Dialog>
  );
}
