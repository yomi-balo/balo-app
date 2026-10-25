/**
 * project-requests/proposal-draft (BAL-611) — the shared contract for the AI-drafted proposal
 * overview and milestones: its caps, its deadline and polling cadence, the milestone markup it
 * may use, its closed failure vocabulary, and the one persisted shape that crosses a package
 * boundary (`ProposalDraftOutput`).
 *
 * ── WHY IT LIVES IN `@balo/shared` ────────────────────────────────────────────────────
 * `apps/web` (the start/poll actions and the composer's polling hook), `apps/api` (the worker
 * and its output schema) and `@balo/db` (the `proposal_draft_generations.output` column) all
 * need it, and `@balo/shared` must not import `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`). `schema/proposal-draft-generations.ts` imports
 * it type-only, the `brief-parse.ts` posture exactly.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER
 * (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 *
 * PURE. Constants and types only — no I/O, no clock, no `server-only`, no zod.
 */

// ── Rate and timing ────────────────────────────────────────────────────────────────────

/**
 * Generations one user may START per rolling hour. Each relationship drafts at most once
 * (`proposal_draft_generations_relationship_live_idx`), so this bounds only an expert opening
 * many new composers in a burst. Enforced web-side as a DB count
 * (`proposalDraftGenerationsRepository.countCreatedSince`) and api-side as a Redis limit.
 */
export const MAX_PROPOSAL_DRAFTS_PER_HOUR = 20;

/**
 * The server's deadline for a generation, and the single source of truth for whether one has
 * failed. A `pending` row older than this reads as failed (derived at read, never stored, so
 * no reaper job exists), and `proposalDraftGenerationsRepository.markSucceeded` refuses to
 * store a success past it. The read measures the row's age on the web server's clock and the
 * write on the database's, so once a poll has shown the failure no later read can show a
 * draft, up to the skew between those two clocks (NTP-small): a web clock running ahead by δ
 * lets a success stored in the deadline's last δ appear on a later visit.
 *
 * The composer polls until a read is terminal (`succeeded`, `failed` or `skipped`) rather than
 * running its own countdown: a client budget of polls stretches with every round-trip, so it
 * cannot be lined up against this deadline.
 */
export const DRAFT_DEADLINE_MS = 90_000;

/** How often the composer polls a `pending` generation. */
export const PROPOSAL_DRAFT_POLL_INTERVAL_MS = 2_000;

/**
 * A safety cap on the composer's polls, reached only when reads keep coming back `pending`
 * past the deadline (a derivation bug, or clock trouble); a poll that errors shows the failure
 * at once, and a terminal read stops polling. It covers {@link DRAFT_DEADLINE_MS} plus 30s of
 * slack even if every round-trip were instant (60 × 2s = 120s), so the cap can never cut off a
 * generation the server would still accept. Hitting it shows the same quiet failure line.
 */
export const PROPOSAL_DRAFT_MAX_POLLS = Math.ceil(
  (DRAFT_DEADLINE_MS + 30_000) / PROPOSAL_DRAFT_POLL_INTERVAL_MS
);

// ── Bounds on the model's structured output ────────────────────────────────────────────

/** A drafted proposal has between two and five milestones, inclusive. */
export const PROPOSAL_DRAFT_MIN_MILESTONES = 2;
export const PROPOSAL_DRAFT_MAX_MILESTONES = 5;

// Each bound below sits at or under the composer's own save bound in
// `apps/web/.../_actions/proposal-schema.ts`, so applying a draft can never produce a composer
// state that its own autosave then refuses.

/** Overview HTML (the save bound is 50,000). */
export const PROPOSAL_DRAFT_MAX_OVERVIEW_HTML = 20_000;
/** Milestone title, plain text. Equal to the save bound (200). */
export const PROPOSAL_DRAFT_MAX_TITLE = 200;
/** Milestone description HTML (the save bound is 20,000). */
export const PROPOSAL_DRAFT_MAX_DESCRIPTION_HTML = 4_000;
/** Milestone "Done when" acceptance criteria, plain text (the save bound is 2,000). */
export const PROPOSAL_DRAFT_MAX_ACCEPTANCE_CRITERIA = 500;

// ── Milestone description markup ───────────────────────────────────────────────────────

/**
 * The only tags a drafted milestone description may carry. Milestone descriptions are edited
 * in the composer's `light` rich-text editor, which renders paragraphs, hard breaks, bold,
 * italic and bullet lists (its links are never drafted). A heading or numbered list it cannot
 * show would still be saved and reach the client unseen by the expert, so the api prompt asks
 * for exactly this list and the web narrows every drafted description to it before applying.
 */
export const PROPOSAL_DRAFT_MILESTONE_TAGS = ['p', 'br', 'strong', 'em', 'ul', 'li'] as const;

/** @see PROPOSAL_DRAFT_MILESTONE_TAGS */
export type ProposalDraftMilestoneTag = (typeof PROPOSAL_DRAFT_MILESTONE_TAGS)[number];

// ── Failure vocabulary ─────────────────────────────────────────────────────────────────

/**
 * The CLOSED set of stored failure reasons — the only values `proposal_draft_generations
 * .failure_reason` may hold. ⚠ NEVER a model or vendor message.
 *
 *   enqueue_failed     the web could not hand the row to the api queue
 *   model_unavailable  the configured model is not on the allow-list, or the provider refused
 *   invalid_output     the model's answer failed the output schema on every attempt
 *   truncated          the model hit its output-token ceiling
 *   empty_output       the answer parsed but carried no usable overview or milestone titles
 *   source_unavailable the relationship or its request was gone when the worker ran
 *   deadline_exceeded  the worker picked the job up, or finished it, past {@link DRAFT_DEADLINE_MS}
 *   unknown            anything else
 *
 * A `pending` row past {@link DRAFT_DEADLINE_MS} is also derived as failed when it is read, so
 * the web never waits on a worker that died; `deadline_exceeded` is what a live worker stores
 * when it abandons a job that ran past the same deadline.
 */
export const PROPOSAL_DRAFT_FAILURE_REASONS = [
  'enqueue_failed',
  'model_unavailable',
  'invalid_output',
  'truncated',
  'empty_output',
  'source_unavailable',
  'deadline_exceeded',
  'unknown',
] as const;

/** @see PROPOSAL_DRAFT_FAILURE_REASONS */
export type ProposalDraftFailureReason = (typeof PROPOSAL_DRAFT_FAILURE_REASONS)[number];

// ── Persisted output ───────────────────────────────────────────────────────────────────

/**
 * One drafted milestone. `descriptionHtml` is raw model HTML until the web poll sanitises it
 * with `sanitizeProjectHtml`; `title` and `acceptanceCriteria` are plain text, the same shape
 * the composer's milestone holds.
 */
export interface ProposalDraftMilestoneOutput {
  title: string;
  descriptionHtml: string;
  acceptanceCriteria: string;
}

/**
 * The worker's validated model answer, stored verbatim in `proposal_draft_generations.output`.
 * `overviewHtml` is raw model HTML until the web poll sanitises it with
 * `sanitizeProposalOverviewHtml`; raw output never reaches a browser.
 *
 * ⚠ HOLDS NO DATES, AND MUST NOT ACQUIRE ONE (memory `reference_jsonb_date_type_lie`: a `Date`
 * written into jsonb reads back as an ISO string while still typed `Date`).
 */
export interface ProposalDraftOutput {
  overviewHtml: string;
  milestones: ProposalDraftMilestoneOutput[];
}
