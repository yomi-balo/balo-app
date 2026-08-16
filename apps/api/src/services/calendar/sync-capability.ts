/**
 * BAL-447 / ADR-1021 (amendment 2026-08-15) — THE PROVIDER SYNC-CAPABILITY MATRIX.
 *
 * ⚠⚠ THIS MODULE IS INERT AND HAS NO LIVE CONSUMER, ON PURPOSE. It is a shipped RULING, not
 * machinery — the house precedent is `services/transcript/capture-failure.ts` (BAL-387, "INERT
 * today (no live producer): a callable seam only"), the BAL-420 dispatch seam,
 * `authz/engagement-capability-disjoint.ts` (unimported, held by `tsc` because
 * `apps/api/tsconfig.json` includes `src/**` whether or not anything imports it), and
 * `services/availability/vendor-busy.ts` itself.
 *
 * ⚠ WHAT IT RECORDS, AND WHY THE TWO COLUMNS ARE DELIBERATELY DECOUPLED:
 *   · `supportsSyncToken` is an OBSERVED VENDOR FACT and it is NOT uniform — Google returns
 *     `nextSyncToken` on the final page (BAL-393 §P3); Microsoft never returns it at all,
 *     on any page, verified paginated to exhaustion at pageSize=1 (§M2).
 *   · `baloSyncStrategy` is BALO'S RULING and it IS uniform: every provider gets
 *     `full_window_reread`.
 *
 * ⚠⚠ THE POINT OF THE RULING IS THAT COLUMN 2 IS NOT A FUNCTION OF COLUMN 1. Balo does not
 * delta-sync Google EVEN THOUGH GOOGLE CAN, because:
 *   1. the sync token is on `events.list`, while availability is sourced from `freeBusy.get`,
 *      which has NO delta mode on either provider;
 *   2. switching availability to full event reads violates the onecal skill's Constraint 4
 *      privacy posture (busy slots, no titles);
 *   3. a delta-fed cache feeds the ADVERTISE path from a different source than the ACCEPT
 *      path — the divergence `../availability/vendor-busy.ts` exists to make unrepresentable.
 *
 * ⚠ DO NOT "SIMPLIFY" THIS BY DELETING `supportsSyncToken`. Recording the divergence is what
 * makes the ruling a ruling rather than an accident of capability. The guard test
 * (`../../invariants/sync-token-parity.test.ts`) asserts the divergence is still recorded.
 *
 * ⚠ OUTSIDE `invariants/`, THIS MODULE IS THE ONLY FILE UNDER `apps/api/src` PERMITTED TO NAME
 * `syncToken` IN CODE. Stated precisely because that is precisely what Scan A of the guard test
 * (`../../invariants/sync-token-parity.test.ts`) enforces: it exempts this file AND the whole
 * `invariants/` directory — the guards have to be able to name what they forbid — and it
 * classifies a mention that appears only on comment lines as non-offending, so prose explaining
 * the ban does not trip it.
 */

/**
 * ⚠ TWO PROVIDERS, AND `apple` / `icloud` ARE DELIBERATELY ABSENT. No `apple`/`icloud` value
 * exists anywhere in the shipped calendar surface, and a speculative row would be an
 * unevidenced guess in a table whose whole point is that every row carries evidence. Adding a
 * provider here without a matrix row is a COMPILE ERROR (see `satisfies` below) — the forcing
 * function is better than the guess.
 *
 * ⚠ THIS IS NOT A FOURTH HAND-WRITTEN COPY OF THE ROUTE UNION. `routes/calendar/types.ts` and
 * `routes/calendar/auth.ts` declare the same vocabulary by hand and are NOT imported here
 * (a service importing from `routes/` would be a dependency inversion). Scan D of the guard
 * test reconciles the two instead.
 */
export const CALENDAR_PROVIDERS = ['google', 'microsoft'] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];

/**
 * ⚠ SINGLE-MEMBER ON PURPOSE. `SyncStrategy` DERIVES from this array, so adding a second
 * strategy is an edit to this line — which the guard test pins. Provider conditionality
 * cannot be introduced without tripping it. (Same lockstep trick as BAL-420's
 * `WebSchedulableNotificationEvent` / `WEB_SCHEDULABLE_EVENTS` pair.)
 */
export const SYNC_STRATEGIES = ['full_window_reread'] as const;
export type SyncStrategy = (typeof SYNC_STRATEGIES)[number];

export type DeltaMechanism = 'events_list_sync_token' | 'none';
export type ChangePush = 'webhook' | 'none';

export interface ProviderSyncCapability {
  /** Observed vendor fact. NOT an input to `baloSyncStrategy`. */
  readonly supportsSyncToken: boolean;
  readonly deltaMechanism: DeltaMechanism;
  readonly changePush: ChangePush;
  /** Balo's ruling. Uniform across providers by ADR-1021 amendment 2026-08-15. */
  readonly baloSyncStrategy: SyncStrategy;
  /** Where the fact was measured. Required — an unevidenced row is a guess. */
  readonly evidence: string;
}

/**
 * ⚠ `as const satisfies Record<…>`, NOT a type annotation. `satisfies` keeps the literal types
 * so the guard test's data-layer assertions can compare them, while still forcing
 * exhaustiveness over `CalendarProvider`.
 *
 * ⚠ INDEXING THIS NEEDS NO GUARD AND NO `!` under `noUncheckedIndexedAccess` — the keys are
 * known literals, not an index signature. An index-position `!` here is the SonarCloud
 * "unnecessary non-null assertion" false positive (memory `reference_sonar_nonnull_false_positive`).
 */
export const SYNC_CAPABILITY_MATRIX = {
  google: {
    supportsSyncToken: true,
    deltaMechanism: 'events_list_sync_token',
    changePush: 'webhook',
    baloSyncStrategy: 'full_window_reread',
    evidence: 'BAL-393 FINDINGS.md §P3 — nextSyncToken on the FINAL page only',
  },
  microsoft: {
    supportsSyncToken: false,
    deltaMechanism: 'none',
    changePush: 'webhook',
    baloSyncStrategy: 'full_window_reread',
    evidence: 'BAL-393 FINDINGS.md §M2 — never returned, any page, exhausted at pageSize=1',
  },
} as const satisfies Record<CalendarProvider, ProviderSyncCapability>;

/**
 * The one strategy resolver. Reads the matrix — it does NOT read `supportsSyncToken`, and
 * that decoupling is deliberate: it is what gives the guard test teeth (a boolean flip must
 * not be able to change Balo's strategy).
 *
 * ⚠ IF YOU ARE ABOUT TO ADD A BRANCH HERE, STOP: that is the provider conditionality
 * ADR-1021's 2026-08-15 amendment forbids. Amend the ADR; do not edit this function.
 */
export function resolveSyncStrategy(provider: CalendarProvider): SyncStrategy {
  return SYNC_CAPABILITY_MATRIX[provider].baloSyncStrategy;
}

/**
 * The files constituting the sync path TODAY, relative to `apps/api/src`.
 *
 * ⚠ THIS IS NOT THE GUARD'S SCAN SUBJECT, AND MUST NOT BECOME ONE AGAIN. Scan B / Scan E of
 * `../../invariants/sync-token-parity.test.ts` DERIVE their subjects from a directory walk,
 * precisely so a new file cannot opt out of the ban by not being listed here (empirically
 * reproduced in review: a fresh `services/calendar/<name>.ts` containing `switch (provider)`
 * passed a pinned-list scan). This list survives as an asserted SUBSET sanity check — every entry
 * must exist and must fall inside the scanned set — and as the one place
 * `routes/calendar/webhook.ts` is carried for Scan B.
 *
 * ⚠ THE TWO SCANS WALK DIFFERENT BOUNDARIES, AND THE ASYMMETRY IS DELIBERATE. Scan B (provider
 * literals) walks `jobs/`, `services/availability/` and `services/calendar/` only — `routes/calendar/`
 * is excluded because `auth.ts`, `api.ts` and `types.ts` legitimately name both providers, and
 * including it would need a three-file exemption list. Scan E (event-content reads) walks those
 * three dirs PLUS `routes/calendar/` in full, with no exemption list, because none of
 * `events.list` / `updatedAfter` / `expandRecurrences` appears anywhere under it and none ever
 * should — which is what puts BAL-396's future Apiroc/Svix webhook route inside that ban.
 *
 * ⚠ SCOPE IS STILL THE POINT. A tree-wide provider-literal ban would flag legitimate provider
 * handling (the OAuth connect URLs and the frontend-facing union in `routes/calendar/auth.ts` /
 * `api.ts` / `types.ts`, the `office365` ↔ `microsoft` translation in `services/cronofy/oauth.ts`,
 * Graph calendar-id encoding) and degrade into an allowlist nobody reads. Inside the sync path a
 * provider literal has no legitimate business, and THAT — as a directory boundary, not a file
 * list — is the checkable line. When a directory trips a legitimate file, NARROW THE DIRECTORY;
 * never weaken the matcher.
 */
export const SYNC_PATH_FILES = [
  'routes/calendar/webhook.ts',
  'jobs/availability-cache.ts',
  'services/availability/vendor-busy.ts',
  'services/availability/resolve-and-cache.ts',
  'services/availability/window-availability.ts',
] as const;
