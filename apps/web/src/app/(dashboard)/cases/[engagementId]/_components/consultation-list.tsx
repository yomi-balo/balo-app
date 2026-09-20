'use client';

import { useCallback } from 'react';
import type { RefObject } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarClock,
  CircleSlash,
  Clock,
  FileText,
  Paperclip,
  Users,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SectionHead } from '@/components/balo/section/section-states';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { useViewerClock } from '@/hooks/use-viewer-clock';
import { useAbsoluteConsultationTime } from '@/hooks/use-consultation-time-label';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type {
  CaseConsultationRowView,
  CaseConsultationStateLabel,
} from '@/lib/cases/case-view-types';
import {
  ConsultationRowMenu,
  type ConsultationRowActionVerb,
  type ConsultationRowTriggerSlot,
} from './consultation-row-menu';

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
  onRowAction,
  registerTrigger,
  headingRef,
}: Readonly<{
  consultations: readonly CaseConsultationRowView[];
  lens: 'client' | 'expert';
  counterpartyLabel: string;
  /** The slot names WHICH control fired, so a dialog can return focus to it rather than to a
   *  derived guess. */
  onRowAction: (
    verb: ConsultationRowActionVerb,
    row: CaseConsultationRowView,
    slot: ConsultationRowTriggerSlot
  ) => void;
  /** Keyed by `meetingId` AND the control's slot; `case-surface.tsx` uses it to restore focus
   *  to the control that opened a dialog after it closes without success. */
  registerTrigger: (
    meetingId: string,
    slot: ConsultationRowTriggerSlot,
    node: HTMLButtonElement | null
  ) => void;
  /** Forwarded to `SectionHead`, the focus target for a row-sourced cancel. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
}>): React.JSX.Element {
  /* ⚠ ONE CLOCK FOR THE WHOLE LIST, not a timer inside each date. Without a tick the relative
     labels decay: a case left open overnight keeps calling a call that is now today
     "Tomorrow at 9:00 am". `null` until mount, which is the absolute first paint. */
  const clock = useViewerClock();

  return (
    <section className="bg-card border-border rounded-xl border px-5 py-4">
      <SectionHead
        icon={Clock}
        title="Consultations"
        meta={`${consultations.length} · newest last`}
        headingRef={headingRef}
      />
      <ul className="list-none">
        {consultations.map((row, index) => (
          <li key={row.meetingId}>
            <ConsultationRow
              row={row}
              lens={lens}
              counterpartyLabel={counterpartyLabel}
              now={clock?.now}
              last={index === consultations.length - 1}
              onRowAction={onRowAction}
              registerTrigger={(slot, node) => registerTrigger(row.meetingId, slot, node)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The pill's colour, mapped to `Badge` variants below so the palette lives in one table.
 *
 * ⚠ Colour marks the exception, not the norm: most rows on a healthy case are `held`, so a
 * saturated tone there would bury the one row that needs attention. `held` stays the quietest
 * of the coloured tones.
 *
 * ⚠ `--destructive` is deliberately unused. A consultation that did not happen is a fact with a
 * settlement story, not an error, and red reads as blame on a surface both parties read about
 * themselves — see `stateLabel`. `cancelled` is not even `warning`: it is a supported action
 * used correctly.
 */
type StateTone = 'neutral' | 'muted' | 'primary' | 'info' | 'success' | 'warning';

const TONE_VARIANT: Readonly<
  Record<StateTone, 'outline' | 'secondary' | 'default' | 'info' | 'success' | 'warning'>
> = {
  neutral: 'outline',
  muted: 'secondary',
  primary: 'default',
  info: 'info',
  success: 'success',
  warning: 'warning',
};

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
  Record<CaseConsultationStateLabel, { icon: LucideIcon; muted: boolean; tone: StateTone }>
> = {
  scheduled: { icon: CalendarClock, muted: false, tone: 'neutral' },
  // BAL-411 — same icon/weight as `scheduled` (the booking still stands); `stateNote` below
  // carries the one distinguishing fact.
  pending_reschedule: { icon: CalendarClock, muted: false, tone: 'info' },
  in_progress: { icon: Video, muted: false, tone: 'primary' },
  held: { icon: Video, muted: false, tone: 'success' },
  no_show_client: { icon: CircleSlash, muted: true, tone: 'warning' },
  missed_call: { icon: CircleSlash, muted: true, tone: 'warning' },
  cancelled: { icon: CircleSlash, muted: true, tone: 'muted' },
  outcome_pending: { icon: CircleSlash, muted: true, tone: 'muted' },
};

/**
 * The states whose row is an APPOINTMENT rather than a record: these show a clock time and may
 * say "Today"/"Tomorrow".
 *
 * ⚠ Everything terminal keeps its absolute date — `local-date-time.tsx` rules that a case is a
 * record and never speaks in relative time, and a past call is exactly that record.
 */
const FORWARD_LOOKING: ReadonlySet<CaseConsultationStateLabel> = new Set([
  'scheduled',
  'pending_reschedule',
  'in_progress',
]);

/**
 * The pill's text, lens-aware for the two states where who-did-not-join is the load-bearing fact.
 *
 * ⚠ The two "did not join" states stay distinct, for the same reason `stateNote` keeps them
 * distinct: one means the CLIENT never arrived and the other the EXPERT, and one shared "Not
 * held" would tell the wronged party the call failed without saying who.
 *
 * ⚠ Never second person, and never name the reader as the one who failed — `stateNote`'s
 * `missed_call` arm is impersonal for exactly this reason. The party who missed it reads a
 * statement of the event; the other party reads who was absent.
 */
/** `pending_reschedule` deliberately keeps its own pill inside the join window too — its
 *  Cancel-only state there is a different reason than the join window. */
function stateLabel(
  state: CaseConsultationStateLabel,
  lens: 'client' | 'expert',
  live: boolean
): string {
  switch (state) {
    case 'scheduled':
      return live ? 'Starting soon' : 'Upcoming';
    case 'pending_reschedule':
      return 'New times proposed';
    case 'in_progress':
      return 'Live now';
    case 'held':
      return 'Held';
    case 'no_show_client':
      // The CLIENT never arrived: impersonal for the client, explicit for the expert.
      return lens === 'client' ? 'Not joined' : "Client didn't join";
    case 'missed_call':
      // The EXPERT never joined: impersonal for the expert, explicit for the client.
      return lens === 'expert' ? "Didn't start" : "Expert didn't join";
    case 'cancelled':
      return 'Cancelled';
    case 'outcome_pending':
      return 'Not recorded';
  }
}

/** The one line under the date. `null` ⇒ the row's indicators speak for it (the `held` case). */
function stateNote(
  state: CaseConsultationStateLabel,
  lens: 'client' | 'expert',
  counterpartyLabel: string
): string | null {
  switch (state) {
    case 'scheduled':
      return null;
    // BAL-411 — the original time still stands; the proposal card above the list is where
    // either side actually acts. This note only says WHY the badge differs from a plain
    // `scheduled` row — it never restates the option count or the deadline.
    case 'pending_reschedule':
      return lens === 'client'
        ? `${counterpartyLabel} suggested some new times — see above`
        : 'Waiting on a reply to your suggested times';
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
  now,
  last,
  onRowAction,
  registerTrigger,
}: Readonly<{
  row: CaseConsultationRowView;
  lens: 'client' | 'expert';
  counterpartyLabel: string;
  /** The list's ticking "now", or `undefined` before it resolves. */
  now: Date | undefined;
  last: boolean;
  onRowAction: (
    verb: ConsultationRowActionVerb,
    row: CaseConsultationRowView,
    slot: ConsultationRowTriggerSlot
  ) => void;
  registerTrigger: (slot: ConsultationRowTriggerSlot, node: HTMLButtonElement | null) => void;
}>): React.JSX.Element {
  const onViewRecap = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'view_recap', lens });
  }, [lens]);
  const onOpenInvite = useCallback(() => {
    onRowAction('invite', row, 'guests');
  }, [onRowAction, row]);

  const { icon: Icon, muted, tone } = STATE_PRESENTATION[row.state];
  const note = stateNote(row.state, lens, counterpartyLabel);
  // Held rows carry the ACTUAL length (`durationMinutes`); upcoming ones have none yet, so they
  // carry the BOOKED one instead. Every other state shows neither.
  const minutes =
    row.durationMinutes ?? (FORWARD_LOOKING.has(row.state) ? row.scheduledMinutes : null);
  const absoluteTime = useAbsoluteConsultationTime(row.scheduledStartIso);
  const guestText = `${row.guestCount} guest${row.guestCount === 1 ? '' : 's'}`;

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
            {/* ⚠ Time and relative day on appointments only — several calls booked on one day
                are otherwise indistinguishable. Past rows keep the compact date; the duration is
                already on the row and the recap carries the full timestamp. */}
            <LocalDateTime
              iso={row.scheduledStartIso}
              variant={FORWARD_LOOKING.has(row.state) ? 'day-month-time' : 'day-month'}
              relativeDays={FORWARD_LOOKING.has(row.state)}
              now={now}
            />
          </span>
          {minutes !== null && <span className="text-muted-foreground text-xs">{minutes} min</span>}
          {/* ⚠ Colour on the pill, not the row: shading whole rows turns the card into a stripe
              of tinted blocks and makes the row needing attention compete with its background. */}
          <Badge variant={TONE_VARIANT[tone]} className="text-[11px]">
            {stateLabel(row.state, lens, row.live)}
          </Badge>
        </div>

        {/* ⚠ THE RECAP LINK FOLLOWS `recapHref`, NOT `state === 'held'`. `recapHrefOf` emits a
            href for every terminal OUTCOME (no_show_client, missed_call, outcome_pending), so
            the not-held panel it lands on (`resolveNotHeld`) is reachable — but not for
            `cancelled`, whose recap has no money block or artifacts to show. CONTENT
            INDICATORS below still gate on `held`: a transcript or file count on a call that
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

        {/* BAL-573 — guest state takes the slot the retired `scheduled` note held, so an
            invitation is never invisible state behind a menu. ⚠ COUNT ONLY — ADR-1044: names
            may cross the party boundary, email addresses never do, and this row shows neither.
            A CONTROL when the viewer may invite, plain text when they may not: an absent action
            beats a dead one, and a disabled count would be a dead one. */}
        {row.guestCount > 0 && (
          <div className="mt-1.5">
            {row.canInvite ? (
              <button
                type="button"
                ref={(node) => registerTrigger('guests', node)}
                onClick={onOpenInvite}
                aria-label={`${guestText} invited to the consultation on ${absoluteTime} — manage`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded text-xs focus-visible:ring-2 focus-visible:outline-none"
              >
                <Users size={12} aria-hidden="true" /> {guestText}
              </button>
            ) : (
              <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
                <Users size={12} aria-hidden="true" /> {guestText}
              </span>
            )}
          </div>
        )}

        {note !== null && <p className="text-muted-foreground mt-0.5 text-xs">{note}</p>}
      </div>

      <ConsultationRowMenu
        row={row}
        onAction={onRowAction}
        registerTrigger={(node) => registerTrigger('menu', node)}
      />
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
