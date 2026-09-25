'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, CalendarSync, MessageSquare, Sparkles, Video, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { JoinMeetingButton } from '@/components/balo/meetings/join-meeting-button';
import { JoinCountdown } from '@/components/balo/meetings/join-countdown';
import { RoomSettingUpSlot } from '@/components/balo/meetings/room-setting-up-slot';
import { roomSettingUpNudgeBody } from '@/lib/meetings/room-setting-up-copy';
import {
  joinAffordanceAriaLabel,
  joinAffordanceTimingLabel,
  joinCountdownLabel,
  signedMinutesUntilCalendarStart,
} from '@/lib/calendar/join-window';
import { insideCaseJoinWindow } from '@/lib/cases/case-join-window';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { resolutionAskPendingTitle } from '@/lib/cases/actor-attribution';
import { useServerAnchoredClock } from '@/hooks/use-server-anchored-clock';
import type { CaseNudgeView } from '@/lib/cases/case-view-types';
import { useRoomReadyRefresh } from './use-room-ready-refresh';

/**
 * BAL-421 — EXACTLY ONE nudge, chosen server-side by `selectCaseNudge`. This component only
 * renders what it is given; it never re-derives priority, because a second copy of that
 * ordering is a second place the "ask is suppressed while anything is booked" rule lives.
 *
 * ⚠⚠ THE JOIN SLOT NEVER DISAPPEARS. Before the window it is `JoinCountdown`, a same-size
 * inactive control; once open it is `JoinMeetingButton` (a `<button>` +
 * `globalThis.location.assign`, NEVER an `href` — see that component's docblock), FIRST in the
 * action row. Liveness is derived, every tick, from one server-anchored clock
 * (`useUpcomingJoinClock`) — `nudge.live` is only that clock's CROSSING BASELINE, never the
 * liveness value itself; see that hook's docblock. Reschedule/Propose are text-link
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
  // ⚠ ONE CLIENT CLOCK FOR THE WHOLE ARM (BAL-567), anchored to the SERVER's instant (BAL-574).
  // `nudge.live` is passed through as the crossing baseline only — see the hook's own docblock.
  const clock = useUpcomingJoinClock(nudge.scheduledStartIso, nudge.serverNowIso, nudge.live);

  // BAL-581 — the call room's own readiness, a SEPARATE field from `live` (never folded in —
  // see `CaseNudgeView`'s docblock). Bounded refresh while the window is open and the room isn't
  // ready yet; the hook is itself time-bounded, so it stops on its own once the window's salvage
  // period ends, on top of stopping the instant `roomReady` flips.
  const roomReady = nudge.roomReady;
  useRoomReadyRefresh(clock.live && !roomReady, nudge.scheduledStartIso);
  // A refresh that flips the room to ready while the window is open announces it (sr-only, the
  // SAME words as the crossing announcement; not a visible notice).
  const roomReadyAnnouncement = useRoomReadyAnnouncement(roomReady, clock.live, nudge.meetingId);

  // ⚠ BAL-567 — JOIN IS FIRST AND PRIMARY INSIDE THE WINDOW, on BOTH sides. It is the action
  // that opens the credit session (`apps/api`'s `joinMeetingAsMember`); a calendar entry is not.
  const handleJoin = useCallback(() => {
    track(RECAP_EVENTS.CASE_ACTION_CLICKED, { action: 'join', lens });
  }, [lens]);

  // THE SLOT NEVER EMPTIES: `RoomSettingUpSlot` while the room is not ready, `JoinCountdown`
  // before the window, `JoinMeetingButton` inside it — same place, same size. `JoinCountdown` is
  // its own element, never `JoinMeetingButton` plus a `disabled` prop (that component's "rendered
  // ONLY inside the join window" invariant stays).
  let joinAction: React.ReactNode;
  if (!roomReady) {
    joinAction = <RoomSettingUpSlot variant="button" className="min-h-11 px-4" />;
  } else if (clock.live) {
    joinAction = (
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
    );
  } else {
    joinAction = <JoinCountdown label={clock.joinLabel} />;
  }

  // Both drop the instant the clock crosses into the window — not on the next server refresh —
  // so the nudge's own move affordance can never linger beside a live Join. UNCHANGED by
  // `roomReady`: Reschedule/Propose visibility is a join-window question, not a venue one.
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

  // `joinable` — the only sense in which the nudge is "live" for the shell's dot/icon: the
  // window is open AND the room is actually ready to receive someone.
  const joinable = clock.live && roomReady;

  return (
    <>
      <NudgeShell
        icon={joinable ? Video : CalendarClock}
        live={joinable}
        title={
          // The title never claims the consultation is starting or happening while the room
          // isn't ready. Before the start, the plain countdown ("starts in N minutes") is still
          // allowed even with a not-yet-ready room — it is a true statement about the clock, not
          // a liveness claim. At or after the start with `roomReady` false, fall back to the
          // neutral absolute-time title so it never contradicts the not-ready body below it.
          clock.live && (roomReady || clock.minutes > 0) ? (
            <UpcomingTitle live minutes={clock.minutes} />
          ) : (
            <UpcomingTitle live={false} iso={nudge.scheduledStartIso} />
          )
        }
        body={
          roomReady
            ? upcomingBody(lens, counterpartyLabel, clock.live)
            : roomSettingUpNudgeBody(lens, counterpartyLabel)
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {joinAction}
            {moveAction}
          </div>
        }
      />
      {/* Exactly one polite announcement, on the crossing — never the ticking label itself. The
          crossing announcement is suppressed while the room isn't ready: Join has not actually
          appeared, so there is nothing true to announce yet. */}
      <span role="status" className="sr-only">
        {roomReady ? clock.announcement || roomReadyAnnouncement : ''}
      </span>
    </>
  );
}

/**
 * BAL-581 — a screen reader is told when the room becomes ready WHILE the window is already
 * open, a case `useUpcomingJoinClock`'s own crossing announcement cannot cover:
 * that hook only fires on the join-WINDOW crossing (false → true liveness), so a viewer who
 * mounted already inside the window never sees one, and a viewer whose window opened before the
 * room did has already had that announcement suppressed (see the sr-only span above). Tracks the
 * room-readiness crossing (false → true) independently, only while `live`, and resets on a
 * meeting swap so a stale "You can join now." cannot linger about a meeting the viewer never
 * watched become ready.
 */
function useRoomReadyAnnouncement(roomReady: boolean, live: boolean, meetingId: string): string {
  const [announcement, setAnnouncement] = useState('');
  const prevRoomReadyRef = useRef(roomReady);
  const meetingIdRef = useRef(meetingId);

  useEffect(() => {
    if (meetingIdRef.current !== meetingId) {
      meetingIdRef.current = meetingId;
      prevRoomReadyRef.current = roomReady;
      setAnnouncement('');
      return;
    }
    if (live && roomReady && !prevRoomReadyRef.current) {
      setAnnouncement('You can join now.');
    }
    prevRoomReadyRef.current = roomReady;
  }, [roomReady, live, meetingId]);

  return announcement;
}

interface UpcomingJoinClockBase {
  readonly joinLabel: string;
  readonly announcement: string;
}

/**
 * ⚠ DISCRIMINATED ON `live`, NOT A FLAT SHAPE — `minutes` and `timingLabel` are BOTH `number` /
 * `string` exactly when `live` is `true`, never independently `null`. This is what lets
 * `UpcomingTitle` (below) make "`live: true` with no minute count" a compile error rather than a
 * runtime fallback.
 */
type UpcomingJoinClock =
  | (UpcomingJoinClockBase & {
      readonly live: true;
      readonly minutes: number;
      readonly timingLabel: string;
    })
  | (UpcomingJoinClockBase & {
      readonly live: false;
      readonly minutes: null;
      readonly timingLabel: null;
    });

/** BAL-574 — the nudge's own tick cadence. Deliberately NOT `VIEWER_CLOCK_TICK_MS` (60s): the
 *  countdown must reach zero without a visible half-minute of staleness at the boundary. */
export const JOIN_CLOCK_TICK_MS = 30_000;

/**
 * The ONE client clock the `'upcoming'` arm needs, ticking on a 30s interval regardless of
 * liveness — the countdown must keep counting down to zero, not just while already live.
 *
 * ⚠⚠ BAL-574 — LIVENESS IS DERIVED FROM A SERVER-ANCHORED CLOCK, NEVER THE DEVICE CLOCK.
 * `useServerAnchoredClock` seeds `now` to the server's own render instant and advances it by
 * elapsed real time, so `live = insideCaseJoinWindow(now, iso)` is bit-for-bit what the server
 * itself computed for `initialLive` at render 0 — a device clock running fast or slow never
 * enters the comparison. `initialLive` (`nudge.live`) is NO LONGER part of that computation; it
 * survives only as the CROSSING BASELINE — the value `wasLiveRef` starts from, so a meeting that
 * is already live at mount does not read as a false→true crossing and fire a spurious
 * `router.refresh()`. On the tick that flips `live` false → true, this fires `router.refresh()`
 * exactly once — never again for this meeting, and never on a tick that doesn't cross — so the
 * row list's own `live`/`canReschedule` (server-resolved) catch up. The server stays the sole
 * authority on the join CLICK (`assertMeetingJoinable`); this hook is presentation only.
 */
function useUpcomingJoinClock(
  iso: string,
  serverNowIso: string,
  initialLive: boolean
): UpcomingJoinClock {
  const router = useRouter();
  // ⚠ A REF, NOT A TICK-EFFECT DEPENDENCY. `next/navigation`'s `useRouter()` is not guaranteed
  // to return the same object across renders (it doesn't in this file's own test mock), and the
  // crossing effect below can call `setState` on every run — putting `router` in its dependency
  // array would re-fire the effect every render it changed identity, which calls `setState`
  // again, which re-renders, forever. The ref always reads the LATEST router without re-arming.
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });

  const { now, anchored } = useServerAnchoredClock(serverNowIso, JOIN_CLOCK_TICK_MS);
  const scheduledStart = useMemo(() => new Date(iso), [iso]);

  const live = insideCaseJoinWindow(now, iso);
  // Until the clock is anchored this render can still be the server's, so the viewer-local
  // calendar-day branch must not run — see `joinCountdownLabel`.
  const joinLabel = joinCountdownLabel(now, scheduledStart, { calendarDaysAvailable: anchored });

  const [announcement, setAnnouncement] = useState('');
  // ⚠ SEEDED FROM `initialLive`, NOT `false` — deleting this seed makes a meeting that is
  // ALREADY live at mount look like a false→true crossing on the first effect run, which fires
  // an unwanted `router.refresh()` at mount. See the hook's own docblock.
  const wasLiveRef = useRef(initialLive);
  // The last server word this hook re-seeded `wasLiveRef` from — `iso` alone is not enough,
  // because a `router.refresh()` on the SAME meeting must not re-seed the crossing baseline.
  const serverWordRef = useRef({ iso, initialLive });

  useEffect(() => {
    const previous = serverWordRef.current;
    if (previous.iso !== iso || previous.initialLive !== initialLive) {
      serverWordRef.current = { iso, initialLive };
      wasLiveRef.current = initialLive;
      // A DIFFERENT meeting's crossing announcement must not linger once that meeting is gone —
      // otherwise a swap to a not-yet-live meeting keeps `role="status"` reading "You can join
      // now." for a meeting the viewer never watched cross anything.
      setAnnouncement('');
    }
    if (live && !wasLiveRef.current) {
      setAnnouncement('You can join now.');
      routerRef.current.refresh();
    }
    wasLiveRef.current = live;
  }, [iso, initialLive, live]);

  if (live) {
    return {
      live: true,
      minutes: signedMinutesUntilCalendarStart(now, scheduledStart),
      timingLabel: joinAffordanceTimingLabel(now, scheduledStart),
      joinLabel,
      announcement,
    };
  }
  return { live: false, minutes: null, timingLabel: null, joinLabel, announcement };
}

/**
 * "Your consultation starts in 8 minutes" — the live arm's minute count, or the absolute time
 * for the not-yet-live arm.
 *
 * ⚠ DISCRIMINATED ON `live` (BAL-574) — `live: true` STRUCTURALLY CARRIES `minutes: number`, so
 * "live with no minute count" cannot be constructed and this component has no fallback branch for
 * it. `minutes` and the Join button's `aria-label` both read off the same
 * {@link useUpcomingJoinClock} tick, so the heading and the label can never disagree about how
 * long is left.
 */
type UpcomingTitleProps =
  | { readonly live: false; readonly iso: string }
  | { readonly live: true; readonly minutes: number };

function UpcomingTitle(props: Readonly<UpcomingTitleProps>): React.JSX.Element {
  if (!props.live) {
    return (
      <>
        Next consultation · <LocalDateTime iso={props.iso} variant="day-month-time" />
      </>
    );
  }
  const { minutes } = props;
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
