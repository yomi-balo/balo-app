/**
 * BAL-411 (§D1 / §D7) — the reschedule-proposal lifecycle's pure core: lazy expiry, liveness,
 * and the answer-time refusal vocabulary.
 *
 * ── EXPIRY IS LAZY — READ THIS BEFORE "FIXING" A STALE `status` ─────────────────────────────
 * `reschedule_proposals.expires_at` is stamped at propose time and NEVER revisited by a
 * background process. A lapsed proposal keeps `status = 'pending'` in the row while READING as
 * `expired` — the stored `status` is a monotone lower bound on truth, never the truth itself.
 * `deriveRescheduleProposalState` is the ONE place that derivation happens; the loader and the
 * nudge cannot disagree about "is this still open?" because both call it with the same `now`.
 * Enforcement does NOT depend on this derivation: every answer path (the repository's `accept` /
 * `decline` / `withdraw` CAS) carries `status = 'pending' AND expires_at > $now` in its own
 * WHERE, so a lapsed proposal is structurally unanswerable regardless of whether a caller
 * remembered to derive first.
 *
 * ── PURE, `now`-INJECTED, NO CLOCK OF ITS OWN ────────────────────────────────────────────────
 * The `reschedulable.ts` / `bounds.ts` precedent: every function here takes `now` as a
 * parameter and reads no `Date.now()` of its own.
 *
 * ── NO `@balo/db` IMPORT ─────────────────────────────────────────────────────────────────────
 * `RescheduleProposalStatusLabel` is a hand-restated mirror of `packages/db/src/schema/
 * enums.ts`'s `reschedule_proposal_status` pgEnum, exactly as `MeetingStatusLabel` mirrors
 * `meeting_status` in `../engagements/case-surface.ts` — `@balo/shared` cannot import a pgEnum
 * without inverting the dependency graph (`@balo/db` depends on `@balo/shared`, never the
 * reverse).
 *
 * ⚠⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER (memory
 * `reference_balo_shared_no_js_extensions_in_reexports`).
 */

/** The structural cap on alternative times in one proposal — mirrors the DB CHECK
 *  `reschedule_proposal_option_position_range` (0 ≤ position < 3) and the partial unique
 *  `(proposal_id, position)`. Restated here so `apps/web`'s propose dialog and `apps/api`'s
 *  Zod `options` bound (`.min(1).max(3)`) read the SAME number rather than two typed literals
 *  drifting apart. */
export const RESCHEDULE_PROPOSAL_MAX_OPTIONS = 3;

/** Hand-restated `reschedule_proposal_status` pgEnum labels — see the module docblock. */
export type RescheduleProposalStatusLabel =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'expired';

export interface RescheduleProposalStateInput {
  readonly status: RescheduleProposalStatusLabel;
  readonly expiresAt: Date;
  readonly now: Date;
}

/**
 * TOTAL over every `(status, expiresAt, now)` triple.
 *
 * A non-`'pending'` status is a TERMINAL fact — it is returned as-is regardless of `expiresAt`,
 * because a proposal that was already accepted/declined/withdrawn cannot ALSO be "expired": the
 * CAS in the repository refuses to let a resolved proposal's `expires_at` matter again.
 *
 * The return type is {@link RescheduleProposalStatusLabel} — the same vocabulary as the STORED
 * `status` column, reused rather than aliased: this function's whole job is to widen that
 * stored, monotone-lower-bound value into the DERIVED state the caller should treat as truth.
 * `'expired'` is producible here even when the stored row still says `'pending'` (§D1) — the
 * derived and stored values share a type only because they share a vocabulary, not because
 * they're interchangeable in meaning.
 */
export function deriveRescheduleProposalState(
  input: RescheduleProposalStateInput
): RescheduleProposalStatusLabel {
  const { status, expiresAt, now } = input;
  if (status !== 'pending') {
    return status;
  }
  return expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}

/**
 * `true` iff a proposal is still a LIVE ask the client can answer.
 *
 * ⚠ CALLERS MUST ALREADY HAVE FILTERED TO `status === 'pending'` — this does NOT re-check
 * status. It mirrors `rescheduleProposalsRepository.findLivePendingByMeetingIds`'s own
 * contract exactly: that read filters `status = 'pending'` at the query, so "live" in ITS name
 * means "not soft-deleted", never expiry — expiry is this function's whole job.
 *
 * `>`, not `>=` — mirrors the repository's own CAS predicate `answerableProposal` (`gt`, not
 * `gte`): at EXACTLY `expiresAt` the ask has lapsed, because the deadline IS the original
 * start and "accepting" at the instant the call was due to begin is not a real answer.
 */
export function rescheduleProposalIsLive(
  proposal: { readonly expiresAt: Date },
  now: Date
): boolean {
  return proposal.expiresAt.getTime() > now.getTime();
}

/**
 * Why an ANSWER (accept / decline / withdraw) may not proceed, derived from a proposal already
 * loaded WITHOUT a `status` filter (`findPendingForAnswer` — its docblock states in terms that
 * the absence of a filter there is what makes the `'not_pending'` arm here reachable at all).
 *
 * `null` ⇒ answerable. Order is part of the contract, and it is the order the answer routes
 * check in: `not_pending` → `expired` → `stale`.
 */
export type ProposalAnswerRefusal = 'not_pending' | 'expired' | 'stale' | null;

export interface ResolveProposalAnswerRefusalInput {
  readonly status: RescheduleProposalStatusLabel;
  readonly expiresAt: Date;
  /** `reschedule_proposals.original_scheduled_start` — the STALENESS ANCHOR, i.e. the
   *  meeting's `scheduled_start` as it was AT PROPOSE TIME. */
  readonly originalScheduledStart: Date;
  /** The meeting's LIVE `scheduled_start`, read fresh at answer time — never cached. */
  readonly meetingScheduledStart: Date;
  readonly now: Date;
}

/**
 * TOTAL over every input. `'stale'` is reachable ONLY once the proposal is confirmed pending
 * and unexpired — a proposal that is already resolved or lapsed is refused for THAT reason
 * first, never mis-reported as stale.
 */
export function resolveProposalAnswerRefusal(
  input: ResolveProposalAnswerRefusalInput
): ProposalAnswerRefusal {
  const { status, expiresAt, originalScheduledStart, meetingScheduledStart, now } = input;
  if (status !== 'pending') {
    return 'not_pending';
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (originalScheduledStart.getTime() !== meetingScheduledStart.getTime()) {
    return 'stale';
  }
  return null;
}
