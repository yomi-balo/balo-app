'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Reveal } from '@/components/balo/engagement/reveal';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import type { CaseConsultationRowView, CaseSurfaceView } from '@/lib/cases/case-view-types';
import { RescheduleDialog } from '@/components/booking/reschedule-dialog';
import { ProposeTimesDialog } from '@/components/booking/propose-times-dialog';
import { CancelConsultationDialog } from '@/components/booking/cancel-consultation-dialog';
import { InviteColleagueDialog } from '@/components/booking/invite-colleague-dialog';
import { resolveCaseAction } from '../_actions/resolve-case';
import { dismissResolutionRequestAction } from '../_actions/dismiss-resolution-request';
import { CaseHeader } from './case-header';
import { CaseNudge } from './case-nudge';
import { RescheduleProposalCard } from './reschedule-proposal-card';
import { CaseConversationPanel } from './case-conversation-panel';
import { ConsultationList } from './consultation-list';
import type {
  ConsultationRowActionVerb,
  ConsultationRowTriggerSlot,
} from './consultation-row-menu';
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

/**
 * Exactly one of the four verbs, carrying everything the matching dialog needs — never
 * re-read from `view`, so a dialog opened from row #3 can't end up showing row #1's data.
 */
export type ConsultationActionSelection =
  | {
      verb: 'cancel';
      source: 'nudge' | 'row';
      meetingId: string;
      scheduledStartIso: string;
      scheduledMinutes: number;
      ordinal: number | null;
      /** Sourced per-selection from the SAME row, never `view.nudge`. */
      canReschedule: boolean;
      canProposeReschedule: boolean;
      isPendingReschedule: boolean;
    }
  | {
      verb: 'reschedule';
      source: 'nudge' | 'row';
      meetingId: string;
      scheduledStartIso: string;
      scheduledMinutes: number;
      ordinal: number | null;
    }
  | {
      verb: 'propose';
      source: 'nudge' | 'row';
      meetingId: string;
      scheduledStartIso: string;
      scheduledMinutes: number;
      ordinal: number | null;
    }
  | {
      verb: 'invite';
      source: 'row';
      /** WHICH control opened it, so focus returns to that one and not the other. */
      triggerSlot: ConsultationRowTriggerSlot;
      meetingId: string;
      scheduledStartIso: string;
      scheduledMinutes: number;
      ordinal: number | null;
      /** The row's live seat count, for the composer's "{n} of 10". ⚠ Never re-read from `view`. */
      guestCount: number;
    };

/** A fresh `[]` in JSX would re-render the composer every paint. */
const EMPTY_SCOPE_DOMAINS: readonly string[] = [];

/**
 * BAL-573 — routes focus back to whichever row control opened the dialog for `selection`.
 * `source: 'row'` is required (a `'nudge'`-opened dialog has no row trigger to return to); the
 * slot is the row's kebab for every verb except `invite`, which remembers which of its two
 * triggers — the kebab or the guest-count control — opened it.
 */
function focusRowTrigger(
  selection: ConsultationActionSelection | null,
  focusTrigger: (meetingId: string, slot?: ConsultationRowTriggerSlot) => void
): void {
  if (selection === null || selection.source !== 'row') return;
  focusTrigger(selection.meetingId, selection.verb === 'invite' ? selection.triggerSlot : 'menu');
}

export function CaseSurface({
  view,
  viewerEmailDomain = null,
}: Readonly<{ view: CaseSurfaceView; viewerEmailDomain?: string | null }>): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Retained after close so the exiting dialog keeps its subject through the close animation;
  // `dialogOpen` alone drives visibility.
  const [selection, setSelection] = useState<ConsultationActionSelection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Keyed by `meetingId#slot` so a closed dialog can restore focus to the control that opened
  // it — the row's own `DropdownMenu` has already unmounted by then, so Radix's own
  // focus-return has nothing to fire into, and a row can now have TWO triggers (the kebab and
  // the guest-count control).
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const registerTrigger = useCallback(
    (meetingId: string, slot: ConsultationRowTriggerSlot, node: HTMLButtonElement | null) => {
      const key = `${meetingId}#${slot}`;
      if (node) {
        triggerRefs.current.set(key, node);
      } else {
        triggerRefs.current.delete(key);
      }
    },
    []
  );
  const focusTrigger = useCallback(
    (meetingId: string, slot: ConsultationRowTriggerSlot = 'menu') => {
      // Deferred a frame: the node may be re-registering (a re-render landed new props on the
      // same row) at the instant the dialog's own callback fires.
      requestAnimationFrame(() => {
        triggerRefs.current.get(`${meetingId}#${slot}`)?.focus();
      });
    },
    []
  );

  // `SectionHead` only becomes a focus target when this ref is supplied.
  const consultationsHeadingRef = useRef<HTMLHeadingElement>(null);

  // Refresh-on-focus, not periodic polling: `router.refresh()` already runs from four existing
  // handlers here, and the conversation composer's draft is local `useState`, so a focus
  // refresh can't clobber a half-typed message.
  useRefreshOnFocus();

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

  // `selectNextScheduled` and `mapCaseConsultations` draw from the same `meetings` list, so
  // this lookup is never structurally empty in practice; the `?? …` fallbacks are defensive only.
  const nudgeMeetingId =
    view.nudge !== null && view.nudge.kind === 'upcoming' ? view.nudge.meetingId : null;
  const nudgeRow =
    nudgeMeetingId === null
      ? null
      : (view.consultations.find((row) => row.meetingId === nudgeMeetingId) ?? null);

  const handleOpenReschedule = useCallback(() => {
    if (view.nudge === null || view.nudge.kind !== 'upcoming') return;
    setSelection({
      verb: 'reschedule',
      source: 'nudge',
      meetingId: view.nudge.meetingId,
      scheduledStartIso: view.nudge.scheduledStartIso,
      scheduledMinutes: nudgeRow?.scheduledMinutes ?? view.nudge.durationMinutes,
      ordinal: nudgeRow?.ordinal ?? null,
    });
    setDialogOpen(true);
  }, [view.nudge, nudgeRow]);

  const handleOpenPropose = useCallback(() => {
    if (view.nudge === null || view.nudge.kind !== 'upcoming') return;
    setSelection({
      verb: 'propose',
      source: 'nudge',
      meetingId: view.nudge.meetingId,
      scheduledStartIso: view.nudge.scheduledStartIso,
      scheduledMinutes: nudgeRow?.scheduledMinutes ?? view.nudge.durationMinutes,
      ordinal: nudgeRow?.ordinal ?? null,
    });
    setDialogOpen(true);
  }, [view.nudge, nudgeRow]);

  const handleRowAction = useCallback(
    (
      verb: ConsultationRowActionVerb,
      row: CaseConsultationRowView,
      slot: ConsultationRowTriggerSlot
    ) => {
      const shared = {
        source: 'row' as const,
        meetingId: row.meetingId,
        scheduledStartIso: row.scheduledStartIso,
        scheduledMinutes: row.scheduledMinutes,
        ordinal: row.ordinal,
      };
      if (verb === 'invite') {
        track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'invite', lens: view.lens });
        setSelection({
          verb: 'invite',
          ...shared,
          triggerSlot: slot,
          guestCount: row.guestCount,
        });
        setDialogOpen(true);
        return;
      }
      if (verb === 'cancel') {
        setSelection({
          verb: 'cancel',
          ...shared,
          canReschedule: row.canReschedule,
          canProposeReschedule: row.canProposeReschedule,
          isPendingReschedule: row.state === 'pending_reschedule',
        });
      } else if (verb === 'reschedule') {
        setSelection({ verb: 'reschedule', ...shared });
      } else {
        setSelection({ verb: 'propose', ...shared });
      }
      setDialogOpen(true);
    },
    [view.lens]
  );

  /** The cancel dialog's "Reschedule instead" / "Propose a new time". Re-keys the CURRENT
   *  selection in place; `dialogOpen` stays `true` throughout, so this is a straight component
   *  swap (`CancelConsultationDialog` unmounts, `RescheduleDialog`/`ProposeTimesDialog`
   *  mounts), not a close-then-reopen. */
  const handleMoveFromCancel = useCallback(
    (verb: 'reschedule' | 'propose') => {
      if (selection === null || selection.verb !== 'cancel') return;
      const { meetingId, scheduledStartIso, scheduledMinutes, ordinal, source } = selection;
      setSelection({ verb, source, meetingId, scheduledStartIso, scheduledMinutes, ordinal });
    },
    [selection]
  );

  /** Dismissal without success. `selection` is guaranteed non-null: this only ever fires from
   *  a mounted dialog, and a dialog only mounts when `selection` names it. A `source: 'nudge'`
   *  open has no row trigger to return to — sending focus to the row's kebab would move it
   *  (and possibly scroll) to a control the user never interacted with. */
  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    focusRowTrigger(selection, focusTrigger);
  }, [selection, focusTrigger]);

  /**
   * Cancel success, and every terminal failure. The selection's trigger is either gone (a
   * successful cancel) or untrustworthy (a 409), so focus goes to the section heading instead.
   */
  const closeAndFocusHeading = useCallback(() => {
    setDialogOpen(false);
    consultationsHeadingRef.current?.focus();
    router.refresh();
  }, [router]);

  /** Reschedule success. The row stays mounted (same `meetingId`, only the schedule changed),
   *  so focus returns to the trigger rather than the heading — but only for `source: 'row'`; a
   *  nudge-opened dialog has no row trigger the user came from. */
  const handleRescheduled = useCallback(() => {
    setDialogOpen(false);
    focusRowTrigger(selection, focusTrigger);
    router.refresh();
  }, [selection, focusTrigger, router]);

  /** Propose success (and its terminal failures — `propose-times-dialog.tsx` shares one
   *  callback for both). The row survives either way, so the trigger is the right target for a
   *  `source: 'row'` open; a nudge-opened dialog has no row trigger to return to. */
  const handleProposed = useCallback(() => {
    setDialogOpen(false);
    focusRowTrigger(selection, focusTrigger);
    router.refresh();
  }, [selection, focusTrigger, router]);

  /** BAL-573 — invite success. Mirrors `handleRescheduled`: close, focus the trigger that
   *  opened the dialog, and `router.refresh()` — which is what updates the row's guest count. */
  const handleInvited = useCallback(() => {
    setDialogOpen(false);
    // `verb: 'invite'` only ever carries `source: 'row'` (see the type above), so
    // `focusRowTrigger` resolves to `selection.triggerSlot`, the same slot this handler acts on.
    focusRowTrigger(selection, focusTrigger);
    router.refresh();
  }, [selection, focusTrigger, router]);

  // BAL-411 — `RescheduleProposalCard`'s `onChanged`: no local dialog state to close, just a
  // refresh (accept/decline/withdraw all resolve to a page revalidate already; this covers the
  // client-side render before the next server round trip lands).
  const handleProposalChanged = useCallback(() => {
    router.refresh();
  }, [router]);

  const canProposeReschedule = nudgeRow?.canProposeReschedule ?? false;
  // Item 18 — same posture, for the Withdraw button's holder set (see `RescheduleProposalCard`).
  const canManageReschedule = view.lens === 'expert' && view.canManageReschedule;

  return (
    <div className="from-background to-muted/30 min-h-full bg-gradient-to-b">
      <div className="mx-auto w-full max-w-[1060px] px-4 py-8 sm:px-6 lg:px-8">
        <Reveal>
          <CaseHeader header={view.header} />
          {/* ⚠ No horizontal padding: these are peer cards and belong on the same vertical
              edges as every other card on the surface. */}
          <div>
            <CaseNudge
              nudge={view.nudge}
              lens={view.lens}
              counterpartyLabel={counterpartyFirstName}
              bookAgainHref={view.party.bookAgainHref}
              onMarkResolved={handleMarkResolved}
              onDismissAsk={handleDismissAsk}
              canReschedule={nudgeRow?.canReschedule ?? false}
              onReschedule={handleOpenReschedule}
              canProposeReschedule={canProposeReschedule}
              onProposeReschedule={handleOpenPropose}
              busy={pending}
            />
            {view.rescheduleProposals.map((proposal) => (
              <RescheduleProposalCard
                key={proposal.meetingId}
                engagementId={view.engagementId}
                lens={view.lens}
                proposal={proposal}
                counterpartyLabel={counterpartyFirstName}
                onChanged={handleProposalChanged}
                canManageReschedule={canManageReschedule}
              />
            ))}
          </div>
        </Reveal>

        {selection !== null && selection.verb === 'reschedule' && (
          <RescheduleDialog
            // Forces a full remount per meeting — the dialog otherwise stays mounted across a
            // row-to-row swap, and its own `pickerView`/availability state (owned inside
            // `useSuggestedTimesPicker`) is reset only on a DISMISSED close, never on a
            // successful one. See `use-suggested-times-picker.ts`.
            key={selection.meetingId}
            open={dialogOpen}
            onClose={handleDialogClose}
            onRescheduled={handleRescheduled}
            onTerminalFailure={closeAndFocusHeading}
            engagementId={view.engagementId}
            meetingId={selection.meetingId}
            expertProfileId={view.expertProfileId}
            currentScheduledStartIso={selection.scheduledStartIso}
            durationMinutes={selection.scheduledMinutes}
            caseTitle={view.header.title}
            ordinal={selection.ordinal}
            source={selection.source}
            // The deterministic `onCloseAutoFocus` target for this dialog's terminal close;
            // see `RescheduleDialog`'s module docblock.
            headingRef={consultationsHeadingRef}
          />
        )}

        {selection !== null && selection.verb === 'cancel' && (
          <CancelConsultationDialog
            key={selection.meetingId}
            open={dialogOpen}
            onClose={handleDialogClose}
            onCancelled={closeAndFocusHeading}
            onTerminalFailure={closeAndFocusHeading}
            onMoveInstead={handleMoveFromCancel}
            lens={view.lens}
            engagementId={view.engagementId}
            meetingId={selection.meetingId}
            // ⚠⚠ THE PARTY LABEL, NOT `counterpartyFirstName` — the one register this dialog's
            // prospective copy ("… will see the slot open up again") must NOT take. CLAUDE.md's
            // attribution-by-tense rule names the PARTY there: the agency for an agency-delivered
            // case (a client who booked through CloudPeak may never have been told the expert is
            // Alex), the person's own name only when the expert is independent.
            // `counterpartyPartyLabel` is resolved server-side from the SAME
            // `expertPartyDisplayName` the cancellation email uses, so the dialog and the email
            // cannot disagree. `counterpartyFirstName` is passed alongside it for the ONE
            // retrospective sentence (a live proposal's "who suggested it") that does take the
            // person.
            counterpartyLabel={view.counterpartyPartyLabel}
            counterpartyFirstName={counterpartyFirstName}
            scheduledStartIso={selection.scheduledStartIso}
            ordinal={selection.ordinal}
            scheduledMinutes={selection.scheduledMinutes}
            source={selection.source}
            canReschedule={selection.canReschedule}
            canProposeReschedule={selection.canProposeReschedule}
            isPendingReschedule={selection.isPendingReschedule}
            // The deterministic `onCloseAutoFocus` target for this dialog's terminal closes.
            headingRef={consultationsHeadingRef}
          />
        )}

        {selection !== null && selection.verb === 'propose' && (
          <ProposeTimesDialog
            key={selection.meetingId}
            open={dialogOpen}
            onClose={handleDialogClose}
            onProposed={handleProposed}
            // A terminal failure can leave the row unmounted, so it must not silently no-op
            // through `focusTrigger`.
            onTerminalFailure={closeAndFocusHeading}
            engagementId={view.engagementId}
            meetingId={selection.meetingId}
            expertProfileId={view.expertProfileId}
            currentScheduledStartIso={selection.scheduledStartIso}
            durationMinutes={selection.scheduledMinutes}
            caseTitle={view.header.title}
            ordinal={selection.ordinal}
            // The deterministic `onCloseAutoFocus` target for this dialog's terminal closes.
            headingRef={consultationsHeadingRef}
          />
        )}

        {selection !== null && selection.verb === 'invite' && (
          <InviteColleagueDialog
            key={selection.meetingId}
            open={dialogOpen}
            onClose={handleDialogClose}
            onInvited={handleInvited}
            meetingId={selection.meetingId}
            caseTitle={view.header.title}
            scheduledStartIso={selection.scheduledStartIso}
            ordinal={selection.ordinal}
            existingGuestCount={selection.guestCount}
            clientCompanyName={view.clientCompanyName}
            // ⚠ COPY, NOT AUTHORIZATION (CLAUDE.md allows `lens` to gate the VIEW, never the
            // mutation). `resolveGuestAccessScope` step (2) widens a grant only for a
            // CLIENT-side inviter, so on the expert lens nothing the viewer types can widen
            // anything and the composer must not say it can.
            caseScopeDomains={view.lens === 'client' ? view.caseScopeDomains : EMPTY_SCOPE_DOMAINS}
            lens={view.lens}
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
                onRowAction={handleRowAction}
                registerTrigger={registerTrigger}
                headingRef={consultationsHeadingRef}
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
              <CasePeopleCard
                people={view.people}
                lens={view.lens}
                clientCompanyName={view.clientCompanyName}
                hasCaseScopeDomains={view.lens === 'client' && view.caseScopeDomains.length > 0}
              />
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
