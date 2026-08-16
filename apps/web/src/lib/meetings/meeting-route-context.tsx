'use client';

import { createContext, useContext, useMemo } from 'react';
import type { MeetingCallLeaveReason } from '@balo/analytics/events';
import type { MeetingClockState } from '@/components/balo/meetings/meeting-clock-slot';
import type { BackTo } from './back-to-context';
import type { EndMeetingResult } from './meeting-state';
import type { MeetingPanelRegistration } from './meeting-panels';
import {
  UNKNOWN_WAITING_FACTS,
  type WaitingFacts,
  type WaitingPhase,
  type WaitingSubject,
} from './waiting-copy';

/**
 * BAL-435 — ROUTE-SCOPED AMBIENT DATA FOR THE CALL FRAME, AS A CONTEXT RATHER THAN A PROP.
 *
 * ⚠⚠ `MeetingCallSurface`'s PROP CONTRACT IS FROZEN, AND THIS TICKET ADDS NOTHING TO IT — not
 * even an optional prop. That seam's own docblock states the rule: "a prop added later is a
 * contract change; a prop added here is the contract." The meeting title and the "Back to
 * {context}" destination are things ONE of the three mounts has and the other two structurally
 * do not, which is a Context, not a prop.
 *
 * ⚠ ONLY THE MEMBER ROUTE MOUNTS THE PROVIDER. `join-control.tsx` and `lobby-client.tsx` are
 * untouched, so both guest surfaces read `{ title: null, backTo: null }` — the neutral heading
 * and the `/dashboard` fallback link — **structurally, not by a lens check**.
 *
 * ⚠ BAL-436 AND BAL-437 SHOULD EXTEND **THIS**, not the prop list.
 */

/**
 * Why the local participant is leaving.
 *
 * ⚠⚠ AN **ALIAS** OF THE ANALYTICS UNION, NOT A SECOND COPY — it is exactly what
 * `meeting_call_left.reason` is typed as, and the two were previously declared independently
 * with a "Mirrors …" comment linking them. `apps/web` depends on `@balo/analytics` and never the
 * reverse, so the package owns the definition. TYPE-ONLY: nothing reaches a bundle.
 */
export type MeetingExitReason = MeetingCallLeaveReason;

export interface MeetingRouteValue {
  /**
   * The meeting id, for analytics only.
   *
   * ⚠ `null` ON BOTH GUEST MOUNTS — they do not mount this provider, so their events simply omit
   * the property rather than carrying a fabricated one.
   */
  readonly meetingId: string | null;
  /**
   * The VIEWER's own display name, for PreJoin's "Joining as {name}" line.
   *
   * ⚠⚠ `null` ⇒ THE LINE IS OMITTED ENTIRELY, never replaced with a guess. It is resolved
   * SERVER-SIDE from the session on the member route; a guest has no Balo account, and a
   * client-supplied name on a private room is exactly the impersonation surface PreJoin refuses.
   */
  readonly viewerName: string | null;
  /** The meeting's human label, or `null` for the neutral heading. ⚠ Never an analytics prop. */
  readonly title: string | null;
  /** Where "back" goes, or `null` to use the dashboard fallback. */
  readonly backTo: BackTo | null;
  /**
   * "case" / "project" / "package" / "retainer" / "request", or `'call'`.
   *
   * ⚠ ONE SOURCE, TWO RENDERINGS — it comes from the SAME table as `backTo`
   * (`resolveContextNoun`), so the confirm dialog and the back link cannot disagree about what
   * this meeting is attached to.
   */
  readonly contextNoun: string;
  /**
   * BAL-435 (ruling R10) — WHO THE WAITING STAGE IS WAITING FOR, and from when.
   *
   * ⚠⚠ `null` ⇒ **PARTY-NEUTRAL COPY**, and that is the whole point of the shape. It arrives on
   * the member-join RESPONSE ENVELOPE (never on the frozen `JoinGrant`), so both GUEST mounts —
   * which do not mount this provider — read `null` STRUCTURALLY and can never be shown a claim
   * about somebody's clock. Before R10 the stage hard-coded `absentParty="expert"`, so the
   * delivering EXPERT was shown the CLIENT's "you won't be charged for waiting" promise.
   *
   * ⚠ IT IS A FACT ABOUT THE ROOM, NOT A LENS: `viewerRole` is `authorizeMeetingParticipation`'s
   * server-side verdict about which side the actor was resolved onto, never `activeMode`.
   */
  readonly waiting: WaitingSubject | null;
  /**
   * WHERE A PARTICIPANT GOES WHEN THE CALL ENDS.
   *
   * ⚠⚠ `undefined` ON BOTH GUEST MOUNTS, STRUCTURALLY — an anonymous guest has no Balo
   * destination, so the frame simply returns them to its own pre-join state, from which they may
   * rejoin. Only the member route can navigate, and it navigates to the BAL-388 recap at
   * `/meetings/{id}` — the natural parent inside one URL family, and a route that EXISTS today.
   * **BAL-389 takes this seam over without touching the frame.**
   */
  readonly onExit?: (reason: MeetingExitReason) => void;
  /**
   * BAL-436 — **THE SIDE-PANEL REGISTRATION.**
   *
   * ⚠⚠ `null` MEANS **NO PANEL SLOT AT ALL**: no toolbar buttons, no More-sheet rows, no
   * top-bar seat chip, no interactive overflow tile, no panel. Not disabled — ABSENT, which
   * is BAL-435's slot rule verbatim (`more-sheet.tsx`: "an unregistered slot renders
   * NOTHING"). A greyed-out People icon reads "people is broken"; an absent one reads "this
   * call doesn't have that".
   *
   * ⚠⚠ BOTH **GUEST** MOUNTS READ `null` **STRUCTURALLY**, because neither `join-control.tsx`
   * nor `lobby-client.tsx` mounts this provider — the same mechanism `backTo` already uses.
   * That is not an optimisation: a token-authenticated guest satisfies NONE of the four gates
   * behind this panel (`requireAuth` on the guests route, `requireUser()` on both file reads,
   * `requireOnboardedUser()` on both file writes), so a registered slot would be a control
   * that could only ever fail. **Never a lens check, never a role check, nowhere.**
   *
   * ⚠ IT CARRIES CALLBACKS, NOT DATA — see `MeetingPanelRegistration`. Panel state lives in
   * the panel; `MeetingCallSurface`'s prop list stays frozen; and the panel components are
   * testable with plain fakes.
   *
   * ⚠ THE CALLER MUST MEMOISE IT (`call-client.tsx` does). It joins the provider's `useMemo`
   * dependency list, so an inline object literal would hand every consumer a new context
   * identity on every render of the provider's parent.
   */
  readonly panels: MeetingPanelRegistration | null;
  /**
   * BAL-134 (§7.1) — **HOW FAR THE WAIT HAS RUN. A LABEL THE SERVER COMPUTED.**
   *
   * ⚠⚠ THE BROWSER NEVER COMPUTES A THRESHOLD. `resolveWaitingPhase` runs in `apps/api` against
   * the ENV-RESOLVED timers and sends the answer as one of four words; the four strings for
   * both parties already ship in `waiting-copy.ts`. That is the acceptance criterion verbatim
   * ("all timing is server-authoritative; the client renders a mirror") and it structurally
   * prevents an overridden server from disagreeing with a default-carrying browser bundle.
   *
   * ⚠ `'pre-start'` ON BOTH GUEST MOUNTS, STRUCTURALLY — they mount no provider, so they keep
   * exactly the value BAL-435 hard-coded, and the copy they see is the party-neutral set
   * (`waiting` is `null` for them too).
   */
  readonly waitingPhase: WaitingPhase;
  /**
   * BAL-134 — **THE SERVER-MIRROR FACTS THE WAITING COPY MAY NOT ASSERT WITHOUT.**
   *
   * ⚠⚠ SEPARATE FROM `waiting` ON PURPOSE, BECAUSE THEY COME FROM DIFFERENT SOURCES. `waiting`
   * is assembled ONCE from the join envelope (who is missing, and from when); these arrive on
   * every tick of the polled mirror. Folding them together would break R10's "wholly present or
   * wholly absent" guarantee — a guest mount has a `null` subject and would still need somewhere
   * to record an unknown no-show floor.
   *
   * ⚠ `UNKNOWN_WAITING_FACTS` ON BOTH GUEST MOUNTS AND BEFORE THE FIRST POLL, STRUCTURALLY. Each
   * unknown makes the copy claim LESS: no number, no settled outcome, no counted time.
   */
  readonly waitingFacts: WaitingFacts;
  /**
   * BAL-134 (§7.3) — **THE TOP-BAR CLOCK CHIP'S STATE, OR `null` FOR "NO SERVER MIRROR".**
   *
   * ⚠⚠ `null` IS A LIVE PATH, NOT A GUARD, AND IT IS WHY THIS IS NULLABLE RATHER THAN
   * DEFAULTED TO `{ kind: 'not_started' }`. Both GUEST mounts read it structurally (the state
   * route is member-only), and so does the member route for the window between joining and the
   * first poll landing. `null` means the frame keeps its shipped `hasJoined ? live :
   * not_started` chrome — "Not started" on a guest's screen for the length of a live call would
   * be a regression this ticket has no reason to ship.
   *
   * ⚠ IT IS PRODUCED BY THE PURE `resolveTopBarClock`, from the SERVER's `viewerRole` — never
   * from a lens, and never from a locally-computed duration.
   */
  readonly clock: MeetingClockState | null;
  /**
   * BAL-134 / ADR-1049 — **END THE MEETING FOR EVERYONE, SERVER-SIDE.**
   *
   * ⚠⚠ `null` ON BOTH GUEST MOUNTS, STRUCTURALLY — the same mechanism `panels` and `backTo`
   * already use. That is not belt-and-braces for the `canEndMeeting` gate; it is the second,
   * independent half of it. A guest holds no company membership and is not on the engagement
   * axis, so the server hard-codes `canEndMeeting: false` for them AND there is no action here
   * for them to reach. Neither alone would be enough to reason about; together they are.
   *
   * ⚠⚠ THE FRAME MUST **NOT** FALL BACK TO A LOCAL EJECT WHEN THIS IS `null`. A client-side
   * `updateParticipants({ '*': { eject: true } })` revokes NO token — the very defect BAL-134
   * fixes — so a `null` here with `canEndMeeting` true is a WIRING BUG, and the honest
   * response is to tell the person the call is still running rather than to half-end it.
   */
  readonly endMeeting: (() => Promise<EndMeetingResult>) | null;
}

const EMPTY: MeetingRouteValue = {
  meetingId: null,
  viewerName: null,
  title: null,
  backTo: null,
  // ⚠ NO PANEL SLOT ON EITHER GUEST MOUNT, STRUCTURALLY. See the field's docblock.
  panels: null,
  // ⚠ THE HONEST FALLBACK. "…all stay with the call" is true of every context; naming the wrong
  // one on a destructive confirm is not.
  contextNoun: 'call',
  // ⚠ NEUTRAL WAITING COPY ON BOTH GUEST MOUNTS, STRUCTURALLY — no viewer role, no name, no
  // clock claim. See the field's docblock.
  waiting: null,
  // ⚠ BAL-134 — THE THREE STRUCTURALLY-NEUTRAL GUEST VALUES. `'pre-start'` is exactly what
  // BAL-435 hard-coded, `null` keeps the shipped top-bar chrome, and `null` means there is no
  // end action to reach. See each field's docblock.
  waitingPhase: 'pre-start',
  waitingFacts: UNKNOWN_WAITING_FACTS,
  clock: null,
  endMeeting: null,
};

const MeetingRouteContext = createContext<MeetingRouteValue>(EMPTY);

/**
 * ⚠ RETURNS THE EMPTY VALUE WHEN NO PROVIDER IS MOUNTED — it never throws. A guest surface that
 * renders the frame without route context is the NORMAL case, not an error.
 */
export function useMeetingRoute(): MeetingRouteValue {
  return useContext(MeetingRouteContext);
}

export function MeetingRouteContextProvider({
  meetingId,
  viewerName,
  title,
  backTo,
  contextNoun,
  waiting,
  onExit,
  panels = null,
  waitingPhase = 'pre-start',
  waitingFacts = UNKNOWN_WAITING_FACTS,
  clock = null,
  endMeeting = null,
  children,
}: Readonly<{
  meetingId: string | null;
  viewerName: string | null;
  title: string | null;
  backTo: BackTo | null;
  contextNoun: string;
  waiting: WaitingSubject | null;
  onExit?: (reason: MeetingExitReason) => void;
  /**
   * ⚠ DEFAULTS TO `null` — NO PANEL SLOT. A mount that wants the panel has to say so, which
   * keeps "absent" the fail-closed default rather than something a caller can forget INTO.
   */
  panels?: MeetingPanelRegistration | null;
  /** BAL-134 — ⚠ DEFAULTS TO THE SHIPPED `'pre-start'`, so an unwired mount is unchanged. */
  waitingPhase?: WaitingPhase;
  /** BAL-134 — ⚠ DEFAULTS TO ALL-UNKNOWN, which is the copy that claims the least. */
  waitingFacts?: WaitingFacts;
  /** BAL-134 — ⚠ DEFAULTS TO `null` = NO MIRROR, i.e. the frame keeps its shipped chrome. */
  clock?: MeetingClockState | null;
  /** BAL-134 — ⚠ DEFAULTS TO `null` = NO END ACTION. Fail-closed, exactly like `panels`. */
  endMeeting?: (() => Promise<EndMeetingResult>) | null;
  children: React.ReactNode;
}>): React.JSX.Element {
  // ⚠ MEMOISED, not an inline object literal — an inline value gives every consumer of this
  // context a new identity on every render of the provider's parent. Callers pass a `backTo`,
  // a `waiting`, an `onExit`, a `panels`, a `clock` and an `endMeeting` that are themselves
  // stable (see `call-client.tsx`).
  const value = useMemo<MeetingRouteValue>(
    () => ({
      meetingId,
      viewerName,
      title,
      backTo,
      contextNoun,
      waiting,
      onExit,
      panels,
      waitingPhase,
      waitingFacts,
      clock,
      endMeeting,
    }),
    [
      meetingId,
      viewerName,
      title,
      backTo,
      contextNoun,
      waiting,
      onExit,
      panels,
      waitingPhase,
      waitingFacts,
      clock,
      endMeeting,
    ]
  );
  return <MeetingRouteContext.Provider value={value}>{children}</MeetingRouteContext.Provider>;
}
