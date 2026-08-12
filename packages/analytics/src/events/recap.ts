import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

/**
 * BAL-388 (ADR-1043 / ADR-1045) — post-meeting RECAP analytics.
 *
 * THREE client events (browser `track`, fired from the recap's interactive islands) + THREE
 * server events (`trackServer` from `apps/web` — the page RSC and the two Server Actions).
 * Values do NOT share one feature prefix (`recap_*` for the surface, `case_*` for the
 * resolution lifecycle), so the key-set guard uses the GENERIC snake_case matcher.
 *
 * ⚠⚠ THIS FILE IS MIXED (client AND server halves), WHICH IS WHY ITS REGISTRATION IS NINE
 * PATHS RATHER THAN THE THREE CLAUDE.md LISTS OR THE FIVE THE MEMORY NOTE LISTS. It takes the
 * UNION of both checklists: the events barrel, `types.ts` (`AllEvents` AND `ServerEvents`), the
 * package `client/` AND `server/` allowlists, the `apps/web` client AND RSC allowlists, and the
 * `apps/web` test `vi.mock` list (CLIENT constants only — the server half must never join it).
 *
 * ⚠⚠ NO CONSTANT IS DECLARED WITHOUT A PRODUCER. Three events the design considered are
 * deliberately ABSENT, and `recap.test.ts` pins each by name:
 *   · `recap_recording_played` — no recording exists anywhere (owner decision D-B; capture is
 *     BAL-126 / BAL-140's). It moves with the recording scope, whole.
 *   · `recap_export` — no export exists (D-B).
 *   · `guest_converted_to_member` — there is no guest lens on this surface (D-A; BAL-132 owns
 *     the guest arm). `events/guest.ts` already refuses this constant for the same reason and
 *     is NOT touched by this ticket.
 * A constant with no emitter reads as a 100% drop-off funnel step in PostHog.
 */

/**
 * Which artefact/outcome state the recap rendered in.
 *
 * SIX values, not the ticket's three: the ARTEFACT-ABSENT reality is the COMMON case today
 * (the transcript pipeline has no production enqueuer), so it has to be measurable from day
 * one rather than hiding inside `processing`.
 */
export type RecapState =
  | 'ready'
  | 'processing'
  | 'artifacts_absent'
  | 'artifacts_failed'
  | 'not_held'
  | 'cancelled';

/** Which side of the meeting the viewer resolved onto. Never `activeMode`, never a role. */
export type RecapLens = 'client' | 'expert';

/**
 * The primary meeting context the recap rendered — ALIASED, NOT RESTATED.
 *
 * `MeetingContextTypeWithHolder` is `Exclude<MeetingContextTypeLabel, 'admin'>`, and that
 * `Exclude` states in the type what a hand-copied six-member union could only state in prose:
 * `selectPrimaryMeetingContext` DROPS `admin` rows, so an admin-only meeting resolves to no
 * primary context and the recap 404s before anything is tracked. `bookable-contexts.ts` names
 * the copy-a-union anti-pattern by name ("a hand-copied union in a third package is a drift
 * waiting to happen"), and `meeting.ts` / `guest.ts` / `review.ts` all import rather than
 * restate. A seventh `meeting_context_type` label now reaches this event through `tsc`.
 */
export type RecapContextType = MeetingContextTypeWithHolder;

/**
 * How the viewer arrived. `direct` absorbs anything unrecognised.
 *
 * ⚠ ONLY VALUES WITH A LIVE PRODUCER ARE DECLARED — the same no-producer rule {@link RecapCta}
 * applies to CTA values. `notification` is real: BOTH re-pointed recap deep links (the
 * `recap-ready` email and its in-app twin, and the `engagement.case_closed` pair) append
 * `?from=notification`. `end_of_call` and `case_surface` are NOT declared: nothing writes
 * `?from=` on a `/meetings/{id}` URL from either surface, because neither surface exists yet
 * (BAL-389 / BAL-421). Add each value in the ticket that emits it — a value nothing produces
 * reads as a 100%-drop-off funnel dimension.
 */
export type RecapEntrySource = 'direct' | 'notification';

/**
 * Which shape the resolve prompt took, when it was shown.
 *
 * ⚠ DECLARED ONCE, HERE. `apps/web`'s `recap-view-types.ts` RE-EXPORTS this type as
 * `RecapResolveVariant` rather than declaring a second three-member union under a second name —
 * the web variant feeds this analytics property directly, and nothing else would pin them equal.
 *
 * This is the sharper half of the measurement: it separates the EXPERT'S ASK (`requested` —
 * the banner) from the platform's UNPROMPTED OFFER (`offered` — the rail card). Whether the
 * ask converts better than the offer is what decides how much BAL-421 should invest in the
 * expert-side ask-if-it-is-resolved affordance.
 */
export type RecapResolvePromptVariant = 'requested' | 'offered' | 'none';

/**
 * Which forward action was clicked.
 *
 * ⚠ ONLY VALUES THAT CAN ACTUALLY FIRE ARE DECLARED, and the no-producer rule binds enum
 * VALUES exactly as it binds event names. `turn_into_project`, `send_proposal`, `add_note`
 * and `offer_new_time` have NO live destination in `apps/web/src/app` today, so the recap
 * renders no CTA for them (never a disabled one) and they are not declarable here.
 */
export type RecapCta = 'book_again' | 'case_resolved';

// ── Client (browser `track`) ──────────────────────────────────────────────
export const RECAP_EVENTS = {
  /** The transcript section was expanded. */
  TRANSCRIPT_OPENED: 'recap_transcript_opened',
  /** A meeting file was downloaded from the recap Files card. */
  FILE_DOWNLOADED: 'recap_file_downloaded',
  /** A forward action on the recap was clicked. */
  CTA_CLICKED: 'recap_cta_clicked',
} as const;

export interface RecapEventMap {
  [RECAP_EVENTS.TRANSCRIPT_OPENED]: {
    meeting_id: string;
  };
  [RECAP_EVENTS.FILE_DOWNLOADED]: {
    meeting_id: string;
    content_type: string;
  };
  [RECAP_EVENTS.CTA_CLICKED]: {
    cta: RecapCta;
    lens: RecapLens;
  };
}

// ── Server (`trackServer`, from `apps/web`) ───────────────────────────────
export const RECAP_SERVER_EVENTS = {
  /** The client dismissed the expert's resolution request. No notification fires (D-E). */
  CASE_RESOLUTION_REQUEST_DISMISSED: 'case_resolution_request_dismissed',
  /** A case was marked resolved. `source` is the whole point — see the map below. */
  CASE_RESOLVED: 'case_resolved',
  /** The recap page rendered for an authorised viewer. */
  RECAP_VIEWED: 'recap_viewed',
} as const;

export interface RecapServerEventMap {
  [RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED]: {
    meeting_id: string;
    engagement_id: string;
    /** = the acting user id. */
    distinct_id: string;
  };
  [RECAP_SERVER_EVENTS.CASE_RESOLVED]: {
    /**
     * WHERE the close was initiated. The ticket is explicit that the source distribution
     * across recap / end-of-call / case surface / sweep is the evidence for whether asking
     * at the natural moment works at all, so this stays a required property.
     */
    source: 'recap';
    engagement_id: string;
    /** = the acting user id. */
    distinct_id: string;
  };
  [RECAP_SERVER_EVENTS.RECAP_VIEWED]: {
    recap_state: RecapState;
    context_type: RecapContextType;
    lens: RecapLens;
    source: RecapEntrySource;
    resolve_prompt_shown: boolean;
    resolve_prompt_variant: RecapResolvePromptVariant;
    /** = the viewing user id. */
    distinct_id: string;
  };
}
