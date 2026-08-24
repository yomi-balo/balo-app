'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Reveal } from '@/components/balo/engagement/reveal';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { CaseSurfaceView } from '@/lib/cases/case-view-types';
import { RescheduleDialog } from '@/components/booking/reschedule-dialog';
import { ProposeTimesDialog } from '@/components/booking/propose-times-dialog';
import { resolveCaseAction } from '../_actions/resolve-case';
import { dismissResolutionRequestAction } from '../_actions/dismiss-resolution-request';
import { CaseHeader } from './case-header';
import { CaseNudge } from './case-nudge';
import { RescheduleProposalCard } from './reschedule-proposal-card';
import { CaseConversationPanel } from './case-conversation-panel';
import { ConsultationList } from './consultation-list';
import { CasePartyCard } from './case-party-card';
import { CaseActionItems } from './case-action-items';
import { CaseFilesCard } from './case-files-card';
import { CasePeopleCard } from './case-people-card';
import { MarkResolvedButton, RequestResolutionButton } from './case-actions';

/**
 * BAL-421 — the DESKTOP case surface.
 *
 * ⚠⚠ DESKTOP ONLY, AND THE MOBILE FOLLOW-UP MUST BE **PURE COMPOSITION** OVER THE SAME
 * `CaseSurfaceView`. `case-surface-mobile.jsx` is deliberately NOT implemented here, and a
 * desktop reflow is explicitly not accepted as a substitute (owner decision D1). Every
 * mobile-specific decision in that reference — the Details sheet with segmented tabs, the
 * always-visible expert strip, inline conversation expansion — is a re-arrangement of the
 * SAME view model. That is only true for as long as NO desktop-only field is introduced into
 * `CaseSurfaceView`, so: do not add one. Shape data in the loader, never in a component.
 *
 * ⚠ TWO COLUMNS BY WRAP, NOT BY BREAKPOINT (the design reference's `flex-wrap` + `flex-basis`).
 * The rail drops under the main column when the viewport cannot hold both, with no media query
 * to keep in sync.
 *
 * ⚠ THE LENS IS A DISCRIMINANT ALL THE WAY DOWN. The earnings block is not conditionally
 * hidden on the client arm — a client-lens view has no `earnings` FIELD to pass, so the
 * fee-concealment invariant is structural rather than a render-time `&&`.
 *
 * ⚠ `viewerEmailDomain` (UX-2, BAL-400 round 2) is SESSION-derived, passed in from `page.tsx`
 * (`getCurrentUser().email`) — never sourced from `view`, since `CasePartyView` structurally
 * excludes email. Optional/defaulted to `null` so the many existing render call-sites that
 * predate this prop keep compiling unchanged.
 */
export function CaseSurface({
  view,
  viewerEmailDomain = null,
}: Readonly<{ view: CaseSurfaceView; viewerEmailDomain?: string | null }>): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // BAL-409 — the reschedule dialog's open state, owned here exactly as `resolveCaseAction`'s
  // transition is: `case-nudge.tsx` stays a presentational renderer of one `CaseNudgeView`.
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // BAL-411 — the propose-times dialog's open state, owned the SAME way.
  const [proposeOpen, setProposeOpen] = useState(false);

  const counterpartyFirstName = view.conversation.counterpartyFirstName;

  // The nudge's two client-lens actions. Both live here rather than in the nudge so the nudge
  // stays a pure renderer of one `CaseNudgeView`.
  const handleMarkResolved = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'mark_resolved', lens: view.lens });
    startTransition(async () => {
      const result = await resolveCaseAction({ engagementId: view.engagementId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success('Case marked resolved.');
      router.refresh();
    });
  }, [router, view.engagementId, view.lens]);

  const handleDismissAsk = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'dismiss_resolution_request',
      lens: view.lens,
    });
    startTransition(async () => {
      const result = await dismissResolutionRequestAction({ engagementId: view.engagementId });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      // ⚠ NO SUCCESS TOAST. Dismissing is a QUIET act — it clears a banner, tells the expert
      // nothing, and changes no state the viewer came here for. A toast celebrating it would
      // be noise. The banner disappearing IS the confirmation.
      router.refresh();
    });
  }, [router, view.engagementId, view.lens]);

  const handleOpenReschedule = useCallback(() => {
    setRescheduleOpen(true);
  }, []);

  const handleRescheduled = useCallback(() => {
    setRescheduleOpen(false);
    router.refresh();
  }, [router]);

  const handleOpenPropose = useCallback(() => {
    setProposeOpen(true);
  }, []);

  const handleProposed = useCallback(() => {
    setProposeOpen(false);
    router.refresh();
  }, [router]);

  // BAL-411 — `RescheduleProposalCard`'s `onChanged`: no local dialog state to close, just a
  // refresh (accept/decline/withdraw all resolve to a page revalidate already; this covers the
  // client-side render before the next server round trip lands).
  const handleProposalChanged = useCallback(() => {
    router.refresh();
  }, [router]);

  // BAL-411 — read ONLY from the expert arm; the client arm has no `canProposeReschedule` field
  // to hold (the same discriminant-not-flag posture the whole view already follows).
  const canProposeReschedule = view.lens === 'expert' && view.canProposeReschedule;
  // Item 18 — same posture, for the Withdraw button's holder set (see `RescheduleProposalCard`).
  const canManageReschedule = view.lens === 'expert' && view.canManageReschedule;

  return (
    <div className="from-background to-muted/30 min-h-full bg-gradient-to-b">
      <div className="mx-auto w-full max-w-[1060px] px-4 py-8 sm:px-6 lg:px-8">
        <Reveal>
          <CaseHeader header={view.header} />
          <div className="px-6">
            <CaseNudge
              nudge={view.nudge}
              lens={view.lens}
              counterpartyLabel={counterpartyFirstName}
              bookAgainHref={view.party.bookAgainHref}
              onMarkResolved={handleMarkResolved}
              onDismissAsk={handleDismissAsk}
              onReschedule={handleOpenReschedule}
              canProposeReschedule={canProposeReschedule}
              onProposeReschedule={handleOpenPropose}
              busy={pending}
            />
            {/* BAL-411 — the ONE place accept/decline/withdraw actually happen; the nudge above
                is purely informational (see `case-nudge.tsx`'s own docblock). */}
            {view.nudge !== null &&
              (view.nudge.kind === 'reschedule_proposal' ||
                view.nudge.kind === 'reschedule_proposal_pending') && (
                <RescheduleProposalCard
                  engagementId={view.engagementId}
                  lens={view.lens}
                  nudge={view.nudge}
                  counterpartyLabel={counterpartyFirstName}
                  onChanged={handleProposalChanged}
                  canManageReschedule={canManageReschedule}
                />
              )}
          </div>
        </Reveal>

        {/* BAL-409 — mounted only when there is an upcoming meeting to move; `open` still
            gates rendering so the dialog's own data fetch never starts speculatively. */}
        {view.nudge !== null && view.nudge.kind === 'upcoming' && (
          <RescheduleDialog
            open={rescheduleOpen}
            onClose={() => setRescheduleOpen(false)}
            onRescheduled={handleRescheduled}
            // N14(c) — a TERMINAL failure (meeting_not_reschedulable / meeting_not_found) means
            // this nudge/CTA is now stale, exactly like a successful move does: close AND
            // refresh, reusing the same handler rather than a second near-identical one.
            onTerminalFailure={handleRescheduled}
            engagementId={view.engagementId}
            meetingId={view.nudge.meetingId}
            expertProfileId={view.expertProfileId}
            currentScheduledStartIso={view.nudge.scheduledStartIso}
            durationMinutes={view.nudge.durationMinutes}
            caseTitle={view.header.title}
          />
        )}

        {/* BAL-411 — the EXPERT's symmetrical dialog, same mount gate as `RescheduleDialog`
            (an `'upcoming'` nudge implies a meeting to propose against). */}
        {view.nudge !== null && view.nudge.kind === 'upcoming' && (
          <ProposeTimesDialog
            open={proposeOpen}
            onClose={() => setProposeOpen(false)}
            onProposed={handleProposed}
            engagementId={view.engagementId}
            meetingId={view.nudge.meetingId}
            expertProfileId={view.expertProfileId}
            currentScheduledStartIso={view.nudge.scheduledStartIso}
            durationMinutes={view.nudge.durationMinutes}
            caseTitle={view.header.title}
          />
        )}

        <div className="mt-3 flex flex-wrap items-start gap-3">
          {/* Main column — the conversation LEADS it. Between calls, the conversation is
              the case; the consultation list is the record of what has already happened. */}
          <div className="flex min-w-0 flex-col gap-3" style={{ flex: '1 1 420px' }}>
            <Reveal delay={0.05}>
              <CaseConversationPanel
                engagementId={view.engagementId}
                conversation={view.conversation}
                lens={view.lens}
                viewerUserId={view.viewerUserId}
              />
            </Reveal>
            <Reveal delay={0.1}>
              <ConsultationList
                consultations={view.consultations}
                lens={view.lens}
                counterpartyLabel={counterpartyFirstName}
              />
            </Reveal>
          </div>

          {/* Rail */}
          <div className="flex flex-col gap-3" style={{ flex: '0 1 288px', minWidth: 264 }}>
            <Reveal delay={0.15}>
              <CasePartyCard
                party={view.party}
                lens={view.lens}
                earnings={view.lens === 'expert' ? view.earnings : undefined}
                isOpen={view.header.isOpen}
                counterpartyFirstName={counterpartyFirstName}
                engagementId={view.engagementId}
                expertProfileId={view.expertProfileId}
                caseTitle={view.header.title}
                consultationCount={view.header.consultationCount}
                openedAtIso={view.header.openedAtIso}
                viewerEmailDomain={viewerEmailDomain}
              />
            </Reveal>
            <Reveal delay={0.2}>
              <CaseActionItems actionItems={view.actionItems} />
            </Reveal>
            <Reveal delay={0.25}>
              <CaseFilesCard
                engagementId={view.engagementId}
                files={view.files}
                truncated={view.filesTruncated}
                lens={view.lens}
                isOpen={view.header.isOpen}
                counterpartyFirstName={counterpartyFirstName}
              />
            </Reveal>
            <Reveal delay={0.3}>
              <CasePeopleCard people={view.people} />
              {/* ⚠ THE TWO LIFECYCLE ACTIONS RENDER ONLY WHEN THE VIEW SAYS THEY CAN. Both
                  flags are FALSE on a closed case, so a resolved case offers neither — and
                  neither is ever rendered disabled. */}
              {view.lens === 'client' && view.canClose && (
                <div className="mt-3">
                  <MarkResolvedButton engagementId={view.engagementId} />
                </div>
              )}
              {view.lens === 'expert' && view.canRequestResolution && (
                <div className="mt-3">
                  <RequestResolutionButton engagementId={view.engagementId} />
                </div>
              )}
            </Reveal>
          </div>
        </div>
      </div>
    </div>
  );
}
