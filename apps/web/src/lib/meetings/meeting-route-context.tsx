'use client';

import { createContext, useContext, useMemo } from 'react';
import type { MeetingCallLeaveReason } from '@balo/analytics/events';
import type { BackTo } from './back-to-context';
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
}

const EMPTY: MeetingRouteValue = {
  meetingId: null,
  viewerName: null,
  title: null,
  backTo: null,
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
  children,
}: Readonly<{
  meetingId: string | null;
  viewerName: string | null;
  title: string | null;
  backTo: BackTo | null;
  contextNoun: string;
  waiting: WaitingSubject | null;
  onExit?: (reason: MeetingExitReason) => void;
  children: React.ReactNode;
}>): React.JSX.Element {
  // ⚠ MEMOISED, not an inline object literal — an inline value gives every consumer of this
  // context a new identity on every render of the provider's parent. Callers pass a `backTo`,
  // a `waiting` and an `onExit` that are themselves stable (see `call-client.tsx`).
  const value = useMemo<MeetingRouteValue>(
    () => ({ meetingId, viewerName, title, backTo, contextNoun, waiting, onExit }),
    [meetingId, viewerName, title, backTo, contextNoun, waiting, onExit]
  );
  return <MeetingRouteContext.Provider value={value}>{children}</MeetingRouteContext.Provider>;
}
