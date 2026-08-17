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

import type { MeetingReactionEmoji } from '@balo/shared/meetings';

export const MEETING_PANEL_EVENTS = {
  OPENED: 'meeting_panel_opened',
  GUEST_DECIDED: 'meeting_panel_guest_decided',
  GUESTS_INVITED: 'meeting_panel_guests_invited',
  JOIN_LINK_COPIED: 'meeting_panel_join_link_copied',
  LINK_RESENT: 'meeting_panel_link_resent',
  FILE_SHARED: 'meeting_panel_file_shared',
  FILE_DOWNLOADED: 'meeting_panel_file_downloaded',
  // ── BAL-437 — the chat slot and the reaction control ────────────────────────────────
  MESSAGE_SENT: 'meeting_panel_message_sent',
  REACTION_SENT: 'meeting_panel_reaction_sent',
} as const;

/**
 * Which slot the single-slot panel is showing.
 *
 * ⚠ BAL-437 ADDED `'chat'` HERE, WHICH MAKES `OPENED` FIRE WITH `panel: 'chat'` FOR FREE — the
 * forward reference this line used to carry is now discharged.
 *
 * ⚠⚠ BAL-403 ADDED `'balance'` — AND THIS DECLARATION MUST STAY IN SYNC WITH THE OTHER ONE,
 * `apps/web/src/lib/meetings/meeting-panels.ts`'s `MeetingPanelId`. The two are independent
 * (this package cannot import from `apps/web`), so a future slot must be added to BOTH by hand.
 */
export type MeetingPanelId = 'people' | 'files' | 'chat' | 'balance';

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

/**
 * How an in-call message send resolved.
 *
 * ⚠ `rejected` IS A VALIDATION REFUSAL the person can fix (empty, over the character limit, a
 * closed thread); `failed` means the send genuinely broke. Collapsing them would make "people
 * are typing over the limit" look like an outage.
 */
export type MeetingPanelMessageOutcome = 'ok' | 'rejected' | 'failed';

/**
 * The six-member reaction set.
 *
 * ⚠⚠ **AN ALIAS OF THE ONE DEFINITION IN `@balo/shared/meetings`, NOT A RESTATEMENT.** An
 * earlier version of this line hand-wrote the six glyphs and argued that `@balo/analytics`
 * cannot import `apps/web`. The premise was true and the conclusion was wrong: the fix for a
 * set two packages both need is to move it to the package they BOTH depend on, which is what
 * `@balo/shared` is for (CLAUDE.md — one definition, in the owning package). While it was
 * restated, adding a seventh emoji in `apps/web` and forgetting this line typechecked on both
 * sides and only showed up as a missing PostHog breakdown bucket.
 *
 * ⚠ THE ALIAS NAME IS KEPT because `AllEvents`, the `apps/web` re-export allowlist and the
 * client barrel all name it; re-pointing those would be churn for no behavioural gain.
 *
 * ⚠ THE GLYPH IS THE PRODUCT QUESTION ("which reactions do people actually use?") and it is
 * NOT personal data. The SENDER is — which is why no event below carries one.
 */
export type MeetingPanelReactionEmoji = MeetingReactionEmoji;

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
  /** ⚠ AN OUTCOME AND NOTHING ELSE. Never the body, never a length, never a preview. */
  [MEETING_PANEL_EVENTS.MESSAGE_SENT]: {
    meeting_id?: string;
    outcome: MeetingPanelMessageOutcome;
  };
  /**
   * ⚠⚠ THE GLYPH AND AN OUTCOME — **NEVER A SENDER AND NEVER THE `nonce`.** The nonce is an
   * echo-suppression tag; sent to PostHog it would correlate one person's taps across a call
   * for no product question anybody asked.
   */
  [MEETING_PANEL_EVENTS.REACTION_SENT]: {
    meeting_id?: string;
    emoji: MeetingPanelReactionEmoji;
    outcome: MeetingPanelOutcome;
  };
}
