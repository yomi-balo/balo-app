/**
 * BAL-129 (ADR-1044 / ADR-1045) — meeting provisioning analytics.
 *
 * SERVER-ONLY: emitted from the `apps/api` provisioning service
 * (`services/meetings/provision-meeting.ts`) via `trackServer`. They MUST NOT be added to
 * `AllEvents` (the client union) nor to the `apps/web/src/test/setup.ts` client mock — the
 * `REVIEW_SERVER_EVENTS` precedent. NO PII: ids, labels and durations only.
 *
 * ⚠ REGISTRATION IS FOUR FILES, NOT THREE. CLAUDE.md's checklist omits
 * `packages/analytics/src/server/index.ts`, and `apps/api` imports from
 * `@balo/analytics/server` — so skipping that re-export leaves these constants
 * unimportable from the only app that emits them, and the failure lands in `apps/api`'s
 * typecheck rather than here — a missing re-export is invisible to any check that compiles
 * only this package's own sources, including its `typecheck` script.
 */
import type {
  MeetingBookingContextType,
  MeetingContextTypeWithHolder,
} from '@balo/shared/meetings';

export const MEETING_SERVER_EVENTS = {
  MEETING_PROVISIONED: 'meeting_provisioned',
  MEETING_PROVISION_FAILED: 'meeting_provision_failed',
  /**
   * BAL-132 — a MEMBER's Daily meeting token was successfully minted. The member half of the
   * join funnel; the guest half is `guest_joined` in `events/guest.ts`.
   */
  MEETING_JOIN_GRANTED: 'meeting_join_granted',
  // ── BAL-134 / ADR-1049 — the lifecycle. ────────────────────────────────────────────────
  /** The expert and ≥1 client-side participant were both observed in the room. */
  MEETING_STARTED: 'meeting_started',
  /** An expert waited alone, gave up BELOW the no-show floor, and the wait was terminated. */
  MEETING_WAITING_ABANDONED: 'meeting_waiting_abandoned',
  /** The Balo-ops salvage alert actually PUBLISHED — not merely that it was scheduled. */
  MEETING_EXPERT_ABSENT_ALERT: 'meeting_expert_absent_alert',
  /** Nobody delivering ever turned up and the meeting was terminated as a missed call. */
  MEETING_MISSED_CALL: 'meeting_missed_call',
  /** EVERY terminal path — the four system rules and the human End alike. */
  MEETING_ENDED: 'meeting_ended',
} as const;

/**
 * The four labels `POST /meetings` accepts — RE-EXPORTED, never restated.
 *
 * ⚠ IT IS DERIVED FROM `BOOKABLE_CONTEXT_TYPES` IN `@balo/shared/meetings`, which is the same
 * `as const` tuple `apps/api`'s Zod enum and its tenancy gate read. A hand-written union here
 * (which is what shipped first) is a third copy of the list in a third package, and when this
 * was written nothing would have failed if it drifted — `@balo/analytics` had no `scripts`
 * block at all, so root `pnpm typecheck` never reached it and Vitest transpiles via esbuild
 * WITHOUT type checking. A label admitted at the route and missing here surfaced only as an
 * `apps/api` type error at the emission site, or not at all if the union were the WIDER of the
 * two. ⚠ BAL-132 ADDED A `typecheck` SCRIPT to this package, so the re-export is now checked
 * here too — but the derivation stays, because one source of truth beats two that agree.
 */
export type { MeetingBookingContextType };

export interface MeetingServerEventMap {
  [MEETING_SERVER_EVENTS.MEETING_PROVISIONED]: {
    meeting_id: string;
    /** TOTAL — always present. */
    context_type: MeetingBookingContextType;
    /**
     * D4: present ONLY when the context resolves to an ENGAGEMENT. `null` for
     * `project_discovery`, which anchors on a `project_requests.id` and has no engagement
     * — and therefore no supertype discriminator to read. Emitting a fabricated or
     * defaulted value here would corrupt the funnel this event exists to measure.
     */
    engagement_type: 'case' | 'project' | 'package' | null;
    duration_minutes: number;
    /** Minutes from the provisioning instant to `scheduled_start` — booking lead time. */
    lead_time_minutes: number;
    /** `true` when this was an idempotent replay: no Daily call, no write (D2). */
    idempotent_replay: boolean;
    distinct_id: string;
  };
  /**
   * ⚠ NOT OPTIONAL GARNISH. A vendor failure still returns `201` (the booking committed —
   * see §3.2), so without this event the failure is invisible to product analytics and
   * shows up only in logs.
   */
  [MEETING_SERVER_EVENTS.MEETING_PROVISION_FAILED]: {
    meeting_id: string;
    context_type: MeetingBookingContextType;
    engagement_type: 'case' | 'project' | 'package' | null;
    /** `DailyConfigError` | `DailyApiError` | other — the error CLASS, never the message. */
    reason: string;
    distinct_id: string;
  };
  /**
   * BAL-132 — one successful MEMBER token mint.
   *
   * ⚠ A MINT EVENT, exactly like `guest_joined`: it fires on every rejoin after a network
   * drop and on every second device. Count DISTINCT `distinct_id`, never raw events.
   *
   * ⚠ NO `token`, NO `roomUrl`, NO `participantId` — EVER. The Daily JWT is a credential and
   * never leaves the response; the room url is derivable from the meeting id and buys nothing
   * here; and `participant_id` would be a second spelling of `distinct_id` + `meeting_id`.
   */
  [MEETING_SERVER_EVENTS.MEETING_JOIN_GRANTED]: {
    meeting_id: string;
    /**
     * The PRIMARY context's type (the D3 precedence winner) — the SIX HOLDER-BEARING labels.
     *
     * ⚠ WIDER than `MeetingBookingContextType` on purpose: a meeting is BOOKED under FIVE
     * labels — which now INCLUDES `request_interaction` (BAL-283 widened
     * `BOOKABLE_CONTEXT_TYPES`) — but JOINED under any context that resolves, which adds
     * `retainer_checkin`.
     *
     * ⚠⚠ AND NARROWER THAN `MeetingContextTypeLabel` — `admin` IS STRUCTURALLY UNREACHABLE
     * HERE, so declaring it invited a consumer to write a branch that can never run. The sole
     * producer is `joinMeetingAsMember`, whose `subject` is a `PrimaryMeetingContext`, whose
     * `contextType` is `MeetingContextTypeWithHolder` by construction: an `admin` meeting has
     * no holder, so it resolves on the PLATFORM axis and never reaches a member join grant.
     * `guest_invite_opened` keeps the wider type deliberately — a different producer.
     */
    context_type: MeetingContextTypeWithHolder;
    /**
     * Whether the token carries Daily owner rights — i.e. the `hasEngagementCapability(
     * HOST_MEETINGS)` verdict. The dimension that answers "is the right person hosting?".
     *
     * ⚠ THIS PROPERTY STAYS ON `isOwner` AND MUST NOT BE RETARGETED TO BAL-134's
     * `canEndMeeting`. It measures who holds DAILY OWNER RIGHTS, which is a different question
     * from who may press End — see `JoinGrant`'s six-field block.
     */
    is_owner: boolean;
    /** The joining MEMBER's user id. */
    distinct_id: string;
  };

  // ── BAL-134 / ADR-1049 — the lifecycle. ──────────────────────────────────────────────────
  //
  // ⚠⚠ `distinct_id` IS REQUIRED ON EVERY SERVER EVENT, AND FOUR OF THESE FIVE HAVE NO ACTING
  // HUMAN. `trackServer` destructures it and promotes it to PostHog's `distinctId`, and the
  // cast means a MISSING property silently becomes `undefined` — i.e. an event attributed to
  // nobody, invisible in every funnel. So the four SYSTEM paths carry the **`meetingId`**,
  // which is the same non-user shape `guest_joined` already uses with `meeting_guests.id`. Only
  // `meeting_ended` on the HUMAN path carries a real user id.

  /**
   * The consultation actually began: expert ∧ ≥1 client-side participant both in the room.
   *
   * ⚠ FIRES ONCE PER MEETING, guaranteed by the compare-and-set on `markInProgress`
   * (`in_progress` is not in its FROM set), so a rejoin cannot re-emit it.
   */
  [MEETING_SERVER_EVENTS.MEETING_STARTED]: {
    meeting_id: string;
    /** ⚠ SIGNED. Negative when both parties were early — that is a real and useful reading. */
    seconds_from_scheduled_start: number;
    /** Open intervals at the transition — includes `observer`s, unlike the billable clock. */
    participant_count: number;
    /** ⚠ The MEETING id. There is no acting human on a system-observed transition. */
    distinct_id: string;
  };

  /**
   * BAL-134 D9 — the ABANDONED WAIT. An expert held the room alone, left BELOW the no-show
   * floor, and nobody ever came.
   *
   * ⚠ IT IS NOT A NO-SHOW AND MUST NOT BE COUNTED AS ONE. `expertPresentMs` never reached the
   * floor, so nothing settles in the expert's favour; the meeting ends with a NULL outcome and
   * BAL-412 resolves it from the presence rows.
   */
  [MEETING_SERVER_EVENTS.MEETING_WAITING_ABANDONED]: {
    meeting_id: string;
    /** How long the expert actually held the room. ⚠ Always below the no-show floor. */
    expert_present_seconds: number;
    distinct_id: string;
  };

  /**
   * The Balo-ops salvage alert PUBLISHED.
   *
   * ⚠ EMITTED WHEN IT ACTUALLY PUBLISHES, NOT WHEN IT IS SCHEDULED. The promise is armed
   * minutes earlier and its fire-time recheck skips it whenever the expert turned up in the
   * meantime — which is the COMMON case. Counting schedules would report an operational
   * failure rate several times higher than the real one.
   */
  [MEETING_SERVER_EVENTS.MEETING_EXPERT_ABSENT_ALERT]: {
    meeting_id: string;
    minutes_past_start: number;
    distinct_id: string;
  };

  /** The missed-call rule fired: no expert interval EVER, past the termination threshold. */
  [MEETING_SERVER_EVENTS.MEETING_MISSED_CALL]: {
    meeting_id: string;
    /**
     * Did a client-side participant turn up to an empty room? The dimension that separates
     * "nobody came" from "the paying side was stood up", which are very different incidents.
     */
    client_joined: boolean;
    distinct_id: string;
  };

  /**
   * EVERY terminal path — the four system rules and the human End alike. The one event a
   * funnel can count meetings by.
   */
  [MEETING_SERVER_EVENTS.MEETING_ENDED]: {
    meeting_id: string;
    /** ⚠ MEASUREMENT, NOT MONEY. BAL-412 settles; this ticket only produces the numbers. */
    billable_seconds: number;
    expert_present_seconds: number;
    /** Presence intervals recorded across the whole meeting, all parties. */
    participant_count: number;
    /**
     * ⚠ `null` IS A REAL VALUE, NOT "unknown" (D5). The two HUMAN paths and the abandoned wait
     * deliberately leave it unset — the ender never sets the outcome.
     */
    outcome: 'completed' | 'no_show_client' | 'missed_call' | null;
    /** `meetings.ended_by`. ⚠ ALL FOUR system rules report `system_idle`; `outcome` separates them. */
    ended_by: 'client_principal' | 'expert_host' | 'system_idle';
    /** The acting user on a human End; the MEETING id on all four system paths. */
    distinct_id: string;
  };
}
