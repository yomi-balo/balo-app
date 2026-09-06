/**
 * project-requests — BAL-540's ONE definition of the two request-lifecycle string unions that
 * every layer of this feature needs, and the ONE narrowing for each.
 *
 * WHY HERE AND NOT `@balo/db` (which owns the pgEnums). `@balo/shared` must not import
 * `@balo/db`: a client component that value-imports `@balo/db` drags the `postgres` driver into
 * the browser bundle and fails `next build` (it cannot resolve Node builtins like `tls`). Both
 * unions are needed by CLIENT islands (`close-copy.ts`, `thread-actions.ts`, the close sheet and
 * the decline dialog), by `packages/shared`'s own notification payloads and by
 * `packages/analytics`' event map — none of which may depend on `@balo/db`. So this module
 * RESTATES the vocabulary, exactly as `meetings/recording-view.ts` restates
 * `MeetingRecordingStatus`, and `packages/db/src/schema/project-requests.ts` +
 * `repositories/request-expert-relationships.ts` carry `Exact<>` compile-time pins that turn a
 * drift between the two into a TYPE ERROR rather than a runtime surprise.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER
 * (memory `reference_balo_shared_no_js_extensions_in_reexports`).
 *
 * PURE. No I/O, no clock, no `server-only`.
 */

/**
 * The relationship statuses a track can actually be declined FROM — i.e. exactly the sources
 * whose `RELATIONSHIP_STATUS_TRANSITIONS` entry carries a `'declined'` edge. NOT `accepted`
 * (refused by the repository's own transition guard) and NOT `declined` (already terminal).
 *
 * ⚠ AN ALLOW-LIST, NOT A COMPLEMENT — a seventh `request_expert_relationship_status` label is
 * therefore NOT declinable until somebody adds it here consciously. Pinned to the transitions
 * map by `packages/db/src/invariants/declinable-statuses-match-the-transitions.test.ts`, which
 * goes red if a new label gains a `'declined'` edge without joining this tuple.
 */
export const DECLINABLE_RELATIONSHIP_STATUSES = [
  'invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
] as const;

/**
 * The stage a track was declined FROM. Named for the DOMAIN fact (a relationship status), not
 * for any one surface — the close sheet, the decline dialog, both Server Actions, both
 * notification payloads and the analytics event all take this exact type.
 */
export type DeclinableRelationshipStatus = (typeof DECLINABLE_RELATIONSHIP_STATUSES)[number];

/**
 * THE narrowing. `null` for `accepted` / `declined` / anything unrecognised — a value-returning
 * narrow, never a throw, because most call sites are display-only and render whatever row the
 * UI happens to hold. The one boundary that genuinely cannot proceed on `null`
 * (`_actions/_shared/decline-track-stage.ts`) wraps this and decides for itself.
 *
 * Cast-free by construction: `Array.prototype.find` over the literal tuple returns the union.
 */
export function narrowToDeclinableRelationshipStatus(
  status: string
): DeclinableRelationshipStatus | null {
  return DECLINABLE_RELATIONSHIP_STATUSES.find((candidate) => candidate === status) ?? null;
}

/**
 * Why a request was CLOSED (`project_request_close_reason`). `withdrawn` is the CLIENT arm's
 * only reason — closing your own request IS a withdrawal, so it is stated rather than chosen;
 * the Balo arm picks one of the other three.
 */
export const PROJECT_REQUEST_CLOSE_REASONS = [
  'withdrawn',
  'declined',
  'unfilled',
  'superseded',
] as const;

/** @see PROJECT_REQUEST_CLOSE_REASONS */
export type ProjectRequestCloseReason = (typeof PROJECT_REQUEST_CLOSE_REASONS)[number];

/**
 * The three reasons only BALO may pick — the full set minus the client's own `withdrawn`. One
 * definition behind the admin close sheet's picker, the admin action's Zod enum and its result
 * type. `satisfies` makes an invented reason a compile error here rather than a runtime 400.
 */
export const BALO_CLOSE_REASONS = [
  'declined',
  'unfilled',
  'superseded',
] as const satisfies readonly ProjectRequestCloseReason[];

/** @see BALO_CLOSE_REASONS */
export type BaloCloseReason = (typeof BALO_CLOSE_REASONS)[number];

/**
 * THE close-reason narrowing, for the two places a reason arrives as `unknown` (the merged
 * notification payload the api templates read). `null` for anything unrecognised — the caller
 * decides what to degrade to, rather than this module guessing on its behalf.
 */
export function narrowToProjectRequestCloseReason(
  value: unknown
): ProjectRequestCloseReason | null {
  if (typeof value !== 'string') return null;
  return PROJECT_REQUEST_CLOSE_REASONS.find((candidate) => candidate === value) ?? null;
}
