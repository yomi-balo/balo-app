/**
 * BAL-436 — the in-call SIDE PANEL's CLIENT-side events (People and Files).
 *
 * ⚠⚠ A NEW FILE, NOT AN ADDITION TO `events/guest.ts`. That module is explicitly SERVER-ONLY
 * and its docblock forbids adding its constants to `AllEvents` or to the web app's client
 * mock. The panel is a `'use client'` island, so its family is the CLIENT half by
 * construction — it follows `meeting-call.ts`'s posture, not `guest.ts`'s.
 *
 * ⚠⚠ **NEVER A PROPERTY ON ANY EVENT BELOW:** a guest's name, an email address, an email
 * domain, a file name, a join token, a room url, a Daily participant id, or a
 * `meeting_guests.id`. The whole panel is about people OUTSIDE both parties, so the
 * temptation is real and the rule is absolute. `canHost` would be fine — it is a
 * server-decided VERDICT, not a secret — but no event below needs it.
 *
 * ⚠ `meeting_id` IS **OPTIONAL**, inherited from `meeting-call.ts`'s shape for type
 * compatibility across one surface. In practice the panel exists ONLY on the authenticated
 * member mount (both guest mounts read a `null` panel registration STRUCTURALLY), so the key
 * is always present in production — but an absent key is still the encoding, never a `null`,
 * because a `null` reaches PostHog as a real value and creates a bogus breakdown bucket.
 */

export const MEETING_PANEL_EVENTS = {
  OPENED: 'meeting_panel_opened',
  GUEST_DECIDED: 'meeting_panel_guest_decided',
  GUESTS_INVITED: 'meeting_panel_guests_invited',
  JOIN_LINK_COPIED: 'meeting_panel_join_link_copied',
  LINK_RESENT: 'meeting_panel_link_resent',
  FILE_SHARED: 'meeting_panel_file_shared',
  FILE_DOWNLOADED: 'meeting_panel_file_downloaded',
} as const;

/** Which slot the single-slot panel is showing. ⚠ `chat` is BAL-437's and is not declared. */
export type MeetingPanelId = 'people' | 'files';

/** What a host decided about a waiting person. */
export type MeetingPanelAdmissionDecision = 'admit' | 'deny';

/**
 * How an admit/deny resolved.
 *
 * ⚠ `already_decided` IS ITS OWN OUTCOME AND IS **NOT** A FAILURE. It is the two-hosts race
 * answer (`409 guest_not_pending`) — the other host's decision stands, which is the outcome
 * the person wanted either way. Folding it into `failed` would make a healthy multi-host
 * meeting look like a broken one in every dashboard.
 */
export type MeetingPanelDecisionOutcome = 'ok' | 'already_decided' | 'failed';

/**
 * How an invite resolved.
 *
 * ⚠ THE REFUSALS ARE NAMED SEPARATELY BECAUSE THEIR REMEDIES DIFFER — a full room, a
 * duplicate address and a spent rate-limit window are three different product problems, and
 * collapsing them into `failed` is what makes "invites are failing" unactionable.
 */
export type MeetingPanelInviteOutcome =
  | 'ok'
  | 'cap_reached'
  | 'already_invited'
  | 'rate_limited'
  | 'failed';

/** How a re-send or a download resolved. Binary — neither has a race or a refusal shape. */
export type MeetingPanelOutcome = 'ok' | 'failed';

/**
 * How a file share resolved.
 *
 * ⚠ `rejected` IS A **CLIENT-SIDE OR SERVER-SIDE VALIDATION** REFUSAL (wrong type, too
 * large, empty, unusable name) and `duplicate` is the expected double-click. Neither is
 * `failed`, which means the upload genuinely broke.
 */
export type MeetingPanelFileOutcome = 'ok' | 'rejected' | 'duplicate' | 'failed';

/**
 * A coarse size band.
 *
 * ⚠ A BUCKET, NOT A BYTE COUNT, AND NEVER THE FILE NAME. An exact size plus a timestamp is a
 * near-unique fingerprint of a specific document; the product question is only "are people
 * sharing screenshots or decks?".
 */
export type MeetingPanelSizeBucket = 'under_100kb' | 'under_1mb' | 'under_5mb' | 'over_5mb';

export interface MeetingPanelEventMap {
  [MEETING_PANEL_EVENTS.OPENED]: {
    meeting_id?: string;
    /** ⚠ ON OPEN ONLY. A close event would double every open in a funnel for no question. */
    panel: MeetingPanelId;
  };
  [MEETING_PANEL_EVENTS.GUEST_DECIDED]: {
    meeting_id?: string;
    decision: MeetingPanelAdmissionDecision;
    outcome: MeetingPanelDecisionOutcome;
  };
  [MEETING_PANEL_EVENTS.GUESTS_INVITED]: {
    meeting_id?: string;
    outcome: MeetingPanelInviteOutcome;
    /** How many addresses were submitted. ⚠ A COUNT — never the addresses. */
    guest_count: number;
  };
  [MEETING_PANEL_EVENTS.JOIN_LINK_COPIED]: {
    meeting_id?: string;
  };
  [MEETING_PANEL_EVENTS.LINK_RESENT]: {
    meeting_id?: string;
    outcome: MeetingPanelOutcome;
  };
  [MEETING_PANEL_EVENTS.FILE_SHARED]: {
    meeting_id?: string;
    outcome: MeetingPanelFileOutcome;
    size_bucket: MeetingPanelSizeBucket;
  };
  [MEETING_PANEL_EVENTS.FILE_DOWNLOADED]: {
    meeting_id?: string;
    outcome: MeetingPanelOutcome;
  };
}
