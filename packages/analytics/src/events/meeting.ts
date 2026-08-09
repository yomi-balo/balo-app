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
 * typecheck rather than here (`@balo/analytics` has no typecheck or test script of its own).
 */
import type { MeetingBookingContextType } from '@balo/shared/meetings';

export const MEETING_SERVER_EVENTS = {
  MEETING_PROVISIONED: 'meeting_provisioned',
  MEETING_PROVISION_FAILED: 'meeting_provision_failed',
} as const;

/**
 * The four labels `POST /meetings` accepts — RE-EXPORTED, never restated.
 *
 * ⚠ IT IS DERIVED FROM `BOOKABLE_CONTEXT_TYPES` IN `@balo/shared/meetings`, which is the same
 * `as const` tuple `apps/api`'s Zod enum and its tenancy gate read. A hand-written union here
 * (which is what shipped first) is a third copy of the list in a third package, and nothing
 * would have failed if it drifted: `@balo/analytics` has no typecheck and no test script, so
 * a label admitted at the route and missing here would surface only as an `apps/api` type
 * error at the emission site — or not at all, if the union were the WIDER of the two.
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
}
