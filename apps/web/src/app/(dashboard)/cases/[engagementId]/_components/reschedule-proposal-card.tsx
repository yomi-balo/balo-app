'use client';

import { useCallback, useId, useState } from 'react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { CalendarSync } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { formatLocalShortDate } from '@/lib/format/local-date';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import { isTerminalProposalFailure } from '@/lib/meetings/is-terminal-proposal-failure';
import type { CaseRescheduleProposalView } from '@/lib/cases/case-view-types';
import type { RescheduleProposalFailureCode } from '../_actions/_types/case-action-types';
import {
  acceptRescheduleProposalAction,
  declineRescheduleProposalAction,
} from '../_actions/respond-to-reschedule-proposal';
import { withdrawRescheduleProposalAction } from '../_actions/propose-reschedule';

/** The shape `declineRescheduleProposalAction` and `withdrawRescheduleProposalAction` both
 *  return — checked at the call site in `runSimpleProposalAnswer`, not asserted here. */
type SimpleProposalAnswerResult =
  | { success: true; proposalId: string }
  | { success: false; code: RescheduleProposalFailureCode; error: string };

/**
 * BAL-411 (§D7 / §D5) — the LIVE reschedule proposal, both lenses.
 *
 * ⚠⚠ Takes a plain `proposal: CaseRescheduleProposalView`; `case-surface.tsx` renders one card
 * per entry in `view.rescheduleProposals`, never derived from which meeting the nudge names.
 * The nudge above stays purely informational — this is where accept / decline / withdraw
 * actually happen.
 *
 * CLIENT lens: the ≤3 options as selectable rows + Accept / Keep my time (decline). The §D7
 * slot-lost re-prompt is CLIENT STATE ONLY — a dead option is marked disabled locally; nothing
 * is persisted (the slot could free up again, and persisting "this option is dead" would be a
 * write on what is otherwise a read path).
 *
 * EXPERT lens: "Waiting on {counterpartyLabel}" + the same three times, read-only + Withdraw.
 *
 * All four states (loading / empty / error / success) and a Sonner toast on every mutation
 * (CLAUDE.md). "Empty" does not apply here — the card only mounts when there IS a live
 * proposal to show.
 *
 * ⚠⚠ Two live proposals render identical cards and `aria-label`s unless anchored — accepting
 * the wrong one moves the wrong consultation. `subjectPrefix` / `sectionAriaLabel` below anchor
 * each card by `proposal.ordinal`, mirroring `CancelConsultationDialog`'s `subjectLine`.
 */

export interface RescheduleProposalCardProps {
  engagementId: string;
  lens: 'client' | 'expert';
  proposal: CaseRescheduleProposalView;
  /** The OTHER party's short name — the expert's first name (client lens) or the client
   *  company (expert lens). Same value `case-nudge.tsx` and `consultation-list.tsx` receive. */
  counterpartyLabel: string;
  /** Called after ANY successful mutation — the caller refreshes the page. */
  onChanged: () => void;
  /**
   * Fix round 1 item 18 (security LOW) — server-resolved (`view.lens === 'expert' &&
   * view.canManageReschedule`, the `manage_engagement` holder set). Gates the EXPERT lens's
   * Withdraw button so it is never shown to a legitimate viewer who can only ever have it fail
   * — an agency member with role `expert` (ADR-1046 §7: deliberately and permanently NOT a
   * `manage_engagement` holder). Ignored on the CLIENT lens, which has no Withdraw button.
   * The action re-checks independently; this is a render hint only, same posture as
   * `canProposeReschedule` on the sibling nudge CTA.
   */
  canManageReschedule: boolean;
}

function hoursBetween(fromIso: string, toIso: string): number {
  return Math.round(Math.abs(new Date(toIso).getTime() - new Date(fromIso).getTime()) / 3_600_000);
}

/** `ordinal === null` is structurally unreachable here (every card hosts an upcoming meeting)
 *  — kept as the honest, defensive fallback. Mirrors `subjectLine` in `cancel-consultation-dialog.tsx`. */
function subjectPrefix(ordinal: number | null): string {
  return ordinal === null ? '' : `Consultation ${ordinal} · `;
}

/** A plain integer, unlike a locale-formatted date, can't hydration-mismatch between server and
 *  client render — so `ordinal` alone is what's appended to keep two live proposals from
 *  announcing identically. */
function sectionAriaLabel(base: string, ordinal: number | null): string {
  return ordinal === null ? base : `${base} — consultation ${ordinal}`;
}

/** `proposedAtIso` is `string | null`, unreachable-null here (see `load-case.ts`'s
 *  `resolveRescheduleProposalViews`), so `0` is a defensive default, never a fabricated
 *  "since when". */
function hoursToRespond(proposedAtIso: string | null): number {
  return proposedAtIso === null ? 0 : hoursBetween(proposedAtIso, new Date().toISOString());
}

export function RescheduleProposalCard({
  engagementId,
  lens,
  proposal,
  counterpartyLabel,
  onChanged,
  canManageReschedule,
}: Readonly<RescheduleProposalCardProps>): React.JSX.Element {
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [deadOptionIds, setDeadOptionIds] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  // `case-surface.tsx` renders one card per live proposal; a shared literal `name` here would
  // put every mounted card's radios in the same native group (document-scoped), so selecting in
  // one silently unchecks another's DOM state.
  const radioGroupId = useId();

  const liveOptions = proposal.options.filter((option) => !deadOptionIds.has(option.optionId));
  // This toast/panel is client-only (never SSR'd), so the local-timezone short date has no
  // hydration-mismatch concern the way `LocalDateTime`'s own dual formatter guards against.
  const originalTimePhrase = `Your original time on ${formatLocalShortDate(proposal.originalScheduledStartIso)}`;

  const handleSelect = useCallback((optionId: string) => {
    setSelectedOptionId(optionId);
  }, []);

  const handleAccept = useCallback(() => {
    if (selectedOptionId === null || submitting) return;
    const optionId = selectedOptionId;
    setSubmitting(true);

    (async () => {
      const result = await acceptRescheduleProposalAction({
        engagementId,
        meetingId: proposal.meetingId,
        proposalId: proposal.proposalId,
        optionId,
      });

      if (!result.success) {
        if (result.code === 'slot_unavailable') {
          track(BOOKING_EVENTS.RESCHEDULE_PROPOSAL_SLOT_LOST, {
            proposal_id: proposal.proposalId,
            option_count: proposal.optionCount,
          });
          const stillLive = liveOptions.filter((option) => option.optionId !== optionId);
          setDeadOptionIds((prev) => new Set(prev).add(optionId));
          setSelectedOptionId(null);
          toast.error(
            stillLive.length > 0
              ? `That time was just taken. ${counterpartyLabel}'s other suggested times are still open — pick one, or keep your original time.`
              : `Those times are no longer free. ${originalTimePhrase} still stands — ${counterpartyLabel} can suggest new ones.`
          );
        } else {
          toast.error(result.error);
          if (isTerminalProposalFailure(result.code)) {
            // BAL-409's `copyForFailure`/`closeOnAcknowledge` precedent, carried over: the
            // state this card was rendered from is gone — refresh instead of re-offering a
            // dead Accept/Keep-my-time.
            setSubmitting(false);
            onChanged();
            return;
          }
        }
        setSubmitting(false);
        return;
      }

      track(BOOKING_EVENTS.RESCHEDULE_PROPOSAL_ANSWERED, {
        proposal_id: proposal.proposalId,
        outcome: 'accepted',
        hours_to_respond: hoursToRespond(proposal.proposedAtIso),
        option_count: proposal.optionCount,
      });
      // Item 8 — hours before the EXISTING start (notice given), matching what BAL-409's
      // `reschedule-dialog.tsx` fires on the same event for `initiated_by: 'client'`. The
      // NEW start would make an `initiated_by` split read as though experts reschedule with
      // far more notice than clients, when it is really measuring a different thing entirely.
      track(BOOKING_EVENTS.RESCHEDULED, {
        initiated_by: 'expert',
        hours_before_start: hoursBetween(
          new Date().toISOString(),
          proposal.originalScheduledStartIso
        ),
        // Committed by accepting a live proposal card, never the nudge's Reschedule button or
        // a row's menu.
        source: 'proposal',
      });
      toast.success('Consultation moved', {
        description: (
          <>
            New time: <LocalDateTime iso={result.scheduledStart} variant="day-month-time" />
          </>
        ),
      });
      setSubmitting(false);
      onChanged();
    })().catch((error: unknown) => {
      toast.error('Something went wrong. Please try again.');
      Sentry.captureException(error);
      setSubmitting(false);
    });
  }, [
    selectedOptionId,
    submitting,
    engagementId,
    proposal,
    liveOptions,
    counterpartyLabel,
    onChanged,
    originalTimePhrase,
  ]);

  // Fix round 2 item 4 — `handleDecline` and `handleWithdraw` were a byte-identical internal
  // self-duplication (same fire/submit/track/toast/onChanged shape), differing only in the
  // action called, the analytics `outcome`, and the success toast copy.
  const runSimpleProposalAnswer = useCallback(
    (
      action: (input: {
        engagementId: string;
        meetingId: string;
        proposalId: string;
      }) => Promise<SimpleProposalAnswerResult>,
      outcome: 'declined' | 'withdrawn',
      successMessage: string
    ) => {
      if (submitting) return;
      setSubmitting(true);

      (async () => {
        const result = await action({
          engagementId,
          meetingId: proposal.meetingId,
          proposalId: proposal.proposalId,
        });

        if (!result.success) {
          toast.error(result.error);
          setSubmitting(false);
          if (isTerminalProposalFailure(result.code)) {
            onChanged();
          }
          return;
        }

        track(BOOKING_EVENTS.RESCHEDULE_PROPOSAL_ANSWERED, {
          proposal_id: proposal.proposalId,
          outcome,
          hours_to_respond: hoursToRespond(proposal.proposedAtIso),
          option_count: proposal.optionCount,
        });
        toast.success(successMessage);
        setSubmitting(false);
        onChanged();
      })().catch((error: unknown) => {
        toast.error('Something went wrong. Please try again.');
        Sentry.captureException(error);
        setSubmitting(false);
      });
    },
    [submitting, engagementId, proposal, onChanged]
  );

  const handleDecline = useCallback(() => {
    runSimpleProposalAnswer(
      declineRescheduleProposalAction,
      'declined',
      'Your original time stands.'
    );
  }, [runSimpleProposalAnswer]);

  const handleWithdraw = useCallback(() => {
    runSimpleProposalAnswer(withdrawRescheduleProposalAction, 'withdrawn', 'Proposal withdrawn.');
  }, [runSimpleProposalAnswer]);

  if (lens === 'expert') {
    return (
      <section
        aria-label={sectionAriaLabel('Your reschedule proposal', proposal.ordinal)}
        className="bg-card border-border mt-3 rounded-xl border px-5 py-4"
      >
        <div className="flex items-center gap-2">
          <CalendarSync size={16} className="text-primary" aria-hidden="true" />
          <h3 className="text-foreground text-sm font-semibold">Waiting on {counterpartyLabel}</h3>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {subjectPrefix(proposal.ordinal)}currently{' '}
          <LocalDateTime iso={proposal.originalScheduledStartIso} variant="day-month-time" />
        </p>
        <ul className="mt-3 list-none space-y-2">
          {proposal.options.map((option) => (
            <li key={option.optionId} className="border-border rounded-lg border px-3 py-2 text-sm">
              <LocalDateTime
                iso={option.scheduledStartIso}
                variant="day-month-time-range"
                durationMinutes={proposal.durationMinutes}
              />
            </li>
          ))}
        </ul>
        {/* Item 18 — gated on the server-resolved `manage_engagement` holder set, not
            `lens === 'expert'` alone: an "absent action beats a dead one" (§D7's own rule) —
            an agency member with role `expert` legitimately reads this surface but is
            deliberately and permanently NOT a holder (ADR-1046 §7), so Withdraw would only
            ever fail for them. */}
        {canManageReschedule && (
          <div className="mt-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleWithdraw}
              disabled={submitting}
            >
              {submitting ? 'Withdrawing…' : 'Withdraw'}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      aria-label={sectionAriaLabel('Reschedule proposal', proposal.ordinal)}
      className="bg-card border-border mt-3 rounded-xl border px-5 py-4"
    >
      {/* Item 14 — the NUDGE above already carries the headline ("{counterparty} suggested
          some new times") and the deadline ("Reply by …"); this card carries only the options
          and the CTAs, so its own heading names what THIS card is for instead of repeating the
          nudge's sentence a second time on the same screen. */}
      <div className="flex items-center gap-2">
        <CalendarSync size={16} className="text-primary" aria-hidden="true" />
        <h3 className="text-foreground text-sm font-semibold">Pick a new time</h3>
      </div>
      <p className="text-muted-foreground mt-0.5 text-xs">
        {subjectPrefix(proposal.ordinal)}currently{' '}
        <LocalDateTime iso={proposal.originalScheduledStartIso} variant="day-month-time" />
      </p>

      {liveOptions.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          Those times are no longer free. {originalTimePhrase} still stands — {counterpartyLabel}{' '}
          can suggest new ones.
        </p>
      ) : (
        <fieldset className="mt-3">
          <legend className="sr-only">Choose a new time</legend>
          <div className="space-y-2">
            {proposal.options.map((option) => {
              const isDead = deadOptionIds.has(option.optionId);
              return (
                <label
                  key={option.optionId}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    isDead
                      ? 'border-border text-muted-foreground cursor-not-allowed opacity-60'
                      : 'border-border cursor-pointer'
                  }`}
                >
                  {/* CONSIDER item — the one un-tokenized control on an otherwise fully
                      tokenized card; `accent-primary` ties its checked-state colour to the
                      design system instead of the browser default. */}
                  <input
                    type="radio"
                    name={radioGroupId}
                    value={option.optionId}
                    disabled={isDead || submitting}
                    checked={selectedOptionId === option.optionId}
                    onChange={() => handleSelect(option.optionId)}
                    className="accent-primary"
                  />
                  <LocalDateTime
                    iso={option.scheduledStartIso}
                    variant="day-month-time-range"
                    durationMinutes={proposal.durationMinutes}
                  />
                  {isDead && <span className="text-xs">no longer free</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="mt-3 flex gap-2">
        {/* CONSIDER item — §D7: once every option is dead, the only remaining CTA is "Keep my
            time"; a disabled Accept that can never succeed again is a dead action, and
            `case-nudge.test.tsx`'s own rule is "an absent action beats a dead one". */}
        {liveOptions.length > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={handleAccept}
            disabled={submitting || selectedOptionId === null}
          >
            {submitting ? 'Moving…' : 'Accept'}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleDecline}
          disabled={submitting}
        >
          Keep my time
        </Button>
      </div>
    </section>
  );
}
