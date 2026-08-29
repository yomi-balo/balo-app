'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CalendarSync, MessageSquare, Sparkles, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — EXACTLY ONE nudge, chosen server-side by `selectCaseNudge`. This component only
 * renders what it is given; it never re-derives priority, because a second copy of that
 * ordering is a second place the "ask is suppressed while anything is booked" rule lives.
 *
 * ⚠⚠ THERE IS NO "JOIN NOW" BUTTON, AND ITS ABSENCE IS DELIBERATE. The design reference draws
 * a pulsing brand-blue Join CTA — but there is NO participant join route on `main`.
 * `/join/[token]` is a GUEST token landing (it resolves an identity claim from a ≥256-bit
 * token), and there is no `/meetings/{id}/join` for an authenticated participant; BAL-132 /
 * BAL-435 own that surface. Rendering the button would be a link to nowhere, and a disabled
 * one is worse than an absent one. The copy carries the honest instruction instead — the join
 * link is in the viewer's calendar — and the live DOT still renders, because "this is
 * happening now" is true and useful on its own. When the join route lands, this is one
 * `<Button asChild>` away.
 *
 * ⚠ THE RESCHEDULE CTA (BAL-409) IS CLIENT-INITIATED AND AUTO-APPROVES — it needs NO proposal
 * state (the slot was already offered on the expert's live availability), so it lands here on
 * the `'upcoming'` arm.
 *
 * ⚠ BAL-411 — the EXPERT gets a SYMMETRICAL CTA on the SAME `'upcoming'` arm: "Propose a new
 * time", gated on `canProposeReschedule` (server-resolved: open case, an upcoming meeting, no
 * proposal already outstanding, and the engagement-axis capability). It opens
 * `ProposeTimesDialog`, owned by `case-surface.tsx` exactly as `RescheduleDialog`'s open state
 * is. The two new `reschedule_proposal` / `reschedule_proposal_pending` nudge kinds below are
 * PURELY INFORMATIONAL — the actual accept/decline/withdraw affordances live on
 * `RescheduleProposalCard`, mounted alongside this nudge, because "pick one of up to three
 * times" does not fit the nudge's two-button shell the way `resolution_ask` does.
 */

interface CaseNudgeProps {
  nudge: CaseNudgeView;
  lens: 'client' | 'expert';
  /** The other party's short name — the expert's first name, or the client company. */
  counterpartyLabel: string;
  /** `/experts/{username}`, or `null` ⇒ the booking CTA does not render. */
  bookAgainHref: string | null;
  onMarkResolved: () => void;
  onDismissAsk: () => void;
  /** BAL-409 — opens the reschedule dialog. Presentational only: `case-surface.tsx` owns the
   *  dialog's open state, exactly as it owns `resolveCaseAction`'s transition. */
  onReschedule: () => void;
  /** BAL-411 — EXPERT lens only. Whether "Propose a new time" renders at all — server-resolved
   *  (`canProposeReschedule`), never derived here. */
  canProposeReschedule: boolean;
  /** BAL-411 — opens `ProposeTimesDialog`. Presentational only, mirroring `onReschedule`. */
  onProposeReschedule: () => void;
  /** BAL-410 — BOTH lenses. Whether "Cancel" renders at all — server-resolved
   *  (`canCancelConsultation`, on two different axes by lens), never derived here. */
  canCancel: boolean;
  /** BAL-410 — opens `CancelConsultationDialog`. Presentational only, mirroring `onReschedule`. */
  onCancel: () => void;
  /** True while the close/dismiss mutation is in flight. */
  busy: boolean;
}

export function CaseNudge({
  nudge,
  lens,
  counterpartyLabel,
  bookAgainHref,
  onMarkResolved,
  onDismissAsk,
  onReschedule,
  canProposeReschedule,
  onProposeReschedule,
  canCancel,
  onCancel,
  busy,
}: Readonly<CaseNudgeProps>): React.JSX.Element | null {
  if (nudge === null) {
    return null;
  }
  if (nudge.kind === 'upcoming') {
    return (
      <UpcomingNudge
        nudge={nudge}
        lens={lens}
        counterpartyLabel={counterpartyLabel}
        canProposeReschedule={canProposeReschedule}
        onReschedule={onReschedule}
        onProposeReschedule={onProposeReschedule}
        canCancel={canCancel}
        onCancel={onCancel}
      />
    );
  }
  if (nudge.kind === 'reschedule_proposal') {
    return (
      <NudgeShell
        icon={CalendarSync}
        title={`${counterpartyLabel} suggested some new times`}
        body={rescheduleProposalBody(nudge.optionCount, nudge.expiresAtIso)}
      />
    );
  }
  if (nudge.kind === 'reschedule_proposal_pending') {
    return (
      <NudgeShell
        icon={CalendarSync}
        title="Waiting on a reply to your suggested times"
        body={`${counterpartyLabel} will pick one, or keep the original time. You can withdraw and try again any time below.`}
      />
    );
  }
  if (nudge.kind === 'resolution_ask') {
    return (
      <NudgeShell
        icon={Sparkles}
        title={`${counterpartyLabel} thinks this one's sorted`}
        body="If your issue is resolved, closing the case wraps it up — you can always start a new one."
        onDismiss={onDismissAsk}
        actions={
          <>
            <Button type="button" size="sm" onClick={onMarkResolved} disabled={busy}>
              Yes, mark it resolved
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDismissAsk}
              disabled={busy}
            >
              Not yet
            </Button>
          </>
        }
      />
    );
  }
  if (nudge.kind === 'resolution_ask_pending') {
    return (
      <NudgeShell
        icon={Sparkles}
        title="You've asked if this is sorted"
        // ⚠ NEW COPY — the design reference has no expert-side pending state (it only hides
        // the expert's "Ask" button once asked). Flagged for MJ along with the other two
        // strings this ticket had to write.
        body={`${counterpartyLabel} will see the question on their case. Nothing to do until they answer — and you can keep replying here in the meantime.`}
      />
    );
  }
  return (
    <NudgeShell
      icon={lens === 'client' ? Video : MessageSquare}
      title={lens === 'client' ? 'Nothing booked yet' : 'Nothing booked'}
      body={nothingBookedBody(lens, counterpartyLabel)}
      actions={
        // ⚠ ONLY A LIVE DESTINATION RENDERS. `expert_profiles.username` is NULLABLE, so a null
        // href means NO button rather than a link to `/experts/null`. And only a CLIENT can
        // book, so the expert lens never has one.
        lens === 'client' && bookAgainHref !== null ? (
          <Button asChild size="sm">
            <a href={bookAgainHref}>Book a consultation</a>
          </Button>
        ) : undefined
      }
    />
  );
}

interface UpcomingNudgeProps {
  nudge: Extract<CaseNudgeView, { kind: 'upcoming' }>;
  lens: 'client' | 'expert';
  counterpartyLabel: string;
  canProposeReschedule: boolean;
  onReschedule: () => void;
  onProposeReschedule: () => void;
  canCancel: boolean;
  onCancel: () => void;
}

/**
 * The `'upcoming'` nudge arm, extracted from `CaseNudge` to keep that dispatcher's own
 * cognitive complexity under the SonarJS ceiling — this is the only arm with branching logic.
 */
function UpcomingNudge({
  nudge,
  lens,
  counterpartyLabel,
  canProposeReschedule,
  onReschedule,
  onProposeReschedule,
  canCancel,
  onCancel,
}: Readonly<UpcomingNudgeProps>): React.JSX.Element {
  // `!nudge.live` on BOTH sides — inside the join window the honest action is to join, not
  // to move, and the nudge is already the "starting soon" moment. This is STRICTER than the
  // server (which allows until `start > now`); client-stricter-than-server is the safe
  // direction — a stale page that submits at T-2min still succeeds server-side.
  const canReschedule = lens === 'client' && !nudge.live;
  const canPropose = lens === 'expert' && !nudge.live && canProposeReschedule;
  let moveAction: React.ReactNode;
  if (canReschedule) {
    moveAction = (
      <Button type="button" size="sm" variant="outline" onClick={onReschedule}>
        Reschedule
      </Button>
    );
  } else if (canPropose) {
    moveAction = (
      <Button type="button" size="sm" variant="outline" onClick={onProposeReschedule}>
        Propose a new time
      </Button>
    );
  }

  /**
   * ⚠⚠ BAL-410 — CANCEL RENDERS EVEN WHEN `nudge.live` IS TRUE, UNLIKE RESCHEDULE AND PROPOSE,
   * AND THAT DIVERGENCE IS DELIBERATE. `live` turns true `CASE_JOIN_WINDOW_MINUTES` (15) BEFORE
   * the start, so hiding cancel there would contradict the product's own promise — "free until
   * scheduled start" — and the AC's "up to scheduled start". Unlike the two move actions this
   * is NOT the client being stricter than the server: the server's guard is STATE-based
   * (`CANCELLABLE_MEETING_STATUSES`), and a meeting nobody has joined is still `scheduled`
   * inside the join window. So this is the client matching the server exactly.
   *
   * VISUAL WEIGHT: `ghost` with a destructive HOVER, and rendered SECOND — cancel must never
   * outrank "Reschedule" or (once it lands) "Join". It is available, not invited.
   */
  const cancelAction = canCancel ? (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="text-muted-foreground hover:text-destructive"
      onClick={onCancel}
    >
      Cancel
    </Button>
  ) : null;

  const upcomingAction =
    moveAction || cancelAction ? (
      <div className="flex items-center gap-2">
        {moveAction}
        {cancelAction}
      </div>
    ) : undefined;

  return (
    <NudgeShell
      icon={nudge.live ? Video : CalendarClock}
      live={nudge.live}
      title={<UpcomingTitle iso={nudge.scheduledStartIso} live={nudge.live} />}
      body={upcomingBody(lens, counterpartyLabel, nudge.live)}
      actions={upcomingAction}
    />
  );
}

/**
 * "Your consultation starts in 8 minutes" — but only once the browser has a clock.
 *
 * ⚠ THE SERVER RENDER CARRIES NO RELATIVE TIME, AND THAT IS A HYDRATION RULE, NOT A STYLE
 * CHOICE. "in N minutes" computed during SSR would be stale by the time it painted and would
 * differ between the server and client renders. The first paint states the absolute time; the
 * effect swaps in the countdown. Same posture as `LocalDateTime`.
 */
function UpcomingTitle({ iso, live }: Readonly<{ iso: string; live: boolean }>): React.JSX.Element {
  const [minutes, setMinutes] = useState<number | null>(null);

  useEffect(() => {
    if (!live) return;
    const tick = (): void => {
      setMinutes(Math.round((Date.parse(iso) - Date.now()) / 60_000));
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [iso, live]);

  if (!live) {
    return (
      <>
        Next consultation · <LocalDateTime iso={iso} variant="day-month-time" />
      </>
    );
  }
  if (minutes === null) {
    return <>Your consultation is about to start</>;
  }
  if (minutes <= 0) {
    return <>Your consultation is starting now</>;
  }
  return (
    <>
      Your consultation starts in {minutes} minute{minutes === 1 ? '' : 's'}
    </>
  );
}

function upcomingBody(lens: 'client' | 'expert', counterparty: string, live: boolean): string {
  if (lens === 'client') {
    return live
      ? `${counterparty} will join from here. You can go in early — the timer starts when you're both in. Your join link is in your calendar.`
      : `Your call with ${counterparty} is booked. The join link is in your calendar and we'll send a reminder — nothing to do until then.`;
  }
  return live
    ? `${counterparty} is expecting you. Their brief and the last recap are on this case, and your join link is in your calendar.`
    : `${counterparty} is booked in. Their brief and the last recap are on this case.`;
}

/**
 * BAL-411 — the client-facing `reschedule_proposal` body. The deadline is stated as a HELPFUL
 * FACT, never a countdown (CLAUDE.md): declining is always one click below, so "or nothing
 * happens" is honestly true rather than a threat.
 */
function rescheduleProposalBody(optionCount: number, expiresAtIso: string): React.ReactNode {
  return (
    <>
      {optionCount} time{optionCount === 1 ? '' : 's'} to choose from — pick one below, or keep your
      original time. Reply by <LocalDateTime iso={expiresAtIso} variant="day-month-time" /> — after
      that, your original time simply stands, no need to do anything.
    </>
  );
}

function nothingBookedBody(lens: 'client' | 'expert', counterparty: string): string {
  // ⚠ THE DESIGN'S "{Expert} has time this week" IS NOT RENDERED. There is no availability
  // read on this surface (and no slot-listing endpoint anywhere — owner decision D5), so
  // asserting that the expert has time would be a fabricated claim about a third party.
  return lens === 'client'
    ? `Pick up where you left off — book another consultation with ${counterparty}.`
    : `${counterparty} hasn't booked a follow-up. You can still reply on the case.`;
}

interface NudgeShellProps {
  icon: LucideIcon;
  title: React.ReactNode;
  body: React.ReactNode;
  live?: boolean;
  actions?: React.ReactNode;
  onDismiss?: () => void;
}

function NudgeShell({
  icon: Icon,
  title,
  body,
  live = false,
  actions,
  onDismiss,
}: Readonly<NudgeShellProps>): React.JSX.Element {
  const handleDismiss = useCallback(() => {
    onDismiss?.();
  }, [onDismiss]);

  return (
    <div className="bg-primary/5 border-border mt-4 flex items-start gap-3 rounded-2xl border px-4 py-3.5">
      <Icon size={17} className="text-primary mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {live && (
            <span
              aria-hidden="true"
              className="bg-destructive inline-block h-[7px] w-[7px] shrink-0 animate-pulse rounded-full motion-reduce:animate-none"
            />
          )}
          <p className="text-foreground text-sm font-semibold">{title}</p>
        </div>
        <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">{body}</p>
        {actions !== undefined && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 rounded focus-visible:ring-2 focus-visible:outline-none"
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
