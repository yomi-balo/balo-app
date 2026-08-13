import type { EndOfCallRecapState, RecapContextType, RecapLens } from '@balo/analytics/events';
import type { EndOfCallReviewState } from '@balo/shared/reviews';

/**
 * BAL-389 — the end-of-call screen's single serializable contract. PLAIN TYPES ONLY: no values,
 * no functions, no constants.
 *
 * ⚠ CLIENT-SAFE BY CONSTRUCTION. Every import above is `import type`, so all four are ERASED at
 * build and none drags `postgres` into a browser bundle (memory
 * `reference_balo_db_client_bundle_footgun`: a client component that VALUE-imports `@balo/db`
 * breaks `next build` because postgres cannot resolve `tls`). `EndOfCallReviewState` comes from
 * `@balo/shared/reviews`, which exists as a `@balo/db`-free package for EXACTLY this reason —
 * its own docblock names BAL-389's client component as the caller it was carved out for. Do NOT
 * add a runtime import, a helper or a constant to this file.
 *
 * ⚠⚠ THE LENS IS A DISCRIMINANT, NOT A FLAG — AND THAT IS LAYER 1 OF THE STRUCTURAL PROOF that
 * the expert lens shows no rating and no resolve action. `EndOfCallView` is a UNION: THE EXPERT
 * ARM HAS NO `rating` FIELD AND NO `resolve` FIELD AT ALL. There is no optional property a bug
 * could populate and no flag a conditional could get wrong. The two `| null`s inside the CLIENT
 * arm carry the WITHIN-CLIENT absences (a non-rateable context; a non-case context) — the LENS
 * absence is carried by the union itself. Layer 2 is the loader, which never even READS the
 * rating or the case row on the expert path; layers 3 and 4 are the two compositions and the
 * source-scan test over them.
 *
 * ⚠ NOTHING MONEY-SHAPED APPEARS IN ANY SHAPE HERE, and nothing money-shaped is loaded on the
 * path that feeds it. The receipt lives on the recap (ADR-1044); this screen is throwaway and
 * carries no charge, no rate, no credit balance and no payout.
 */

/** The rating half of the client arm. `null` when the context carries no reviewable engagement. */
export interface EndOfCallRatingView {
  /** The engagement the review is anchored to — `meeting_contexts.context_id`. */
  engagementId: string;
  /**
   * BAL-390's three-state resolution, PASSED THROUGH UNTOUCHED from
   * `resolveEndOfCallReviewState`.
   *
   * ⚠⚠ NO COMPONENT MAY RE-DERIVE `rating < 4`, AND THE LOADER MUST NOT CALL THE RESOLVER A
   * SECOND TIME. The boundary is decided in exactly one place — `LOW_RATING_THRESHOLD` in
   * `@balo/shared/reviews`, via the resolver, via `readEngagementReview`. The client switches on
   * `state.kind` only. A literal `4` anywhere under this feature is a bug, and a source-scan
   * assertion pins its absence.
   */
  state: EndOfCallReviewState;
  /**
   * The viewer's existing review body, for PREFILLING the note on a revision.
   *
   * ⚠ A DELIBERATE DEVIATION FROM THE PROTOTYPE, which initialises the textarea to `''`.
   * Submitting a revision from an empty box would upsert `body: null` and SILENTLY DELETE the
   * client's own previous words. Prefilling initialises an existing field from the server rather
   * than inventing a state or a string.
   */
  existingBody: string | null;
}

/** The resolve half of the client arm. `null` on every non-`case` context. */
export interface EndOfCallResolveView {
  /** The case engagement id — the subject of the close. */
  engagementId: string;
  /**
   * Retrospective attribution for an OUTSTANDING expert resolution request — a person @ agency
   * on first mention, bare for an independent expert. `null` when no request is pending.
   *
   * ⚠ IT IS **CONTEXT**, NEVER A PENDING-APPROVAL STATE. The prompt stays the same ask with the
   * same two buttons; there is no approve/decline pair and no "awaiting" copy. Ignoring it does
   * nothing — no penalty, and no re-prompt on this screen.
   */
  requesterLabel: string | null;
  /**
   * TRUE once `case_engagements.closed_at` is set.
   *
   * ⚠ THE SINGLE FIELD, DELIBERATELY — there is no companion `canResolve`. Two booleans that
   * must always disagree is a drift waiting to happen; "can I still close this?" is exactly
   * `!alreadyClosed`, derived at each use. It ALSO backstops the prompt's local `done` step, so
   * the success state survives the `router.refresh()` the dialog fires (the recap's WrapUpCard
   * learned the same lesson: "resolved IS NOT the absence of a prompt").
   */
  alreadyClosed: boolean;
  /** The bare person/party name the confirmation dialog copy uses. */
  expertShortName: string;
}

interface EndOfCallBase {
  meetingId: string;
  contextType: RecapContextType;
  /** Drives the noun: `consultation` for a case, `meeting` otherwise. */
  isCase: boolean;
  /** The expert's given name (client lens) or the client COMPANY (expert lens). Never an email. */
  counterpartyName: string;
  /**
   * `ended_at − started_at` in whole minutes; `null` when either stamp is missing.
   *
   * ⚠ `null` IS 100% OF SESSIONS TODAY — BAL-134 owns the lifecycle stamps and is Backlog. The
   * duration line is then ENTIRELY ABSENT: no fallback to the scheduled window, no placeholder
   * copy, and never a bare zero.
   */
  durationMinutes: number | null;
  /** Two-way: does the onward CTA promise a recap that is on its way, or one that is ready? */
  recapState: EndOfCallRecapState;
  /**
   * `/cases/{engagementId}` when this meeting hangs off a CASE, otherwise `null` — resolved by
   * BAL-421's shipped `resolveCaseHref`, never hand-built here or in a component.
   *
   * ⚠⚠ `null` IS A REAL AND COMMON OUTCOME, AND IT DECIDES THE CTA. Only the `case` context's
   * `contextId` is an `engagements.id` that `/cases/{id}` can resolve; a project kickoff has NO
   * `/projects/{contextId}` destination of this shape, so there is nowhere to send the viewer.
   * When it is `null` the onward CTA FALLS BACK to "View recap" on both recap states rather than
   * rendering a dead link — the no-producer rule applied to a destination instead of an enum
   * value. See `onward-cta.tsx`.
   *
   * ⚠ ON **BOTH** LENS ARMS, DELIBERATELY. BAL-421's case surface is itself lens-aware (its
   * `case_surface_viewed` carries a `lens` dimension), so the expert's back link is exactly as
   * live as the client's. This is navigation, not a capability — it grants nothing that surface
   * does not gate for itself.
   */
  caseHref: string | null;
  /**
   * `meetingAllowsPostCallActions(meeting, now)` — has this meeting reached its start without
   * being cancelled?
   *
   * ⚠⚠ ON **BOTH** ARMS, DELIBERATELY, AND IT IS NOT A SECOND `rating === null`. The loader
   * already nulls the two consequential controls when this is `false`, but `rating` and
   * `resolve` are ALSO null for a non-rateable or non-case context, so the card cannot recover
   * "did this session happen?" from their absence — and the expert arm has neither field to
   * inspect in the first place. Without this the shell asserted "Consultation complete" over a
   * success tick and promised a receipt for a FUTURE or CANCELLED meeting. One predicate, one
   * boolean, both lenses.
   *
   * ⚠ IT GATES COPY ONLY. The route still renders when it is `false` (owner decision), and
   * every enforcement of the underlying rule stays server-side in `resolveCaseAction`.
   */
  meetingHeld: boolean;
}

export type EndOfCallView =
  | (EndOfCallBase & {
      lens: 'client';
      rating: EndOfCallRatingView | null;
      resolve: EndOfCallResolveView | null;
    })
  | (EndOfCallBase & { lens: 'expert' });

/** The CLIENT-lens arm — the only one that carries `rating` and `resolve`. */
export type ClientEndOfCallView = Extract<EndOfCallView, { lens: 'client' }>;

/** The EXPERT-lens arm. It has no rating and no resolve field to reference. */
export type ExpertEndOfCallView = Extract<EndOfCallView, { lens: 'expert' }>;

export type { EndOfCallRecapState, RecapContextType, RecapLens };
