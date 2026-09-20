'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, CalendarSync, MessageSquare, Sparkles, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { JoinCountdown } from '@/components/balo/meetings/join-countdown';
import {
  joinAffordanceAriaLabel,
  joinAffordanceTimingLabel,
  joinCountdownLabel,
  signedMinutesUntilCalendarStart,
} from '@/lib/calendar/join-window';
import { insideCaseJoinWindow } from '@/lib/cases/case-join-window';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { resolutionAskPendingTitle } from '@/lib/cases/actor-attribution';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 — EXACTLY ONE nudge, chosen server-side by `selectCaseNudge`. This component only
 * renders what it is given; it never re-derives priority, because a second copy of that
 * ordering is a second place the "ask is suppressed while anything is booked" rule lives.
 *
 * ⚠⚠ THE JOIN SLOT NEVER DISAPPEARS. Before the window it is `JoinCountdown`, a same-size
 * inactive control; once open it is `JoinMeetingButton` (a `<button>` +
 * `globalThis.location.assign`, NEVER an `href` — see that component's docblock), FIRST in the
 * action row. Liveness is owned by `useUpcomingJoinClock`'s own ticking clock, not trusted from
 * `nudge.live` past the first paint — see that hook's docblock. Reschedule/Propose are text-link
 * buttons beside it, matching the row's "View recap" treatment — a demoted, secondary affordance,
 * hidden inside the join window. Cancel does not live here at all: it is on every upcoming row's
 * kebab (`consultation-row-menu.tsx`), including the nudge's own meeting, and the row's Cancel is
 * deliberately NOT join-window-gated.
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
  /** Server-resolved — the same value as the row-hosted `canReschedule` for this meeting, so
   *  the nudge and its row can never disagree about whether it can be moved. */
  canReschedule: boolean;
  /** BAL-409 — opens the reschedule dialog. Presentational only: `case-surface.tsx` owns the
   *  dialog's open state, exactly as it owns `resolveCaseAction`'s transition. */
  onReschedule: () => void;
  /** BAL-411 — EXPERT lens only. Whether "Propose a new time" renders at all — server-resolved
   *  (`canProposeReschedule`), never derived here. */
  canProposeReschedule: boolean;
  /** BAL-411 — opens `ProposeTimesDialog`. Presentational only, mirroring `onReschedule`. */
  onProposeReschedule: () => void;
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
  canReschedule,
  onReschedule,
  canProposeReschedule,
  onProposeReschedule,
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
        canReschedule={canReschedule}
        onReschedule={onReschedule}
        canProposeReschedule={canProposeReschedule}
        onProposeReschedule={onProposeReschedule}
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
  canReschedule: boolean;
  onReschedule: () => void;
  canProposeReschedule: boolean;
  onProposeReschedule: () => void;
}

/**
 * The `'upcoming'` nudge arm, extracted from `CaseNudge` to keep that dispatcher's own
 * cognitive complexity under the SonarJS ceiling — this is the only arm with branching logic.
 */
function UpcomingNudge({
  nudge,
  lens,
  counterpartyLabel,
  canReschedule,
  onReschedule,
  canProposeReschedule,
  onProposeReschedule,
}: Readonly<UpcomingNudgeProps>): React.JSX.Element {
  // ⚠ ONE CLIENT CLOCK FOR THE WHOLE ARM (BAL-567), and it OWNS liveness rather than trusting
  // `nudge.live` past the first paint — see the hook's own docblock.
  const clock = useUpcomingJoinClock(nudge.scheduledStartIso, nudge.live);

  // ⚠ BAL-567 — JOIN IS FIRST AND PRIMARY INSIDE THE WINDOW, on BOTH sides. It is the action
  // that opens the credit session (`apps/api`'s `joinMeetingAsMember`); a calendar entry is not.
  const handleJoin = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'join', lens });
  }, [lens]);

  // THE SLOT NEVER EMPTIES: `JoinCountdown` before the window, `JoinMeetingButton` inside it,
  // same place, same size. `JoinCountdown` is its own element, never `JoinMeetingButton` plus a
  // `disabled` prop (that component's "rendered ONLY inside the join window" invariant stays).
  const joinAction = clock.live ? (
    <JoinMeetingButton
      joinUrl={nudge.joinPath}
      size="sm"
      className="min-h-11 px-4"
      ariaLabel={joinAffordanceAriaLabel(counterpartyLabel, clock.timingLabel)}
      onJoin={handleJoin}
    >
      <span className="size-[7px] rounded-full bg-emerald-400" aria-hidden="true" />
      {clock.joinLabel}
    </JoinMeetingButton>
  ) : (
    <JoinCountdown label={clock.joinLabel} />
  );

  // Both drop the instant the clock crosses into the window — not on the next server refresh —
  // so the nudge's own move affordance can never linger beside a live Join.
  const showReschedule = !clock.live && canReschedule;
  const canPropose = !clock.live && canProposeReschedule;
  // Text-link treatment, matching the row's "View recap" — a demoted, secondary affordance next
  // to Join. Cancel lives only on the row's kebab now (`consultation-row-menu.tsx`).
  const linkClassName =
    'text-primary focus-visible:ring-ring rounded text-xs font-medium focus-visible:ring-2 focus-visible:outline-none';
  let moveAction: React.ReactNode;
  if (showReschedule) {
    moveAction = (
      <button type="button" className={linkClassName} onClick={onReschedule}>
        Reschedule
      </button>
    );
  } else if (canPropose) {
    moveAction = (
      <button type="button" className={linkClassName} onClick={onProposeReschedule}>
        Propose a new time
      </button>
    );
  }

  return (
    <>
      <NudgeShell
        icon={clock.live ? Video : CalendarClock}
        live={clock.live}
        title={
          <UpcomingTitle iso={nudge.scheduledStartIso} live={clock.live} minutes={clock.minutes} />
        }
        body={upcomingBody(lens, counterpartyLabel, clock.live)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {joinAction}
            {moveAction}
          </div>
        }
      />
      {/* Exactly one polite announcement, on the crossing — never the ticking label itself. */}
      <span role="status" className="sr-only">
        {clock.announcement}
      </span>
    </>
  );
}

interface UpcomingJoinClock {
  readonly live: boolean;
  readonly minutes: number | null;
  readonly timingLabel: string | null;
  readonly joinLabel: string;
  readonly announcement: string;
}

/**
 * The ONE client clock the `'upcoming'` arm needs, ticking on a 30s interval regardless of
 * liveness — the countdown must keep counting down to zero, not just while already live.
 *
 * ⚠⚠ THIS HOOK OWNS THE WINDOW, NOT THE SERVER. `initialLive` (`nudge.live`) seeds the very
 * first render ONLY, so server and client agree on which element mounts before hydration; every
 * tick after that re-derives `live` from `insideCaseJoinWindow` against the browser's own clock
 * — the same case-domain predicate the loader used, so the two can't drift in DEFINITION, only
 * in TIMING (a page left open across the boundary). On the tick that flips `live` false → true,
 * it fires `router.refresh()` exactly once — never again for this meeting, and never on a tick
 * that doesn't cross — so the row list's own `live`/`canReschedule` (server-resolved) catch up.
 * The server stays the sole authority on the join CLICK (`assertMeetingJoinable`); this hook is
 * presentation only.
 */
function useUpcomingJoinClock(iso: string, initialLive: boolean): UpcomingJoinClock {
  const router = useRouter();
  // ⚠ A REF, NOT A TICK-EFFECT DEPENDENCY. `next/navigation`'s `useRouter()` is not guaranteed
  // to return the same object across renders (it doesn't in this file's own test mock), and the
  // tick effect below calls `setState` on every run — putting `router` in its dependency array
  // would re-fire the effect every render it changed identity, which calls `setState` again,
  // which re-renders, forever. The ref always reads the LATEST router without re-arming the tick.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });

  const [clock, setClock] = useState<{
    live: boolean;
    minutes: number | null;
    timingLabel: string | null;
    joinLabel: string | null;
  }>({ live: initialLive, minutes: null, timingLabel: null, joinLabel: null });
  const [announcement, setAnnouncement] = useState('');
  const wasLiveRef = useRef(initialLive);

  useEffect(() => {
    wasLiveRef.current = initialLive;
    const scheduledStart = new Date(iso);
    const tick = (): void => {
      const now = new Date();
      const live = insideCaseJoinWindow(now, iso);
      setClock({
        live,
        minutes: live ? signedMinutesUntilCalendarStart(now, scheduledStart) : null,
        timingLabel: live ? joinAffordanceTimingLabel(now, scheduledStart) : null,
        joinLabel: joinCountdownLabel(now, scheduledStart),
      });
      if (live && !wasLiveRef.current) {
        setAnnouncement('You can join now.');
        routerRef.current.refresh();
      }
      wasLiveRef.current = live;
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [iso, initialLive]);

  return { ...clock, joinLabel: clock.joinLabel ?? 'Join', announcement };
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
          {/* Deliberately still — the pulse ring on Join is the nudge's only animation. */}
          {live && (
            <span
              aria-hidden="true"
              className="bg-destructive inline-block h-[7px] w-[7px] shrink-0 rounded-full"
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
