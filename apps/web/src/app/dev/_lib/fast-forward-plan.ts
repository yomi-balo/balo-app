/**
 * BAL-275 §8.4 — the PURE fast-forward planner: given a request's current status, the SELECTED
 * TRACK's status (when one is selected) and a target, decide which ordered real-handler steps get
 * there, or refuse with a typed reason.
 *
 * ⚠ TWO GRAINS, AND THE SPLIT IS THE WHOLE POINT (fix round, F1). `projectRequests.status` is a
 * MAX-PROGRESS ROLLUP over every live track (`derive-request-status.ts` rule 2), so on a
 * multi-track request it reports the FURTHEST track, never the one the operator picked. Every
 * post-invite step the orchestrator runs acts on ONE track, so planning those from the rollup
 * makes a lagging track unreachable (target refused as `already_at_or_past`), silently DROPS a
 * step that track genuinely still needs (e.g. its `eoi`), and can propose an illegal relationship
 * edge. The spine arm therefore ranks the SELECTED TRACK whenever one is selected:
 *   • TRACK grain (`trackStatus` given) — the five spine targets, which all act on one track.
 *   • REQUEST grain (`trackStatus` omitted) — `closed` (a request-grain act), the pre-invite path
 *     (no relationship row exists yet to rank from), and the invite window, which no relationship
 *     status can express (`requested` / `exploratory_meeting_requested` have no track counterpart).
 *
 * PURE, deliberately: no `server-only`, no I/O, no value import from `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun` — a client component that value-imports `@balo/db`
 * breaks `next build`). The panel (`request-fast-forward-panel.tsx`, a client component) imports
 * this module too, to compute `reachableTargets` for its target `<Select>` — that is the whole
 * reason the status vocabulary is RESTATED here as a local `as const` map rather than imported
 * from `@balo/db`'s `STATUS_TRANSITIONS`, and why the entry point takes `currentStatus: string`
 * instead of the DB-backed `ProjectRequestStatus` type.
 *
 * This module NEVER writes anything and NEVER calls a real handler — it only decides the ORDER
 * and NAMES of the steps the orchestrator (`_actions/fast-forward.ts`) will run. Every step it
 * proposes still runs through the real capability gate and the real `isAllowedTransition` /
 * `isAllowedRelationshipTransition` map inside its handler (§12) — this planner is a courtesy
 * that fails kindly and EARLY, not a second source of truth for what is legal.
 */

/** The seven fast-forward targets (D4). `draft` and `kickoff_approved` are not targets. */
export const FAST_FORWARD_TARGETS = [
  'experts_invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'closed',
  'declined_track',
] as const;
export type FastForwardTarget = (typeof FAST_FORWARD_TARGETS)[number];

/** The real orchestration step a target may require, in the order they must run. */
export type FastForwardStep =
  | 'invite'
  | 'eoi'
  | 'request_proposal'
  | 'submit_proposal'
  | 'accept'
  | 'close'
  | 'decline_track';

export type PlanRefusal =
  /** The request is `closed` — terminal, nothing may be fast-forwarded from here. */
  | 'request_closed'
  /** The request is already at or beyond the target status/relationship stage. */
  | 'already_at_or_past'
  /** `draft` has no production producer on the spine (D4 / pre-flight O5). */
  | 'off_spine'
  /** `accepted` / `kickoff_approved` have no `closed` edge (mirrors `STATUS_TRANSITIONS`). */
  | 'close_refused_at_stage'
  /**
   * The SELECTED TRACK is `declined` — terminal for that relationship. Distinct from `off_spine`
   * deliberately: `declined` is a real, legal relationship state with no rank anywhere
   * (`derive-request-status.ts` omits it from `RELATIONSHIP_TO_REQUEST_STATUS` on purpose), so
   * borrowing `off_spine`'s draft-request wording for it would tell the operator something false.
   */
  | 'track_declined';

export type PlanResult =
  | { ok: true; steps: readonly FastForwardStep[] }
  | { ok: false; refusal: PlanRefusal };

/**
 * The origination spine's rank, restated (D4): `requested`(0) · `exploratory_meeting_requested`(0)
 * · `experts_invited`(1) · `eoi_submitted`(2) · `proposal_requested`(3) · `proposal_submitted`(4)
 * · `accepted`(5) · `kickoff_approved`(6, not a target — ranked so an already-progressed request
 * correctly reads as `already_at_or_past` for every spine target).
 *
 * `exploratory_meeting_requested` ranks EQUAL to `requested` — `inviteExpertsAction`'s
 * `INVITE_WINDOW_STATUSES` (`invite-experts.ts:41-46`) accepts both as an invite source, so
 * neither is "ahead of" the other on this spine.
 *
 * `draft` and `closed` are DELIBERATELY absent — both are handled as explicit branches below,
 * never as a rank comparison (see the docblock on `planFastForward`).
 */
const SPINE_RANK: Readonly<Record<string, number>> = {
  requested: 0,
  exploratory_meeting_requested: 0,
  experts_invited: 1,
  eoi_submitted: 2,
  proposal_requested: 3,
  proposal_submitted: 4,
  accepted: 5,
  kickoff_approved: 6,
};

/**
 * The per-track ladder, restated (same doctrine as `SPINE_RANK` above — this module may not
 * value-import `@balo/db`). Ranks are DELIBERATELY aligned to `SPINE_RANK`'s request labels
 * through `RELATIONSHIP_TO_REQUEST_STATUS`
 * (`packages/db/src/repositories/_shared/derive-request-status.ts`), so one `SPINE_STEPS_IN_ORDER`
 * traversal serves both grains: `invited → experts_invited`(1) · `eoi_submitted`(2) ·
 * `proposal_requested`(3) · `proposal_submitted`(4) · `accepted`(5).
 *
 * ⚠ `invited` is NOT a `SPINE_RANK` key, and that is not an oversight — the left side is a
 * per-expert state, the right side a request aggregate, and the map between them is a scope
 * TRANSLATION, not an identity (that file's own naming-trap warning). `declined` is absent
 * deliberately: it has no rank on either ladder and is refused as `track_declined` before any
 * rank is read.
 */
const TRACK_RANK: Readonly<Record<string, number>> = {
  invited: 1,
  eoi_submitted: 2,
  proposal_requested: 3,
  proposal_submitted: 4,
  accepted: 5,
};

/**
 * The statuses from which `inviteExpertsAction` permits an invite — first or ANOTHER — restated
 * from `INVITE_WINDOW_STATUSES` (`invite-experts.ts:41-46`, enforced at its `:122`). It is a
 * server module, so it cannot be imported here; mirror it EXACTLY, or the planner either proposes
 * an invite the real handler refuses, or refuses a second invite the real handler would allow
 * (which is what made a two-proposal comparison fixture unreachable before the F1 fix round).
 */
const INVITE_WINDOW_STATUSES = new Set<string>([
  'requested',
  'exploratory_meeting_requested',
  'experts_invited',
  'eoi_submitted',
]);

/** The five spine targets, each mapped to the rank it produces and the step that produces it. */
const SPINE_TARGET_STEPS: Readonly<
  Record<
    Exclude<FastForwardTarget, 'closed' | 'declined_track'>,
    { rank: number; step: FastForwardStep }
  >
> = {
  experts_invited: { rank: 1, step: 'invite' },
  eoi_submitted: { rank: 2, step: 'eoi' },
  proposal_requested: { rank: 3, step: 'request_proposal' },
  proposal_submitted: { rank: 4, step: 'submit_proposal' },
  accepted: { rank: 5, step: 'accept' },
};

/** Every spine step, in rank order — the traversal `planFastForward` filters down to a range. */
const SPINE_STEPS_IN_ORDER: readonly { rank: number; step: FastForwardStep }[] = [
  SPINE_TARGET_STEPS.experts_invited,
  SPINE_TARGET_STEPS.eoi_submitted,
  SPINE_TARGET_STEPS.proposal_requested,
  SPINE_TARGET_STEPS.proposal_submitted,
  SPINE_TARGET_STEPS.accepted,
];

/** Statuses `closeRequestAsAdminAction` may legally close FROM (mirrors `STATUS_TRANSITIONS`' deliberate omission at `project-requests.ts:57-59` — `accepted`/`kickoff_approved` have no `closed` edge). */
const CLOSE_REFUSED_STATUSES = new Set<string>(['accepted', 'kickoff_approved']);

function planCloseTarget(currentStatus: string): PlanResult {
  if (CLOSE_REFUSED_STATUSES.has(currentStatus)) {
    return { ok: false, refusal: 'close_refused_at_stage' };
  }
  return { ok: true, steps: ['close'] };
}

/**
 * `declined_track` has no rank on the spine — it is a terminal action applied to the CURRENT
 * track, not a spine destination (§7). The real action's own `InvalidRelationshipTransitionError`
 * is the authoritative guard on a non-declinable track (§12); this planner only proposes the step.
 */
function planDeclineTrackTarget(): PlanResult {
  return { ok: true, steps: ['decline_track'] };
}

function planSpineTarget(
  currentStatus: string,
  target: Exclude<FastForwardTarget, 'closed' | 'declined_track'>,
  trackStatus: string | undefined
): PlanResult {
  // `draft` has no production producer on the spine (D4 / pre-flight O5) — the sole
  // `createProjectRequest` call site hardcodes `status: 'requested'`, so there is no real
  // handler that would ever need to run from `draft`. REQUEST grain, always: a draft request
  // cannot legally carry a track at all, so a `trackStatus` alongside it is incoherent input.
  if (currentStatus === 'draft') {
    return { ok: false, refusal: 'off_spine' };
  }

  // A declined track is terminal — it has no rank on either ladder, and every step below acts
  // ON the selected track. Refused with its own reason, never by falling through to `off_spine`.
  if (trackStatus === 'declined') {
    return { ok: false, refusal: 'track_declined' };
  }

  // The invite window is REQUEST grain and has no track counterpart: `invite` creates a track, so
  // there is never a selected one to rank it from, and `requested` /
  // `exploratory_meeting_requested` are not relationship statuses at all. Planned by membership of
  // the restated window rather than by rank, so a SECOND expert can still be invited once the
  // rollup has moved past `experts_invited` — exactly what the real handler permits.
  if (
    trackStatus === undefined &&
    target === 'experts_invited' &&
    INVITE_WINDOW_STATUSES.has(currentStatus)
  ) {
    return { ok: true, steps: ['invite'] };
  }

  const currentRank =
    trackStatus === undefined ? SPINE_RANK[currentStatus] : TRACK_RANK[trackStatus];
  const { rank: targetRank } = SPINE_TARGET_STEPS[target];

  // An unrecognised current status (defensive — every real status is in SPINE_RANK, every real
  // relationship status bar `declined` in TRACK_RANK) is treated the same as `draft`: there is no
  // known spine position to plan a traversal from.
  if (currentRank === undefined) {
    return { ok: false, refusal: 'off_spine' };
  }
  if (currentRank >= targetRank) {
    return { ok: false, refusal: 'already_at_or_past' };
  }

  const steps = SPINE_STEPS_IN_ORDER.filter(
    (entry) => entry.rank > currentRank && entry.rank <= targetRank
  ).map((entry) => entry.step);
  return { ok: true, steps };
}

/**
 * Plan the ordered real-handler steps to drive the request (or the selected track) to `target`,
 * or refuse with a typed reason (§12 documents each refusal's user-facing behaviour).
 *
 * `trackStatus` is the SELECTED track's relationship status, when the operator has picked one.
 * Omit it for the pre-invite path and whenever no track is selected — the plan then falls back to
 * request grain, and the orchestrator's own "Pick a track before fast-forwarding to that status."
 * refusal is what stops a track-bearing plan from running track-less.
 *
 * Order of decision, exactly:
 *  1. `currentStatus === 'closed'` ⇒ `request_closed` for EVERY target — terminal, REQUEST grain
 *     (a track mid-spine on a closed request changes nothing; `closed` wins over every rollup).
 *  2. `target === 'closed'` ⇒ `close_refused_at_stage` from `accepted`/`kickoff_approved`,
 *     else `['close']`. REQUEST grain, deliberately: closing is a request-grain act, and
 *     `STATUS_TRANSITIONS` refuses it from `accepted` — a refusal this planner exists to mirror.
 *     `closed` is a terminal ACTION applied at the current state, never a spine destination — it
 *     never runs the spine first.
 *  3. `target === 'declined_track'` ⇒ `['decline_track']`, unconditionally (the real action's
 *     transition guard is the authority on a non-declinable track).
 *  4. Otherwise `target` is one of the five spine targets: `draft` (or an unrecognised current
 *     status) ⇒ `off_spine`; a `declined` selected track ⇒ `track_declined`; an in-window invite
 *     with no selected track ⇒ `['invite']`; already at/past ⇒ `already_at_or_past`; else the
 *     spine steps whose produced rank is `> rank(current)` and `<= rank(target)`, where
 *     `rank(current)` is the SELECTED TRACK's rank whenever one was given.
 */
export function planFastForward(
  currentStatus: string,
  target: FastForwardTarget,
  trackStatus?: string
): PlanResult {
  if (currentStatus === 'closed') {
    return { ok: false, refusal: 'request_closed' };
  }
  if (target === 'closed') {
    return planCloseTarget(currentStatus);
  }
  if (target === 'declined_track') {
    return planDeclineTrackTarget();
  }
  return planSpineTarget(currentStatus, target, trackStatus);
}

/**
 * Every target `planFastForward` currently accepts from `currentStatus` — drives the panel's
 * target `<Select>`.
 *
 * U6 — `hasTracks` (default `true`, so every existing single-arg call site is unaffected) excludes
 * `declined_track` when the request has zero tracks: `planDeclineTrackTarget` proposes the step
 * unconditionally (there is no track on the spine to check), so without this a request with no
 * tracks at all still offers `declined_track`, and picking it then shows the expert-invite picker
 * (there is no track to pick) before refusing generically.
 *
 * `trackStatus` (F1) is the SELECTED track's status, when one is selected — the target list must
 * be computed at the same grain as the plan the operator is about to run, or it offers targets
 * that then refuse (and hides targets a lagging track can genuinely still reach).
 */
export function reachableTargets(
  currentStatus: string,
  hasTracks = true,
  trackStatus?: string
): readonly FastForwardTarget[] {
  return FAST_FORWARD_TARGETS.filter((target) => {
    if (target === 'declined_track' && !hasTracks) {
      return false;
    }
    return planFastForward(currentStatus, target, trackStatus).ok;
  });
}

const REFUSAL_COPY: Readonly<Record<PlanRefusal, string>> = {
  request_closed: 'This request is closed. Nothing can be fast-forwarded from a closed request.',
  already_at_or_past:
    'This is already at or past that status — the track you picked when there is one, otherwise the request itself.',
  track_declined:
    'That track was declined, which is the end of the road for it. Pick another track, or invite a new expert to start a fresh one.',
  off_spine:
    'This request cannot reach that status from here — there is no real handler that produces it from a draft request.',
  close_refused_at_stage:
    'A request can no longer be closed once a proposal has been accepted — that mirrors the real transition map exactly.',
};

/** Gender-neutral, user-facing copy for a refusal — the panel renders this verbatim. */
export function refusalCopy(refusal: PlanRefusal): string {
  return REFUSAL_COPY[refusal];
}
