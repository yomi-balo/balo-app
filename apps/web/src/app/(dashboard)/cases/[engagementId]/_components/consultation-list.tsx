'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarClock,
  CircleSlash,
  Clock,
  FileText,
  Paperclip,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import type {
  CaseConsultationRowView,
  CaseConsultationStateLabel,
} from '@/lib/cases/case-view-types';

/**
 * BAL-421 — the consultation list.
 *
 * ⚠⚠ THERE IS NO EMPTY STATE, AND THAT IS CORRECT RATHER THAN AN OMISSION. Booking is what
 * CREATES a case (BAL-400), and a cancelled consultation is MARKED, never deleted — so a case
 * that exists always has at least one row. An empty variant would be unreachable copy.
 *
 * ⚠ NEWEST LAST. The list reads as a story of the case, which is the opposite of the Files
 * card's newest-first. Both orderings are applied SERVER-SIDE; this component never sorts.
 *
 * ⚠ NO MONEY IN ANY ROW (owner decision, 2026-07-31): no per-consultation charge, and no
 * client-lens running total anywhere on this surface. Money lives on the recap, the receipt
 * and billing history. `durationMinutes` stays because it is about the WORK, not the bill.
 */
export function ConsultationList({
  consultations,
  lens,
  counterpartyLabel,
}: Readonly<{
  consultations: readonly CaseConsultationRowView[];
  lens: 'client' | 'expert';
  counterpartyLabel: string;
}>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-3xl border px-5 py-4">
      <SectionHead
        icon={Clock}
        title="Consultations"
        meta={`${consultations.length} · newest last`}
      />
      <ul className="list-none">
        {consultations.map((row, index) => (
          <li key={row.meetingId}>
            <ConsultationRow
              row={row}
              lens={lens}
              counterpartyLabel={counterpartyLabel}
              last={index === consultations.length - 1}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Per-state presentation, as a LOOKUP rather than a chain of ternaries (SonarCloud).
 *
 * ⚠⚠ `no_show_client` AND `missed_call` ARE SEPARATE ENTRIES WITH DIFFERENT COPY. They are
 * genuinely different events — `no_show_client` means the expert waited and nobody
 * client-side arrived; `missed_call` means THE EXPERT NEVER JOINED (`meetingOutcomeEnum`,
 * `enums.ts:611-613` — NOT "the call never connected", which reads as nobody's fault).
 * Folding them into one "not held" label would tell the wronged party that the call failed
 * without saying who failed to show, which is the single most load-bearing fact in the row.
 *
 * ⚠ `outcome_pending` IS REPRESENTABLE, NOT IMPOSSIBLE. `meeting_outcome_requires_ended` is
 * one-directional, so `ended` with a NULL outcome is legal. It renders neutrally rather than
 * being silently folded into `held`, which would misreport an unrecorded call as delivered.
 */
const STATE_PRESENTATION: Readonly<
  Record<CaseConsultationStateLabel, { icon: LucideIcon; muted: boolean }>
> = {
  scheduled: { icon: CalendarClock, muted: false },
  in_progress: { icon: Video, muted: false },
  held: { icon: Video, muted: false },
  no_show_client: { icon: CircleSlash, muted: true },
  missed_call: { icon: CircleSlash, muted: true },
  cancelled: { icon: CircleSlash, muted: true },
  outcome_pending: { icon: CircleSlash, muted: true },
};

/** The one line under the date. `null` ⇒ the row's indicators speak for it (the `held` case). */
function stateNote(
  state: CaseConsultationStateLabel,
  lens: 'client' | 'expert',
  counterpartyLabel: string
): string | null {
  switch (state) {
    case 'scheduled':
      return 'Upcoming · join link in your calendar';
    case 'in_progress':
      return 'Happening now';
    case 'cancelled':
      return 'Cancelled — nothing charged';
    case 'no_show_client':
      return lens === 'client'
        ? `${counterpartyLabel} waited — billed at the minimum`
        : "Client didn't join — settled at the minimum";
    case 'missed_call':
      // ⚠ `missed_call` = THE EXPERT NEVER JOINED (`meetingOutcomeEnum`, `enums.ts:611-613`)
      // — the mirror image of `no_show_client`, so it is LENS-AWARE for the same reason.
      // Strings taken verbatim from the shipped recap (`resolve-recap-state.ts:178-185`) so
      // the two surfaces cannot drift, and they carry its two deliberate rules:
      //   · NON-SCOLDING — an expert reading their OWN `missed_call` is never told they
      //     failed, which is why the expert arm is impersonal, not "you didn't join".
      //   · NO MONEY PROSE — the recap DELETED it rather than reworded it (there is no
      //     no-show-policy page to link to), and no settlement path reads `missed_call`
      //     today, so a "nothing was charged" line here would assert an unverified fact.
      //     This is why it reads asymmetrically against `no_show_client` above, which has a
      //     settled money story (BAL-412) and states it.
      return lens === 'client'
        ? `${counterpartyLabel} wasn't able to join`
        : "The call didn't start";
    case 'outcome_pending':
      return 'Outcome not recorded';
    default:
      return null;
  }
}

function ConsultationRow({
  row,
  lens,
  counterpartyLabel,
  last,
}: Readonly<{
  row: CaseConsultationRowView;
  lens: 'client' | 'expert';
  counterpartyLabel: string;
  last: boolean;
}>): React.JSX.Element {
  const onViewRecap = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'view_recap', lens });
  }, [lens]);

  const { icon: Icon, muted } = STATE_PRESENTATION[row.state];
  const note = stateNote(row.state, lens, counterpartyLabel);

  return (
    <div className={cn('flex items-start gap-3 py-3', last ? undefined : 'border-border border-b')}>
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
          muted ? 'bg-muted' : 'bg-primary/10'
        )}
      >
        <Icon size={14} className={muted ? 'text-muted-foreground' : 'text-primary'} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              'text-sm font-medium',
              muted ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {row.ordinal !== null && <span className="sr-only">Consultation {row.ordinal}: </span>}
            <LocalDateTime iso={row.scheduledStartIso} variant="day-month" />
          </span>
          {row.durationMinutes !== null && (
            <span className="text-muted-foreground text-xs">{row.durationMinutes} min</span>
          )}
        </div>

        {/* ⚠ THE RECAP LINK FOLLOWS `recapHref`, NOT `state === 'held'`. `recapHrefOf`
            deliberately emits a href for `cancelled` AND every terminal outcome, and the
            not-held panel it lands on (`resolveNotHeld`) is precisely where a no-show or
            missed call explains itself — including its money block. Gating the link on
            `held` stranded that panel with no route to it from the case. The CONTENT
            INDICATORS below stay under `held`: a transcript or file count on a call that
            never happened would promise artefacts that cannot exist. */}
        {(row.recapHref !== null || row.state === 'held') && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {row.recapHref !== null && (
              <Link
                href={row.recapHref}
                onClick={onViewRecap}
                className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
              >
                View recap <ArrowRight size={11} aria-hidden="true" />
              </Link>
            )}
            {/* ⚠ NO RECORDING INDICATOR. `hasRecording` is hard-false platform-wide (no
                recording exists anywhere — BAL-126 / BAL-140 own capture), so rendering one
                would be a promise of an artefact that does not exist. */}
            {row.state === 'held' && row.hasTranscript && (
              <Indicator icon={FileText} label="Transcript available" />
            )}
            {row.state === 'held' && row.fileCount > 0 && (
              <Indicator
                icon={Paperclip}
                label={`${row.fileCount} file${row.fileCount === 1 ? '' : 's'}`}
              />
            )}
            {row.state === 'held' && row.actionItemCount > 0 && (
              <span className="text-muted-foreground text-xs">
                {row.actionItemCount} action item{row.actionItemCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {note !== null && <p className="text-muted-foreground mt-0.5 text-xs">{note}</p>}
      </div>
    </div>
  );
}

/** A compact content indicator. The label is the ACCESSIBLE NAME, never a hover-only title. */
function Indicator({ icon: Icon, label }: Readonly<{ icon: LucideIcon; label: string }>) {
  return (
    <span className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs">
      <Icon size={11} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
