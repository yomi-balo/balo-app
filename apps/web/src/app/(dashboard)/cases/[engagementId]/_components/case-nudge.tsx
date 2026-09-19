'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CalendarSync, MessageSquare, Sparkles, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { joinAffordanceAriaLabel, joinAffordanceTimingLabel } from '@/lib/calendar/join-window';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { resolutionAskPendingTitle } from '@/lib/cases/actor-attribution';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — EXACTLY ONE nudge, chosen server-side by `selectCaseNudge`. This component only
 * renders what it is given; it never re-derives priority, because a second copy of that
 * ordering is a second place the "ask is suppressed while anything is booked" rule lives.
 *
 * ⚠⚠ BAL-567 — JOIN IS NOW THE PRIMARY IN-WINDOW ACTION, ON BOTH SIDES. The docblock that used
 * to sit here said there was no Join button and no participant join route; BAL-435 shipped
 * `/meetings/{id}/call` and BAL-566 gave it its one builder (`memberCallPath`), so the claim was
 * stale rather than merely dated — and `case-nudge.test.tsx` was actively asserting the button's
 * ABSENCE. Both are gone. Join renders as `JoinMeetingButton` (a `<button>` +
 * `globalThis.location.assign`, NEVER an `href` — see that component's docblock) whenever
 * `nudge.live`, FIRST in the action row, with Reschedule/Propose still hidden inside the window
 * and Cancel still second and ghost.
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
        // ⚠ BAL-567 — THE PERSON WHO ACTED, not the counterparty PARTY. `counterpartyLabel` named
        // the delivering expert even when an agency colleague made the ask; `actorLabel` is
        // resolved server-side by the one shared attribution rule.
        title={`${nudge.actorLabel} suggested some new times`}
        body={rescheduleProposalBody(nudge.optionCount, nudge.expiresAtIso)}
      />
    );
  }
  if (nudge.kind === 'reschedule_proposal_pending') {
    return (
      <NudgeShell
        icon={CalendarSync}
        // "You suggested new times" for the person who did it, "Priya suggested new times" for a
        // colleague who is seeing their teammate's ask. The old title said "your" to both.
        title={`${nudge.actorLabel} suggested new times`}
        // ⚠ THE BODY KEEPS `counterpartyLabel` — it is PROSPECTIVE copy about who must answer,
        // which CLAUDE.md's attribution-by-tense rule says names the PARTY, not a person.
        body={`${counterpartyLabel} will pick one, or keep the original time. You can withdraw and try again any time below.`}
      />
    );
  }
  if (nudge.kind === 'resolution_ask') {
    return (
      <NudgeShell
        icon={Sparkles}
        title={`${nudge.actorLabel} thinks this one's sorted`}
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
        // ⚠⚠ BAL-567 — THIS SAID "You've asked" TO EVERY EXPERT-SIDE VIEWER, INCLUDING AGENCY
        // COLLEAGUES WHO DID NOTHING. `resolveCaseAccess` admits any live agency member
        // (`actorHasExpertSideVisibility`, ADR-1046 §7 — deliberately wider than the act), so
        // "you" was simply false for most of them. The contraction now belongs to the actor.
        title={resolutionAskPendingTitle(nudge.actorLabel)}
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
  // ⚠ ONE CLIENT CLOCK FOR THE WHOLE ARM (BAL-567). The countdown in the title and the Join
  // button's `aria-label` are two views of the same instant; computing them separately would let
  // a screen-reader user hear "starting in 4 minutes" beside a heading saying 3.
  const clock = useUpcomingJoinClock(nudge.scheduledStartIso, nudge.live);

  // ⚠ BAL-567 — JOIN IS FIRST AND PRIMARY INSIDE THE WINDOW, on BOTH sides. It is the action
  // that opens the credit session (`apps/api`'s `joinMeetingAsMember`); a calendar entry is not.
  const handleJoin = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'join', lens });
  }, [lens]);

  const joinAction = nudge.live ? (
    <JoinMeetingButton
      joinUrl={nudge.joinPath}
      size="sm"
      className="min-h-11 px-4"
      ariaLabel={joinAffordanceAriaLabel(counterpartyLabel, clock.timingLabel)}
      onJoin={handleJoin}
    >
      <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
      Join call
    </JoinMeetingButton>
  ) : null;

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
   * VISUAL WEIGHT: `ghost` with a destructive HOVER, and rendered LAST — cancel must never
   * outrank "Reschedule" or "Join" (which landed in BAL-567). It is available, not invited.
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
    joinAction || moveAction || cancelAction ? (
      <div className="flex flex-wrap items-center gap-2">
        {joinAction}
        {moveAction}
        {cancelAction}
      </div>
    ) : undefined;

  return (
    <NudgeShell
      icon={nudge.live ? Video : CalendarClock}
      live={nudge.live}
      title={
        <UpcomingTitle iso={nudge.scheduledStartIso} live={nudge.live} minutes={clock.minutes} />
      }
      body={upcomingBody(lens, counterpartyLabel, nudge.live)}
      actions={upcomingAction}
    />
  );
}

/**
 * The ONE client clock the `'upcoming'` arm needs: minutes to start (for the heading) and the
 * Join `aria-label`'s timing phrase, computed from the SAME instant on the same 30s tick.
 *
 * ⚠ THE SERVER RENDER CARRIES NEITHER, AND THAT IS A HYDRATION RULE, NOT A STYLE CHOICE. "in N
 * minutes" computed during SSR would be stale by the time it painted and would differ between
 * the server and client renders. The first paint states the absolute time; the effect swaps in
 * the countdown. Same posture as `LocalDateTime`.
 *
 * ⚠ `joinAffordanceTimingLabel` IS THE SHARED BUILDER, never a second phrase table — it is the
 * same function the calendar and the dashboard Up next row label their Join buttons with, and it
 * is the one that gets `-0` right at the boundary minute.
 */
function useUpcomingJoinClock(
  iso: string,
  live: boolean
): { readonly minutes: number | null; readonly timingLabel: string | null } {
  const [clock, setClock] = useState<{ minutes: number | null; timingLabel: string | null }>({
    minutes: null,
    timingLabel: null,
  });

  useEffect(() => {
    if (!live) return;
    const tick = (): void => {
      const now = new Date();
      const scheduledStart = new Date(iso);
      setClock({
        minutes: Math.round((scheduledStart.getTime() - now.getTime()) / 60_000),
        timingLabel: joinAffordanceTimingLabel(now, scheduledStart),
      });
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [iso, live]);

  return clock;
}

/**
 * "Your consultation starts in 8 minutes" — but only once the browser has a clock.
 *
 * ⚠ PURE AS OF BAL-567: `minutes` is INJECTED by {@link useUpcomingJoinClock}, which the Join
 * button's `aria-label` reads from too, so the heading and the label can never disagree about
 * how long is left. The hydration rule is unchanged — `minutes` is `null` on the server render.
 */
function UpcomingTitle({
  iso,
  live,
  minutes,
}: Readonly<{ iso: string; live: boolean; minutes: number | null }>): React.JSX.Element {
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

/**
 * ⚠⚠ BAL-567 — REWRITTEN TO POINT AT **JOIN**, THE ACTION THAT ACTUALLY OPENS THE CONSULTATION.
 *
 * ⚠ IT NO LONGER SAYS "the join link is in your calendar" — but NOT because there isn't one.
 * BAL-475 shipped Balo-organised ICS invites and `resolve-calendar-invite-recipients.ts`
 * includes CLIENTS, with the member call URL in the ICS. So the old sentence is now merely
 * redundant rather than false, and copy that implied the client has no calendar entry would be
 * the new error (decisions D5 / R5). The button beside this text is the nearer of the two doors;
 * the calendar entry is still there and is simply not what this sentence is for.
 *
 * ⚠ GENDER-NEUTRAL, and the deadline-free register CLAUDE.md asks for: "go in when you're ready",
 * never a countdown-led instruction. MJ sign-off on all four strings is flagged in the PR body.
 */
function upcomingBody(lens: 'client' | 'expert', counterparty: string, live: boolean): string {
  if (lens === 'client') {
    return live
      ? `${counterparty} will join from here. Go in when you're ready — the timer starts when you're both in.`
      : `Your call with ${counterparty} is booked. Join from here when it's time, and we'll send a reminder — nothing to do until then.`;
  }
  return live
    ? `${counterparty} is expecting you. Their brief and the last recap are on this case.`
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
    <div className="bg-primary/5 border-border mt-4 flex items-start gap-3 rounded-xl border px-4 py-3.5">
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
