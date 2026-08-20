/**
 * BAL-414 — the ONE definition of "what makes an expert complete" (D1, D3, D4).
 *
 * `expert_profiles.searchable` gates BOTH discovery AND the public profile detail page. Before
 * this ticket the six-item rule was written once, inline, in `apps/web`'s dashboard read path,
 * and `searchable` was only ever set to `true`. This module is the pure derivation both
 * `apps/api` (the credential-break/repair triggers) and `apps/web` (the dashboard read path)
 * call — a second definition of "complete" is exactly the failure mode this codebase keeps
 * ADRs about (D3).
 *
 * ⚠⚠ PURE. No I/O, no imports beyond types. Every input is already fetched by the caller
 * (`expertSearchabilityRepository.loadInputs` in `@balo/db`).
 */

/**
 * The six checklist item keys, in display order. THE SINGLE DEFINITION — the derivation, the
 * notification payload's Zod arm, and the analytics `failing_items` property all read this
 * tuple rather than restating the six literals.
 */
export const EXPERT_CHECKLIST_ITEM_KEYS = [
  'profile',
  'phone',
  'rate',
  'calendar',
  'availability',
  'payouts',
] as const;

export type ExpertChecklistItemKey = (typeof EXPERT_CHECKLIST_ITEM_KEYS)[number];

/**
 * One live (non-soft-deleted) calendar connection, reduced to what the rule needs.
 *
 * ⚠ `credentialStatus` is typed `string`, NOT the DB's `CalendarCredentialStatus` union.
 * `@balo/shared` cannot import `@balo/db` (the dependency direction is `@balo/db → @balo/shared`,
 * never the reverse). The vocabulary keeps its single home in `packages/db/src/schema/calendar.ts`;
 * what lives here is the RULE. The two are pinned together by a cross-package test —
 * `packages/db/src/repositories/expert-searchability.integration.test.ts` (T1.5).
 */
export interface ExpertCalendarConnectionState {
  readonly id: string;
  readonly credentialStatus: string;
}

/** Every input the six checklist items are derived from. Already fetched by the caller. */
export interface ExpertChecklistInputs {
  readonly headline: string | null;
  readonly bio: string | null;
  readonly avatarUrl: string | null;
  readonly phoneVerifiedAt: Date | null;
  readonly rateCents: number | null;
  /**
   * EVERY non-soft-deleted connection the expert holds (D4) — not "the expert's connection".
   * The caller MUST have filtered `deleted_at IS NULL`; a soft-deleted row must never reach
   * this array.
   */
  readonly calendarConnections: readonly ExpertCalendarConnectionState[];
  readonly hasActiveAvailabilityRules: boolean;
  readonly hasPayoutDetails: boolean;
  /**
   * S1 (fix round 1) — the expert's `users.deleted_at`, surfaced so the DERIVATION decides
   * rather than the READ silently returning "no opinion". Before this, `loadInputs` INNER
   * JOINed on `isNull(users.deletedAt)`, so a soft-deleted user matched zero rows and the
   * reconciler skipped them entirely — the one class of expert that most obviously must be
   * de-listed was the one class de-listing could never reach. Optional (rather than a bare
   * `Date | null`) so callers/tests that predate this field and never mention it keep reading
   * as "live" (the pre-existing default) instead of every unannotated fixture suddenly failing
   * `allComplete`.
   */
  readonly userDeletedAt?: Date | null;
}

export interface ExpertChecklistItems {
  readonly profile: boolean;
  readonly phone: boolean;
  readonly rate: boolean;
  readonly calendar: boolean;
  readonly availability: boolean;
  readonly payouts: boolean;
}

export interface ExpertChecklistDerivation {
  readonly items: ExpertChecklistItems;
  readonly completedCount: number;
  readonly allComplete: boolean;
  /** Keys whose item is `false`, in `EXPERT_CHECKLIST_ITEM_KEYS` order. `[]` iff allComplete. */
  readonly failingItems: readonly ExpertChecklistItemKey[];
}

/**
 * D4 — `calendar` is defined over the SET of connections: at least one live connection whose
 * credential is ACTIVE. Exported separately so the ANY-ACTIVE rule can be unit-tested and
 * pinned on its own, and so no caller is tempted to re-derive it.
 */
export function hasLiveCalendarConnection(
  connections: readonly ExpertCalendarConnectionState[]
): boolean {
  return connections.some((connection) => connection.credentialStatus === 'ACTIVE');
}

/**
 * The rule bodies, lifted verbatim from the pre-BAL-414 `expert-checklist.ts`, with only the
 * `calendar` item changed (D4, ANY-ACTIVE over the set rather than a single connection).
 */
export function deriveExpertChecklist(inputs: ExpertChecklistInputs): ExpertChecklistDerivation {
  const items: ExpertChecklistItems = {
    profile: Boolean(
      inputs.headline &&
      inputs.bio &&
      inputs.avatarUrl &&
      inputs.headline.trim().length > 0 &&
      inputs.bio.trim().length > 0
    ),
    phone: Boolean(inputs.phoneVerifiedAt),
    rate: Boolean(inputs.rateCents && inputs.rateCents > 0),
    calendar: hasLiveCalendarConnection(inputs.calendarConnections),
    // "Set your availability" completes when ≥1 enabled weekly rule is saved (BAL-234 §7).
    // NOT conjoined with `calendar` — that is its own checklist item.
    availability: inputs.hasActiveAvailabilityRules,
    payouts: inputs.hasPayoutDetails,
  };

  const failingItems = EXPERT_CHECKLIST_ITEM_KEYS.filter((key) => !items[key]);
  const completedCount = EXPERT_CHECKLIST_ITEM_KEYS.length - failingItems.length;
  // S1 — a soft-deleted user is `allComplete = false` OUTRIGHT, never "no opinion". Not folded
  // into `items`/`failingItems`: those six keys are the SETTINGS-PAGE checklist vocabulary (D11
  // renders them, the notification payload enumerates them) and account deletion is not
  // something the expert fixes from their settings page — it just must never let `allComplete`
  // read `true`.
  const userIsDeleted = Boolean(inputs.userDeletedAt);
  const allComplete = failingItems.length === 0 && !userIsDeleted;

  return { items, completedCount, allComplete, failingItems };
}

/**
 * Apply a not-yet-visible credential-status change to the connection set. Used by the API
 * credential-break path, whose flip has not committed when the derivation runs (§B.3 of the
 * plan) — `credentialStatusOverride` supplies the post-flip answer for the one connection that
 * is changing, so the derivation never reads a stale `calendar` value.
 *
 * Returns a NEW array; never mutates. A `connectionId` not present is a no-op (the connection
 * was soft-deleted concurrently) — do NOT synthesise a row for it.
 */
export function withCredentialStatusOverride(
  connections: readonly ExpertCalendarConnectionState[],
  connectionId: string,
  credentialStatus: string
): ExpertCalendarConnectionState[] {
  let found = false;
  const next = connections.map((connection) => {
    if (connection.id !== connectionId) return connection;
    found = true;
    return { ...connection, credentialStatus };
  });
  return found ? next : [...connections];
}

/** D7's `trigger` property. Derived from the NEW value so it can never drift from it. */
export type ExpertSearchabilityTrigger = 'checklist_complete' | 'checklist_regressed';

export function searchabilityTriggerFor(searchable: boolean): ExpertSearchabilityTrigger {
  return searchable ? 'checklist_complete' : 'checklist_regressed';
}

/**
 * Where a transition came from. AUDIT METADATA ONLY — deliberately richer than, and separate
 * from, the D7 analytics `trigger` above (two values, derived from the NEW boolean). Do not
 * merge the two vocabularies.
 *
 * ⚠⚠ EXACTLY ONE DEFINITION. `packages/db/src/repositories/expert-searchability.ts` re-exports
 * this as a type ALIAS (`export type ExpertSearchabilitySource = SharedExpertSearchabilitySource`)
 * rather than redeclaring the union — the dependency direction (`@balo/db → @balo/shared`, never
 * the reverse) only forbids `@balo/db` from importing back into this file's OTHER, DB-typed
 * sibling (`ExpertSearchabilityConnectionState`'s `credentialStatus`); it does not require, and
 * must never acquire, a second copy of this union. Add a new member HERE only.
 */
export type ExpertSearchabilitySource =
  | 'calendar_credential_break'
  | 'calendar_credential_repair'
  | 'calendar_connected'
  | 'calendar_disconnected'
  | 'calendar_sync_pending'
  | 'dashboard_read';

/**
 * The D7 analytics property bag, built ONCE here so `apps/api` and `apps/web` cannot construct
 * it two different ways (and so neither three-line emit site is long enough to register on the
 * SonarCloud new-code duplication gate). `distinct_id` is set by the caller's `expertProfileId`.
 */
export function buildSearchabilityAnalyticsProperties(input: {
  readonly expertProfileId: string;
  readonly searchable: boolean;
  readonly previousSearchable: boolean;
  readonly failingItems: readonly ExpertChecklistItemKey[];
}): {
  expert_id: string;
  searchable: boolean;
  trigger: ExpertSearchabilityTrigger;
  failing_items: ExpertChecklistItemKey[];
  previous_state: boolean;
  distinct_id: string;
} {
  return {
    expert_id: input.expertProfileId,
    searchable: input.searchable,
    trigger: searchabilityTriggerFor(input.searchable),
    failing_items: [...input.failingItems],
    previous_state: input.previousSearchable,
    distinct_id: input.expertProfileId,
  };
}
