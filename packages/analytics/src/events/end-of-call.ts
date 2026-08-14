import type { EndOfCallReviewState } from '@balo/shared/reviews';
import type { RecapContextType, RecapLens } from './recap';

/**
 * BAL-389 (ADR-1043 / ADR-1045) — the END-OF-CALL screen's analytics.
 *
 * ONE client event (`end_of_call_action`, fired from the rating/resolve island) + ONE server
 * event (`end_of_call_viewed`, fired from the page RSC).
 *
 * ⚠⚠ THIS FILE IS MIXED (client AND server halves), so its registration is the SAME NINE
 * PATHS `recap.ts` documents — the events barrel, `types.ts` (`AllEvents` AND `ServerEvents`),
 * the package `client/` AND `server/` allowlists, the `apps/web` client AND RSC allowlists, and
 * the `apps/web` test `vi.mock` list (CLIENT constants only — `END_OF_CALL_SERVER_EVENTS` must
 * never join it).
 *
 * ⚠⚠ NO CONSTANT AND NO ENUM VALUE IS DECLARED WITHOUT A PRODUCER — the rule `recap.ts` states
 * for event names binds enum VALUES just as hard. Two values the ticket's prose lists are
 * deliberately ABSENT, and `end-of-call.test.ts` pins each by name:
 *   · `case_resolved` — it is NOT an `end_of_call_action`. Closing a case is ONE business fact
 *     with ONE event name, `RECAP_SERVER_EVENTS.CASE_RESOLVED`, whose required `source`
 *     property was built for exactly this ticket. A parallel client event would make
 *     `count(case_resolved)` wrong and force every funnel to union two names forever.
 *   · `rejoin` — there is no live destination for a Rejoin affordance. `/join/m/[meetingId]`
 *     is the ANONYMOUS lobby (the wrong arm for a signed-in member), the member arm
 *     `joinAsMemberAction` has no entry point by design, and both terminate at
 *     `MeetingCallSurface`'s "Connecting…" because no Daily SDK ships in `apps/web`. BAL-435
 *     adds the button, the destination and this value together.
 *
 * ⚠⚠ `back_to_case` WAS ABSENT AND IS NOW DECLARED — THE NO-PRODUCER RULE WORKING FORWARDS,
 * NOT A REVERSAL OF IT. It was withheld because the onward CTA was unconditionally "View recap"
 * while `/cases` did not exist; BAL-421 shipped that surface, the owner restored the design's
 * two-state CTA, and the value arrived WITH its producer in the same change. Its emitter is
 * `end/_components/onward-cta.tsx`, on the processing arm only.
 */

/**
 * Which recap-readiness the end-of-call screen rendered.
 *
 * ⚠ TWO VALUES, AND IT IS NOT `RecapState`. This screen has a TWO-WAY render (the design's
 * `Recap: processing | ready` toggle); four of `RecapState`'s six values have no producer here,
 * and a dimension value nothing emits reads as a 100%-drop-off funnel step. `failed` and
 * `absent` fold into `processing` on purpose — the recap page renders its own failure state,
 * and this screen's only job is to decide whether to promise the recap is on its way.
 */
export type EndOfCallRecapState = 'ready' | 'processing';

/**
 * Which of BAL-390's three rating states the client lens rendered — ALIASED, NOT RESTATED.
 *
 * The alias is the point: `EndOfCallReviewState` is `resolveEndOfCallReviewState`'s return
 * discriminant, so `tsc` pins this dimension to the resolver forever. Hand-copying the ticket's
 * prose spelling (`none` / `high` / `low`) would have produced a union that silently disagrees
 * with the only function that can decide the boundary.
 */
export type EndOfCallRatingState = EndOfCallReviewState['kind'];

/**
 * Which forward action was taken on the end-of-call screen.
 *
 * `rated` vs `rating_revised` comes free from the shipped write path:
 * `submitEngagementReviewAction` returns `{ success: true, created: boolean }`, so the island
 * emits `created ? 'rated' : 'rating_revised'` and the dimension cannot disagree with what the
 * database actually did.
 *
 * ⚠ `view_recap` AND `back_to_case` ARE THE **SAME** SLOT IN TWO STATES, WHICH IS EXACTLY WHY
 * THEY ARE TWO VALUES AND NOT ONE. The screen renders ONE onward button; a ready recap sends the
 * viewer to `/meetings/{id}?from=end_of_call`, a processing one sends them to `/cases/{id}`.
 * Collapsing them to a single `onward` value would throw away the only thing worth measuring
 * here — whether people who land on a not-yet-ready recap go anywhere useful at all.
 */
export type EndOfCallAction = 'view_recap' | 'back_to_case' | 'rated' | 'rating_revised';

// ── Client (browser `track`) ──────────────────────────────────────────────
export const END_OF_CALL_EVENTS = {
  /** A forward action on the end-of-call screen was taken. */
  ACTION: 'end_of_call_action',
} as const;

export interface EndOfCallEventMap {
  [END_OF_CALL_EVENTS.ACTION]: {
    action: EndOfCallAction;
    lens: RecapLens;
  };
}

// ── Server (`trackServer`, from `apps/web`) ───────────────────────────────
export const END_OF_CALL_SERVER_EVENTS = {
  /** The end-of-call screen rendered for an authorised viewer. */
  VIEWED: 'end_of_call_viewed',
} as const;

export interface EndOfCallServerEventMap {
  [END_OF_CALL_SERVER_EVENTS.VIEWED]: {
    recap_state: EndOfCallRecapState;
    /** `null` on the EXPERT lens — the rating is structurally absent there, not merely hidden. */
    rating_state: EndOfCallRatingState | null;
    /**
     * Server-side truth at FIRST PAINT. A later client-side reveal (the rate-first-then-resolve
     * ordering rule) is deliberately NOT re-tracked as a second view — it is already legible as
     * `end_of_call_action: 'rated'` followed by `case_resolved{source:'end_of_call'}`.
     *
     * ⚠⚠ THIS MEANS "AN ASK WAS SHOWN", NOT "THE `ResolvePrompt` COMPONENT MOUNTED" — the two
     * conditions differ by exactly one term and the difference is DELIBERATE. `RateThenResolve`
     * mounts `ResolvePrompt` whenever `ratingExists && resolve !== null`, so on an
     * ALREADY-CLOSED case it mounts and renders its terminal `done` arm ("Case closed."). This
     * dimension additionally requires `!resolve.alreadyClosed`, so that same render reports
     * `false`. That is correct for a funnel: an acknowledgement of a case closed earlier is not
     * an opportunity to resolve, and counting it would inflate the denominator of
     * `case_resolved{source:'end_of_call'} / resolve_prompt_shown` with views that could never
     * convert. If a future edit makes the component's mount condition and this predicate agree,
     * that is a REGRESSION, not a tidy-up — read this note first.
     */
    resolve_prompt_shown: boolean;
    context_type: RecapContextType;
    lens: RecapLens;
    /** = the viewing user id. */
    distinct_id: string;
  };
}
