'use client';

import { createContext, useContext, useMemo } from 'react';
import type { MeetingCallLeaveReason } from '@balo/analytics/events';
import type { BackTo } from './back-to-context';
import type { MeetingPanelRegistration } from './meeting-panels';
import type { WaitingSubject } from './waiting-copy';

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
  children: React.ReactNode;
}>): React.JSX.Element {
  // ⚠ MEMOISED, not an inline object literal — an inline value gives every consumer of this
  // context a new identity on every render of the provider's parent. Callers pass a `backTo`,
  // a `waiting`, an `onExit` and a `panels` that are themselves stable (see `call-client.tsx`).
  const value = useMemo<MeetingRouteValue>(
    () => ({ meetingId, viewerName, title, backTo, contextNoun, waiting, onExit, panels }),
    [meetingId, viewerName, title, backTo, contextNoun, waiting, onExit, panels]
  );
  return <MeetingRouteContext.Provider value={value}>{children}</MeetingRouteContext.Provider>;
}
