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
 *   · `guest_converted_to_member` — there is no guest lens on this surface (D-A; BAL-439 owns
 *     the guest recap arm — BAL-445 opened read-only meeting files and in-call chat to a
 *     guest, but the recap stays closed, deliberately, via `resolve-recap-access.ts`'s own
 *     guest gate). `events/guest.ts` already refuses this constant for the same reason and is
 *     NOT touched by this ticket.
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
 * `?from=notification`.
 *
 * ⚠ `case_surface` WAS ADDED BY BAL-421, WHICH IS THE TICKET THAT EMITS IT — exactly as the
 * rule prescribes ("add each value in the ticket that emits it"). Its producer is
 * `apps/web/.../cases/[engagementId]/_lib/map-case-consultations.ts`, whose `recapHref` is
 * `/meetings/{id}?from=case_surface` on every consultation row that has a recap destination.
 *
 * ⚠ `end_of_call` WAS ADDED BY BAL-389 UNDER THE SAME RULE. The end-of-call screen's ready-state
 * CTA links to `/meetings/{id}?from=end_of_call`, and `resolveEntrySource` in
 * `meetings/[meetingId]/page.tsx` was widened in the SAME ticket to recognise it — declaring the
 * value without widening that whitelist would silently collapse it to `direct` and ship a
 * declared-but-never-emitted dimension.
 */
export type RecapEntrySource = 'direct' | 'notification' | 'case_surface' | 'end_of_call';

/**
 * Which forward action was clicked ON THE CASE SURFACE (BAL-421).
 *
 * ⚠ SEPARATE FROM {@link RecapCta}, DELIBERATELY. The two surfaces offer genuinely different
 * actions, and one union spanning both would let a recap-only value be reported from the case
 * surface (and vice versa) with nothing to catch it.
 *
 * ⚠ NO `slot_quick_pick`, AND THAT IS THE NO-PRODUCER RULE BINDING AGAIN. The design
 * reference draws a next-available-slot strip, but owner decision D5 struck it: there is NO
 * slot-listing endpoint anywhere on the platform, so the case surface renders a plain
 * "Book another consultation" affordance (`book_another`) and nothing can emit a quick pick.
 * BAL-400 declares that value when it builds the thing that produces it.
 *
 * ⚠⚠ NO `invite` EITHER, AND THIS ONE IS WORTH READING TWICE BECAUSE THE DESIGN REFERENCE
 * DRAWS THE BUTTON. BAL-421 does NOT ship the "Invite a colleague" affordance, for two
 * independent reasons: (1) `apps/web` has NO seam that creates a guest invite — it only has
 * the `/join/[token]` LANDING that consumes one, so there is nothing to call; and (2) guest
 * scoping is INERT on `main` — `resolveGuestConversationScope` has zero production callers and
 * `/join/[token]` resolves an identity CLAIM with no guest read session behind it. Shipping a
 * button whose copy promises "anyone invited sees this whole case" while the grant grants
 * nothing readable would be a lie about what the invite does, which is the same reasoning that
 * forbids anchoring an invite to a past meeting. The ticket that builds the invite declares
 * this value.
 */
export type CaseSurfaceAction =
  | 'book_another'
  | 'mark_resolved'
  | 'request_resolution'
  | 'dismiss_resolution_request'
  | 'view_recap'
  | 'download_file';

/**
 * Which lifecycle state the case surface rendered in.
 *
 * Mirrors `case_engagements.closed_at` + `close_reason`: an OPEN case, one a client marked
 * `resolved`, or one the +30d sweep closed as `auto_inactive`. The two closed reasons stay
 * DISTINCT because the surface renders visibly different copy for them, and collapsing them
 * would hide whether cases are being resolved deliberately or merely going quiet — which is
 * the single most useful thing this dimension can tell anyone.
 */
export type CaseSurfaceState = 'open' | 'resolved' | 'auto_inactive';

/**
 * WHERE a case close was initiated — the `case_resolved` dimension, declared ONCE.
 *
 * ⚠⚠ ONE BUSINESS FACT, ONE EVENT NAME. A parallel `end_of_call_case_resolved` event would
 * make `count(case_resolved)` wrong and force every funnel to union two names forever, so each
 * new closing surface widens THIS union and threads the value instead.
 *
 * ⚠ BAL-421's `case_surface` IS THE SECOND ENTRY POINT, NOT A SECOND EVENT, and BAL-389's
 * `end_of_call` is the third. There is deliberately NO `case_resolved_manually`: minting one
 * would split the very distribution this property exists to measure across two event names, so
 * the closes would stop being comparable at exactly the moment there were finally several to
 * compare. Every entry point calls the SAME `caseEngagementsRepository.close()` and the same
 * post-commit half (`@/lib/cases/close-case-effects`); only the `source` differs, which is the
 * point.
 *
 * ⚠ `sweep` is still NOT declared — the +30d dormancy sweep closes with `auto_inactive` from
 * `apps/api` without emitting this event at all. The ticket that emits it declares the value.
 */
export type CaseResolveSource = 'recap' | 'end_of_call' | 'case_surface';

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
  /**
   * BAL-421 — a forward action on the CASE SURFACE was clicked.
   *
   * ⚠ IT LIVES IN `RECAP_EVENTS` RATHER THAN A NEW `CASE_SURFACE_EVENTS` OBJECT, AND THAT IS A
   * REGISTRATION DECISION, NOT LAZINESS. This file already owns the case RESOLUTION lifecycle
   * (`case_resolved`, `case_resolution_request_dismissed`), so the surface's actions belong
   * beside them. It is also six fewer allowlist edits: `RECAP_EVENTS` is ALREADY re-exported
   * through `events/index.ts`, `types.ts`'s `AllEvents`, the package client barrel, the
   * `apps/web` client barrel AND `apps/web/src/test/setup.ts`'s `vi.mock` list — none of which
   * has a typecheck that would notice an omission (memory
   * `reference_analytics_registration_is_five_files`). Adding a KEY to an existing constant
   * needs no allowlist change at all.
   */
  CASE_ACTION_CLICKED: 'case_action_clicked',
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
  [RECAP_EVENTS.CASE_ACTION_CLICKED]: {
    action: CaseSurfaceAction;
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
  /**
   * BAL-421 — the CASE SURFACE rendered for an authorised viewer.
   *
   * ⚠ A SERVER EVENT, NOT A CLIENT ONE, and the precedent is exact: `RECAP_VIEWED` and
   * `engagement_workspace_viewed` are both page-views of an AUTHORIZED RSC and both fire
   * server-side. A client event would fire before authorization is observable (so a denied
   * viewer could still register a view), and would need three extra allowlist entries.
   */
  CASE_SURFACE_VIEWED: 'case_surface_viewed',
} as const;

export interface RecapServerEventMap {
  [RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED]: {
    /**
     * ⚠ OPTIONAL AS OF BAL-421, AND THE ABSENCE IS MEANINGFUL RATHER THAN MISSING DATA.
     * The recap always has a meeting in scope and keeps sending it, so shipped behaviour and
     * its test are untouched. The CASE SURFACE has NO meeting in scope — the client dismisses
     * the banner from `/cases/{engagementId}` — and there is nothing honest to put here.
     *
     * ⚠ NEVER FABRICATE ONE, and never send "the most recent meeting" to keep the field
     * populated: that would attribute a dismissal to a consultation that had nothing to do
     * with it, which is worse for analysis than a null. `engagement_id` is always present and
     * is the field that actually identifies the case.
     */
    meeting_id?: string;
    engagement_id: string;
    /** = the acting user id. */
    distinct_id: string;
  };
  [RECAP_SERVER_EVENTS.CASE_RESOLVED]: {
    /**
     * WHERE the close was initiated. The ticket is explicit that the source distribution
     * across recap / end-of-call / case surface / sweep is the evidence for whether asking
     * at the natural moment works at all, so this stays a required property.
     *
     * ⚠ THE UNION IS NAMED, NOT INLINED — see {@link CaseResolveSource}, which is where the
     * one-business-fact-one-event-name reasoning lives and where each new closing surface
     * widens the set. Widen it THERE, in the ticket that emits the new value.
     */
    source: CaseResolveSource;
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
  [RECAP_SERVER_EVENTS.CASE_SURFACE_VIEWED]: {
    /** The viewer's resolved SIDE. Never `activeMode`, never a role. */
    lens: RecapLens;
    /** EVERY consultation on the case, cancelled and no-show ones included. */
    consultation_count: number;
    case_state: CaseSurfaceState;
    /** = the viewing user id. */
    distinct_id: string;
  };
}
