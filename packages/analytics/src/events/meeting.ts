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
     * ⚠ WIDER than `MeetingBookingContextType` on purpose: a meeting is BOOKED under four
     * labels but JOINED under any context that resolves, which includes `request_interaction`
     * and `retainer_checkin`.
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
     */
    is_owner: boolean;
    /** The joining MEMBER's user id. */
    distinct_id: string;
  };
}
