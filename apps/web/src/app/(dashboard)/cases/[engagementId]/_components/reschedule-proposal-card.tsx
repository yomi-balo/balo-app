'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import { CalendarSync } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { formatLocalShortDate } from '@/lib/format/local-date';
import { track, BOOKING_EVENTS } from '@/lib/analytics';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';
import { isTerminalProposalFailure } from '@/lib/meetings/is-terminal-proposal-failure';
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
 * ⚠⚠ THE NUDGE ABOVE IS PURELY INFORMATIONAL (`case-nudge.tsx`'s own docblock) — THIS is where
 * accept / decline / withdraw actually happen. "Pick one of up to three times" does not fit
 * the nudge's two-button shell the way `resolution_ask` does, so it gets its own card, mounted
 * by `case-surface.tsx` whenever `nudge.kind` is one of the two proposal kinds.
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
 */

type ProposalNudge = Extract<
  CaseNudgeView,
  { kind: 'reschedule_proposal' } | { kind: 'reschedule_proposal_pending' }
>;

export interface RescheduleProposalCardProps {
  engagementId: string;
  lens: 'client' | 'expert';
  nudge: ProposalNudge;
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

/**
 * Item 12 — `nudge.proposedAtIso` is `string | null` (the loader's honest type after the fix);
 * `null` there is structurally unreachable through this card (it only mounts on a nudge the
 * loader already backed with a real proposal DETAIL — see `load-case.ts`), so `0` here is a
 * defensive default, never a fabricated "since when" the way reading `expiresAtIso` was.
 */
function hoursToRespond(proposedAtIso: string | null): number {
  return proposedAtIso === null ? 0 : hoursBetween(proposedAtIso, new Date().toISOString());
}

export function RescheduleProposalCard({
  engagementId,
  lens,
  nudge,
  counterpartyLabel,
  onChanged,
  canManageReschedule,
}: Readonly<RescheduleProposalCardProps>): React.JSX.Element {
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [deadOptionIds, setDeadOptionIds] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const liveOptions = nudge.options.filter((option) => !deadOptionIds.has(option.optionId));
  // Item 8 — ONLY the `'reschedule_proposal'` (client-lens) arm carries this; Accept only ever
  // renders on that arm, so this is always defined when `handleAccept` actually reads it below.
  const originalScheduledStartIso =
    nudge.kind === 'reschedule_proposal' ? nudge.originalScheduledStartIso : null;
  // CONSIDER item — §D7's copy is "Your original time **on {date}** still stands"; the date
  // had been dropped even though `originalScheduledStartIso` was already on the wire with no
  // reader. Local-timezone short date — a toast/panel is CLIENT-rendered only, never SSR'd, so
  // there is no hydration-mismatch concern the way `LocalDateTime`'s own dual formatter guards
  // against.
  const originalTimePhrase =
    originalScheduledStartIso === null
      ? 'Your original time'
      : `Your original time on ${formatLocalShortDate(originalScheduledStartIso)}`;

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
        meetingId: nudge.meetingId,
        proposalId: nudge.proposalId,
        optionId,
      });

      if (!result.success) {
        if (result.code === 'slot_unavailable') {
          track(BOOKING_EVENTS.RESCHEDULE_PROPOSAL_SLOT_LOST, {
            proposal_id: nudge.proposalId,
            option_count: nudge.optionCount,
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
        proposal_id: nudge.proposalId,
        outcome: 'accepted',
        hours_to_respond: hoursToRespond(nudge.proposedAtIso),
        option_count: nudge.optionCount,
      });
      // Item 8 — hours before the EXISTING start (notice given), matching what BAL-409's
      // `reschedule-dialog.tsx` fires on the same event for `initiated_by: 'client'`. The
      // NEW start would make an `initiated_by` split read as though experts reschedule with
      // far more notice than clients, when it is really measuring a different thing entirely.
      if (originalScheduledStartIso !== null) {
        track(BOOKING_EVENTS.RESCHEDULED, {
          initiated_by: 'expert',
          hours_before_start: hoursBetween(new Date().toISOString(), originalScheduledStartIso),
        });
      }
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
    nudge,
    liveOptions,
    counterpartyLabel,
    onChanged,
    originalScheduledStartIso,
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
          meetingId: nudge.meetingId,
          proposalId: nudge.proposalId,
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
          proposal_id: nudge.proposalId,
          outcome,
          hours_to_respond: hoursToRespond(nudge.proposedAtIso),
          option_count: nudge.optionCount,
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
    [submitting, engagementId, nudge, onChanged]
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
        aria-label="Your reschedule proposal"
        className="bg-card border-border mt-3 rounded-3xl border px-5 py-4"
      >
        <div className="flex items-center gap-2">
          <CalendarSync size={16} className="text-primary" aria-hidden="true" />
          <h3 className="text-foreground text-sm font-semibold">Waiting on {counterpartyLabel}</h3>
        </div>
        <ul className="mt-3 list-none space-y-2">
          {nudge.options.map((option) => (
            <li key={option.optionId} className="border-border rounded-lg border px-3 py-2 text-sm">
              <LocalDateTime iso={option.scheduledStartIso} variant="day-month-time" />
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
      aria-label="Reschedule proposal"
      className="bg-card border-border mt-3 rounded-3xl border px-5 py-4"
    >
      {/* Item 14 — the NUDGE above already carries the headline ("{counterparty} suggested
          some new times") and the deadline ("Reply by …"); this card carries only the options
          and the CTAs, so its own heading names what THIS card is for instead of repeating the
          nudge's sentence a second time on the same screen. */}
      <div className="flex items-center gap-2">
        <CalendarSync size={16} className="text-primary" aria-hidden="true" />
        <h3 className="text-foreground text-sm font-semibold">Pick a new time</h3>
      </div>

      {liveOptions.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">
          Those times are no longer free. {originalTimePhrase} still stands — {counterpartyLabel}{' '}
          can suggest new ones.
        </p>
      ) : (
        <fieldset className="mt-3">
          <legend className="sr-only">Choose a new time</legend>
          <div className="space-y-2">
            {nudge.options.map((option) => {
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
                    name="reschedule-proposal-option"
                    value={option.optionId}
                    disabled={isDead || submitting}
                    checked={selectedOptionId === option.optionId}
                    onChange={() => handleSelect(option.optionId)}
                    className="accent-primary"
                  />
                  <LocalDateTime iso={option.scheduledStartIso} variant="day-month-time" />
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
