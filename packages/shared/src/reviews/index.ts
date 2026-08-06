/**
 * reviews — the PURE, dependency-free review & rating primitives (BAL-390).
 *
 * NO `@balo/db` import, NO `node:crypto`, NO React, NO I/O. It lives here rather than
 * next to the repository for the reason `@balo/shared/engagements` states verbatim:
 * BAL-389's END-OF-CALL CLIENT COMPONENT must import `resolveEndOfCallReviewState`
 * without value-importing `@balo/db`, whose barrel re-exports `postgres` and breaks
 * `next build` on an unresolvable `tls` (memory `reference_balo_db_client_bundle_footgun`).
 *
 * ⚠ D2 — THESE ARE TYPED CONSTS, NOT CONFIG. There is NO `platform_config` table and
 * NO config module on main: `git grep platform_config|platformConfig|MANAGE_PLATFORM_CONFIG`
 * returns zero hits repo-wide (verified, not assumed). The design spec's line
 * "`LOW_THRESHOLD` is config … follow the BAL-398 platform-config precedent" is WRONG
 * and is deliberately not followed. House precedents for the typed-const treatment:
 * `AUTO_ACCEPT_DAYS` (repositories/project-engagements.ts), `CASE_INACTIVITY_DAYS`
 * (`@balo/shared/engagements`), `DORMANCY_REMINDER_WINDOWS_DAYS` (`@balo/shared/pricing`).
 */

/** The inclusive rating floor. A rating outside [RATING_MIN, RATING_MAX] is a bug. */
export const RATING_MIN = 1;

/** The inclusive rating ceiling. Mirrored by the DB CHECK `review_rating_range`. */
export const RATING_MAX = 5;

/**
 * Ratings strictly BELOW this get the warm re-ask card at end-of-call (D3), rather
 * than the plain thank-you. 4 means 1–3 are "let's hear more", 4–5 are "great".
 */
export const LOW_RATING_THRESHOLD = 4;

/** Body length cap, enforced by the caller's Zod at the write boundary — never here. */
export const REVIEW_BODY_MAX = 2000;

/** D8 — a review invite token stays usable for 30 days, and is reusable until expiry. */
export const REVIEW_TOKEN_TTL_DAYS = 30;

/** The rating value space. */
export type Rating = 1 | 2 | 3 | 4 | 5;

/**
 * WHERE the review was captured. Mirrors the `review_surface` pgEnum without importing
 * `@balo/db`.
 *   `end_of_call` — the in-app post-call control (BAL-389 mounts it).
 *   `recap`       — BAL-388's recap surface (declared; no producer ships).
 *   `email`       — the magic-link landing form.
 */
export type ReviewSurface = 'end_of_call' | 'recap' | 'email';

/**
 * HOW the writer authenticated. Mirrors the `review_auth_method` pgEnum.
 *   `session`    — an authenticated iron-session request.
 *   `magic_link` — a `review_invite_tokens` bearer.
 *
 * ORTHOGONAL to `ReviewSurface`, and deliberately NOT named `source`: a column called
 * `source` sitting beside a column called `surface` reads as two columns answering the
 * same question. This is the axis a security reviewer reads ("show me every review
 * written via a magic link"), and it is not derivable from the surface in the general
 * case — a future emailed recap link would be `surface: 'recap'`, `authMethod: 'magic_link'`.
 */
export type ReviewAuthMethod = 'session' | 'magic_link';

/**
 * ⚠ DRAFT COPY — pending MJ sign-off. The word under each star at end-of-call.
 * Gender-neutral and outcome-framed: it rates the HELP, never the person.
 */
export const RATING_LABELS: Readonly<Record<Rating, string>> = {
  1: "Didn't help",
  2: 'Some way off',
  3: 'Did the job',
  4: 'Really helpful',
  5: 'Outstanding',
} as const;

/**
 * Parse the `?r=` prefill on the magic-link landing.
 *
 * TOTAL, and deliberately strict: anything that is not EXACTLY one of the five decimal
 * literals — `'0'`, `'6'`, `'3.5'`, `'1e0'`, `' 1'`, `''`, `undefined`, `'<script>'` —
 * yields `null`, which the page renders as a genuine "pick a rating" empty state and
 * NEVER as an error. Written as a `switch` rather than a record lookup on purpose: an
 * object-literal lookup would resolve inherited keys (`parsePrefillRating('constructor')`
 * would return the `Object` constructor typed as a `Rating`).
 */
export function parsePrefillRating(raw: string | undefined): Rating | null {
  switch (raw) {
    case '1':
      return 1;
    case '2':
      return 2;
    case '3':
      return 3;
    case '4':
      return 4;
    case '5':
      return 5;
    default:
      return null;
  }
}

/**
 * TYPE PREDICATE. `true` when `value` is one of the five legal ratings.
 *
 * Exists so a write path can narrow a Zod-validated `number` to the `Rating` literal
 * union WITHOUT a type assertion (CLAUDE.md forbids the `!`/`as` shortcuts that make a
 * range promise the compiler cannot check). Anchored to `RATING_MIN`/`RATING_MAX`, so
 * widening the scale is a one-line change here rather than five literals in three files.
 */
export function isRating(value: number): value is Rating {
  return Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;
}

/**
 * D3 — the three end-of-call states.
 *   `none`      — no review yet: show the capture control.
 *   `rated_ok`  — rated at or above the threshold: show the thank-you.
 *   `rated_low` — rated below it: show the warm "tell us more" re-ask.
 */
export type EndOfCallReviewState =
  | { kind: 'none' }
  | { kind: 'rated_ok'; rating: number }
  | { kind: 'rated_low'; rating: number };

/**
 * D3 — THE end-of-call resolver, as a PURE function: no DB, no React, no I/O, no clock.
 *
 * BAL-390 ships this resolver plus the submit action and the reader; it mounts NO
 * component. BAL-389 mounts the surface and must call this rather than re-deriving the
 * boundary, so the "below 4 is a re-ask" rule exists in exactly one place.
 *
 * The boundary is INCLUSIVE at the top: a rating of exactly `threshold` is `rated_ok`.
 */
export function resolveEndOfCallReviewState(
  existingRating: number | null,
  threshold: number = LOW_RATING_THRESHOLD
): EndOfCallReviewState {
  if (existingRating === null) {
    return { kind: 'none' };
  }
  return existingRating < threshold
    ? { kind: 'rated_low', rating: existingRating }
    : { kind: 'rated_ok', rating: existingRating };
}

// ── The nudge band math (D1) ──────────────────────────────────────────────────

/**
 * ⚠⚠ THE LOAD-BEARING INVARIANT: BAND WIDTH == CRON PERIOD. Both are ONE HOUR.
 *
 * `apps/api/src/jobs/onboarding-reminder-sweep.ts` states this verbatim and sets its
 * window to one hour on an hourly cron. A band WIDER than the cron period re-matches
 * the same row on consecutive ticks and leans on BullMQ jobId dedup that CANNOT hold
 * (`apps/api/src/lib/queue.ts` sets `removeOnComplete: { count: 100 }` on ONE
 * `notification-events` queue shared by every event type, so completed jobs are
 * evicted after 100 across all of them). A band NARROWER than the period leaves
 * permanent gaps.
 *
 * THE CRON CADENCE IS NOT A FREE KNOB — it is COUPLED to this constant, and
 * `review-nudge-sweep.test.ts` asserts the two agree. The ticket says "~24h", so the
 * cron is HOURLY; a DAILY cron would make "+24h" mean anywhere in 24–48h and is WRONG.
 */
export const REVIEW_NUDGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The two nudge steps: the age of the terminal ANCHOR at which each fires.
 *
 * ⚠ THERE IS NO STEP 3, AND THERE CANNOT BE ONE. Nothing older than
 * `7d + REVIEW_NUDGE_WINDOW_MS` ever matches a band, so the hard stop is WINDOW MATH —
 * no schema state, no sent-marker column, no `created_at` floor, no cancellation code.
 * `index.test.ts`'s 30-day hourly iteration is the proof, and it is the ONLY proof:
 * `notification_log` cannot supply one (its `correlation_id` is `uuid` NOT NULL and
 * every sweep here writes a composite string, so the insert is rejected `22P02` and
 * swallowed by the log channel's own try/catch).
 *
 * ⚠ NAME COLLISION AVOIDED: `apps/api/src/jobs/auto-accept-sweep.ts` already exports
 * `REVIEW_REMINDER_LEAD_DAYS = 2`, meaning the T-2 AUTO-ACCEPT lead — a completely
 * different thing. Do NOT reuse that name here.
 */
export const REVIEW_NUDGE_STEPS = [
  { step: 1 as const, ageMs: 24 * 60 * 60 * 1000 },
  { step: 2 as const, ageMs: 7 * 24 * 60 * 60 * 1000 },
] as const;

/** The step discriminator carried on the nudge payload. */
export type ReviewNudgeStep = (typeof REVIEW_NUDGE_STEPS)[number]['step'];

/** One half-open candidate band: `after < anchor <= until`. */
export interface ReviewNudgeBand {
  readonly step: ReviewNudgeStep;
  /** EXCLUSIVE lower edge — an anchor exactly here is NOT matched. */
  readonly after: Date;
  /** INCLUSIVE upper edge — an anchor exactly here IS matched. */
  readonly until: Date;
}

/**
 * PURE. Floor a wall-clock instant DOWN to the start of its window (the hour, by default).
 *
 * ⚠ THE SWEEP MUST NOT PASS A RAW CLOCK TO {@link reviewNudgeBands}. Half-open band edges
 * only partition the timeline when consecutive ticks are EXACTLY one window apart, and a
 * cron tick is not: BullMQ fires late under load, so a 13:04 tick followed by an on-time
 * 14:00 tick produces the OVERLAPPING step-1 bands `(…12:04, …13:04]` and
 * `(…13:00, …14:00]`. An anchor in `(…13:00, …13:04]` then matches BOTH ticks — two token
 * mints and two `review_nudge_sent` events for one engagement. (Only the EMAIL survives
 * that, and only incidentally: the sweep's `correlationId` carries no tick, so the second
 * publish dedups against the first — a funnel over-count, not a duplicate inbox.)
 *
 * Quantised, both ticks resolve to the same hourly grid, consecutive ticks abut exactly,
 * and a tick that merely runs LATE within its own hour still sweeps its own band.
 */
export function quantiseNudgeTick(now: Date, windowMs = REVIEW_NUDGE_WINDOW_MS): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * PURE. The half-open `(after, until]` band per step for a given tick.
 *
 * `now` is a PARAMETER — this function never reads the clock, which is what makes the
 * "no third nudge is ever sent" proof a deterministic unit test rather than an
 * observation.
 *
 * ⚠ HALF-OPEN EDGES ARE NOT SUFFICIENT ON THEIR OWN, and this comment used to claim they
 * were. They partition the timeline with no OVERLAP only when consecutive ticks are
 * exactly one window apart — which is why `runReviewNudgeSweep` floors its wall clock
 * through {@link quantiseNudgeTick} before calling this. Read that function for the
 * duplicate a raw clock produces.
 *
 * ⚠ AND THEY CLOSE NO GAP AT ALL. A tick that never runs — the worker is down, or a cron
 * so backlogged it lands in the FOLLOWING hour — leaves its band permanently unswept: no
 * later tick re-covers it, and nothing detects it, because there is no per-engagement
 * sent-marker to compare against (D1). Anchors in that hour are never nudged. That is the
 * accepted residual of the no-schema-state design, not something the band math fixes.
 */
export function reviewNudgeBands(now: Date, windowMs = REVIEW_NUDGE_WINDOW_MS): ReviewNudgeBand[] {
  return REVIEW_NUDGE_STEPS.map(({ step, ageMs }) => ({
    step,
    until: new Date(now.getTime() - ageMs),
    after: new Date(now.getTime() - ageMs - windowMs),
  }));
}

// ── Client-bound projections ──────────────────────────────────────────────────

/**
 * THE ENTIRE data surface of the UNAUTHENTICATED `/review/{token}` landing page.
 *
 * Declaring the shape here means the page physically cannot widen it. Money
 * (`baloFeeBps` — 2500 on a project, and `engagementsRepository.findById` returns it),
 * sanitised-HTML descriptions, milestone titles, transcripts, other members' names and
 * emails, and the expert's `email` / `workosId` / `stripeConnectId` are ALL excluded by
 * construction. `reviewsRepository.findLandingContext` builds it with an EXPLICIT
 * `db.select({ … })` projection — never a relational `with:`, which hydrates full rows
 * (memory `reference_drizzle_with_hydration_leaks_secrets`).
 *
 * ⚠ IT CARRIES NO IDS — not `engagementId`, not `expertProfileId`. Both were here and
 * neither was ever read: the form's ONLY identity field is the token, and the write
 * action re-derives every id from it server-side. An id in this DTO is therefore a value
 * shipped into an unauthenticated browser's RSC payload as pure ballast. Every field
 * below is rendered by `review-form.tsx`; if a new one would not be, it does not belong
 * here.
 */
export interface ReviewLandingContext {
  engagementKind: 'project' | 'case';
  clientCompanyName: string;
  /** Pre-derived via `expertPartyDisplayName` (BAL-329) — agency name, or the person. */
  expertPartyLabel: string;
  /** The delivering person's given name, for warm second-person copy ("Amara"). */
  expertGivenName: string;
  /** For the forwarded-token disclosure — FIRST NAME ONLY, never the email address. */
  reviewerFirstName: string;
  title: string;
  /** `accepted_at` (project) | `closed_at` (case). NULL when not yet concluded. */
  concludedOnIso: string | null;
}

/**
 * D6 — the PUBLIC projection of a review. Attributed to the client COMPANY, never the
 * person: `reviews.reviewer_user_id` keeps the individual for attribution and audit,
 * but a published review is a PARTY statement. `reviewsRepository.listPublicByExpert`
 * builds this with an explicit allow-list and an invariant test asserts the reviewer id
 * can never appear in it.
 */
export interface PublicReview {
  id: string;
  rating: number;
  body: string | null;
  clientCompanyName: string;
  createdAtIso: string;
}
