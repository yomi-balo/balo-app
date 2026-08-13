import type { MeetingCallLayout } from '@balo/analytics/events';

/**
 * BAL-435 — WHICH STAGE THE VIDEO SURFACE SHOWS. One pure resolver, exhaustively tested.
 *
 * ⚠ EXTRACTED FROM THE COMPONENT ON PURPOSE. Inlined, the kind→component fan-out pushes
 * `MeetingStage` past SonarCloud's cognitive-complexity limit of 15 — the same split
 * `JoinPhaseContent` was extracted from `JoinControl` for. Everything here decides WHAT STATE we
 * are in; the component decides what that state LOOKS LIKE.
 */

/**
 * ⚠⚠ AN **ALIAS** OF THE ANALYTICS UNION, NOT A SECOND COPY. `MeetingCallLayout` is what
 * `meeting_call_joined.layout` and `meeting_call_layout_changed.{from,to}` are typed as, and the
 * two were declared independently with a "Mirrors …" comment linking them — an acknowledgement,
 * not a link. `apps/web` depends on `@balo/analytics` and never the reverse, so the package is
 * the only direction the one definition can live in. TYPE-ONLY, so nothing reaches a bundle.
 */
export type StageKind = MeetingCallLayout;

/** The viewer's explicit layout choice, or `null` for "follow the headcount". */
export type LayoutOverride = 'spotlight' | 'gallery' | null;

export interface ResolveStageInput {
  readonly hasJoined: boolean;
  /** Participants OTHER than self, in the room RIGHT NOW. Never the roster seat count. */
  readonly remoteCount: number;
  readonly isAnyoneScreenSharing: boolean;
  readonly override: LayoutOverride;
}

/**
 * Rules, in precedence order:
 *
 *   1. not joined                  → `prejoin`
 *   2. ⚠ anyone screen-sharing     → `screenshare`. It is the STRONGEST SIGNAL IN THE ROOM and
 *      it beats the manual override. The override is RETAINED, not cleared, so when sharing
 *      stops the stage returns to the viewer's choice.
 *   3. nobody else here            → `waiting` (the stage's EMPTY state)
 *   4. ⚠ a manual override         → the override. Once set it WINS until the viewer clears it:
 *      an arriving third participant must not yank a spotlighted view out from under someone.
 *   5. exactly one remote          → `spotlight`; otherwise `gallery`
 */
export function resolveStageKind(input: ResolveStageInput): StageKind {
  if (!input.hasJoined) return 'prejoin';
  if (input.isAnyoneScreenSharing) return 'screenshare';
  if (input.remoteCount === 0) return 'waiting';
  if (input.override !== null) return input.override;
  return input.remoteCount === 1 ? 'spotlight' : 'gallery';
}

/** Whether the layout toggle is meaningful right now — hidden during prejoin and screen share. */
export function isVideoLayout(kind: StageKind): boolean {
  return kind === 'spotlight' || kind === 'gallery';
}
