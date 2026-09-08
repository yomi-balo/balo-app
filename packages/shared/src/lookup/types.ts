/**
 * BAL-551 — the Lookup result DTO and its shipped vocabulary tuples.
 *
 * Lives in `@balo/shared`, NOT `@balo/db`, for the reason
 * `apps/web/src/lib/api/session-money-block.ts:11-13` already states verbatim for
 * `SessionMoneyBlock`: *"The payload TYPE comes from `@balo/shared/credit` — NEVER
 * `@balo/db` (memory `reference_balo_db_client_bundle_footgun`): a client component may
 * import this type without dragging the postgres driver into the bundle."* Every Lookup
 * client component imports `LookupResult`, so it must be reachable without a value import
 * of `@balo/db`, whose barrel re-exports `postgres` and breaks `next build` on an
 * unresolvable `tls`.
 *
 * ⚠ PURE TYPES AND CONST TUPLES ONLY. No I/O, no `@balo/db`, no React, no pino. The
 * package ROOT (`packages/shared/src/index.ts`) is deliberately untouched — this is a
 * subpath-only export (`@balo/shared/lookup`), matching `./credit`, `./reviews` and
 * `./workspaces`.
 *
 * ⚠ THIS FILE CARRIES NO MONEY AND NO FEE FIELD, BY CONSTRUCTION. See `LookupResult`.
 */

/**
 * The six entity types Lookup searches. **This tuple's ORDER is load-bearing**: it is the
 * round-robin order `mergeLookupResults` (`@balo/db`) walks when it fills the result cap,
 * so a non-empty arm earlier in this list contributes its first row before any arm
 * contributes a second.
 *
 * There is deliberately no `meeting` member — `meetings` has no title, no parties and zero
 * FKs (ADR-1045, machine-enforced by `meetings-no-context-column.test.ts`), so it is not
 * searchable at all (BAL-551 scope ruling, cut 1).
 */
export const LOOKUP_ENTITY_TYPES = [
  'user',
  'expert',
  'company',
  'agency',
  'project_request',
  'credit_session',
] as const;

/** One searchable entity type. */
export type LookupEntityType = (typeof LOOKUP_ENTITY_TYPES)[number];

/**
 * The five type chips, in render order. FIVE, not six: `people` folds `user` + `expert`
 * (which keep DISTINCT badges in the row), and `orgs` folds `company` + `agency`.
 *
 * ⚠ `'orgs'` IS A SHIPPED WIRE VALUE. It crosses into PostHog as the `type_filter`
 * property of `admin_lookup_searched`, so renaming it later re-keys historical events.
 * The key matches the design prototype's own `TYPE_FILTERS`
 * (`.claude/design-references/admin-home.jsx:1360`); the chip's user-facing LABEL is
 * "Companies & agencies" and lives with the other view vocabulary in the web app, never
 * here.
 */
export const LOOKUP_TYPE_FILTERS = ['all', 'people', 'orgs', 'sessions', 'requests'] as const;

/** One chip filter key. */
export type LookupTypeFilter = (typeof LOOKUP_TYPE_FILTERS)[number];

/**
 * One search hit, already composed for rendering.
 *
 * ⚠⚠ NO MONEY AND NO FEE FIELD, BY CONSTRUCTION — AND THAT IS THE POINT OF THE SHAPE.
 * The company `sub` may quote the CLIENT'S OWN prepaid wallet balance
 * (`credit_wallets.balance_minor`), which that client already sees on their own dashboard
 * (BAL-402); it is not a fee, not expert earnings and not margin. Everything
 * margin-bearing — `balo_fee_bps`, `expert_rate_minor_per_hour`, `expert_accrued_minor` —
 * lives behind the Money section's capability-gated API hop and never reaches a search
 * row. The credit-session arm's projection in `@balo/db` is an explicit fee-safe
 * allow-list for exactly this reason, and an integration assertion pins this key set so a
 * widened projection fails.
 */
export interface LookupResult {
  /**
   * The entity's own uuid. NOT globally unique ACROSS types — key React rows by
   * `${type}:${id}`, never by `id` alone.
   */
  readonly id: string;
  readonly type: LookupEntityType;
  /** Line 1 — the name/title. Never empty: falls back to a type-specific placeholder. */
  readonly title: string;
  /** Line 2 — the one-line sub, pre-composed by the repository. */
  readonly sub: string;
  /**
   * The username of an expert whose PUBLIC profile currently resolves, else `null`. The
   * ONLY type-specific field on this DTO, and it exists because the Open-link policy needs
   * it: `(marketing)/experts/[username]/page.tsx` 404s unless the profile is approved AND
   * searchable AND its user is live. `null` for every other type, and `null` for an
   * unapproved / unsearchable / username-less expert.
   */
  readonly publicExpertUsername: string | null;
}

/** What one `platformLookupRepository.search(...)` call returns. */
export interface LookupSearchResult {
  /** At most the repository's result cap, round-robin merged across the non-empty arms. */
  readonly results: readonly LookupResult[];
  /** true when the arms together held more rows than the cap could carry → render "refine". */
  readonly truncated: boolean;
  /**
   * true when the normalised query was shorter than the repository's minimum query length.
   * `results` is then `[]` and NO query was issued against any table.
   */
  readonly tooShort: boolean;
}
