/**
 * BAL-435 — the IN-CALL surface's CLIENT-side events.
 *
 * ⚠⚠ A NEW FILE, NOT AN ADDITION TO `events/meeting.ts`. That module is explicitly SERVER-ONLY
 * and its docblock forbids adding its constants to `AllEvents` or to the web app's client mock.
 * Mixing the two families into one module would make that rule un-enforceable — so the in-call
 * family lives here, and it is the CLIENT half by construction.
 *
 * ⚠⚠ **NEVER A PROPERTY ON ANY EVENT BELOW:** `token`, `roomUrl`, `participantId` (it is a
 * routing credential shape), a guest's email, or a meeting title. `is_owner` is fine — it is a
 * server-decided VERDICT, not a secret. `meeting_id` is fine; the server family already carries
 * it.
 *
 * ⚠ `meeting_id` IS **OPTIONAL**, AND THAT IS DELIBERATE RATHER THAN LAX. The call frame mounts
 * on three routes; only the authenticated member route has a route context carrying the id. The
 * two ANONYMOUS guest mounts do not, so their events OMIT the key entirely instead of carrying a
 * fabricated or empty one — an absent key cannot create a bogus breakdown bucket, and a `''`
 * can. Same reasoning as `guest_joined`'s conditionally-spread `party`.
 */

export const MEETING_CALL_EVENTS = {
  JOINED: 'meeting_call_joined',
  LAYOUT_CHANGED: 'meeting_call_layout_changed',
  SCREENSHARE_STARTED: 'meeting_call_screenshare_started',
  SCREENSHARE_STOPPED: 'meeting_call_screenshare_stopped',
  RECONNECTED: 'meeting_call_reconnected',
  LEFT: 'meeting_call_left',
  ENDED_FOR_ALL: 'meeting_call_ended_for_all',
  GRANT_REJECTED: 'meeting_call_grant_rejected',
  ERROR: 'meeting_call_error',
  DEVICE_BLOCKED: 'meeting_call_device_blocked',
} as const;

/** Which stage the video surface is showing. Mirrors `resolve-stage.ts`'s `StageKind`. */
export type MeetingCallLayout = 'prejoin' | 'waiting' | 'spotlight' | 'gallery' | 'screenshare';

/** Whether the layout moved because the headcount changed or because a person chose it. */
export type MeetingCallLayoutSource = 'auto' | 'manual';

/** Why the local participant is no longer in the room. */
export type MeetingCallLeaveReason = 'self' | 'host_ended' | 'error';

/**
 * WHICH grant check failed — never the offending value.
 *
 * ⚠ THE CODES NAME A CHECK, NOT DATA, AND THAT IS WHAT MAKES THEM SAFE TO EMIT. Mirrors
 * `GrantRejectionReason` in `apps/web/src/lib/meetings/validate-grant.ts`.
 */
export type MeetingCallGrantRejectionReason =
  | 'shape'
  | 'expires_at'
  | 'participant_id'
  | 'url_parse'
  | 'url_scheme'
  | 'url_host';

/** Which local device the browser is refusing. */
export type MeetingCallDeviceKind = 'camera' | 'microphone';

export interface MeetingCallEventMap {
  [MEETING_CALL_EVENTS.JOINED]: {
    meeting_id?: string;
    /** ⚠ The SERVER's `host_meetings` verdict. Never a lens, never a role string. */
    is_owner: boolean;
    layout: MeetingCallLayout;
    prejoin_skipped: boolean;
    ms_to_joined: number;
    /**
     * ⚠ THE LIVE TILE COUNT, NEVER THE ROSTER SEAT COUNT. The two are different numbers: seats
     * include invited-but-absent guests. Conflating them makes every dashboard built on this
     * property quietly wrong.
     */
    participant_count_at_join: number;
  };
  [MEETING_CALL_EVENTS.LAYOUT_CHANGED]: {
    meeting_id?: string;
    from: MeetingCallLayout;
    to: MeetingCallLayout;
    source: MeetingCallLayoutSource;
  };
  [MEETING_CALL_EVENTS.SCREENSHARE_STARTED]: {
    meeting_id?: string;
  };
  [MEETING_CALL_EVENTS.SCREENSHARE_STOPPED]: {
    meeting_id?: string;
    duration_ms: number;
  };
  [MEETING_CALL_EVENTS.RECONNECTED]: {
    meeting_id?: string;
    duration_ms: number;
    /** `false` = the participant gave up or the call died rather than recovering. */
    recovered: boolean;
  };
  [MEETING_CALL_EVENTS.LEFT]: {
    meeting_id?: string;
    reason: MeetingCallLeaveReason;
    duration_ms: number;
  };
  [MEETING_CALL_EVENTS.ENDED_FOR_ALL]: {
    meeting_id?: string;
    participant_count: number;
  };
  [MEETING_CALL_EVENTS.GRANT_REJECTED]: {
    reason: MeetingCallGrantRejectionReason;
  };
  [MEETING_CALL_EVENTS.ERROR]: {
    meeting_id?: string;
    /** ⚠ Daily's error CLASS, never its message — a message can carry a room name. */
    code: string;
  };
  [MEETING_CALL_EVENTS.DEVICE_BLOCKED]: {
    meeting_id?: string;
    kind: MeetingCallDeviceKind;
  };
}
