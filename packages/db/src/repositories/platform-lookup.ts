import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  isLookupUuid,
  LOOKUP_ARM_LIMIT,
  LOOKUP_ENTITY_TYPES,
  LOOKUP_MIN_QUERY_LENGTH,
  LOOKUP_RESULT_CAP,
  type LookupEntityType,
  type LookupResult,
  type LookupSearchResult,
} from '@balo/shared/lookup';
import { db } from '../client';
import {
  agencies,
  agencyMembers,
  caseEngagements,
  companies,
  companyMembers,
  creditSessions,
  creditWallets,
  engagements,
  expertProfiles,
  partyDomains,
  projectEngagements,
  projectRequests,
  users,
} from '../schema';

/**
 * platform-lookup (BAL-551) — the platform-staff support search: ONE box that finds a
 * user, company, agency, expert profile, project request or credit session by name,
 * email, domain, username, title, uuid or Stripe PaymentIntent id.
 *
 * READ-ONLY. There is no write member here and there never will be — Lookup mutates
 * nothing (the `admin-lookup-never-writes` invariant in `apps/web` pins that at the route
 * level as well).
 *
 * ── SHAPE: SEVEN PARALLEL READS, MERGED IN TYPESCRIPT. NOT A SQL `UNION`. ────────────────
 *
 * Seven independent `db.select({…})` reads issued together via `Promise.all`, then merged
 * round-robin in TypeScript. Four reasons, and none of them is taste:
 *
 *  1. There is NO cross-entity `UNION` precedent in this package and the one place it was
 *     considered it was REFUSED — `repositories/representations.ts:192-193`: *"The
 *     `or(...)` IS the … read — one index-friendly predicate, no SQL `UNION`, no second
 *     query."* The first one does not get introduced in a support surface.
 *  2. A `UNION` forces a lowest-common-denominator column list. These seven arms have
 *     genuinely different join graphs (users → nothing; companies → `credit_wallets`;
 *     agencies → `party_domains`; expert profiles → `users` + `agencies`; project requests
 *     → `companies`; engagements → `companies` + `expert_profiles`/`users` +
 *     `case_engagements`/`project_engagements`/`project_requests`; credit sessions →
 *     `companies` + `expert_profiles` + `users`), so unioning them would push every
 *     sub-line's STRING CONSTRUCTION into SQL, where it is unreadable, untestable and
 *     un-internationalisable. Composed in TS, each sub-line is a pure exported function
 *     with unit tests.
 *  3. Parallel beats both sequential and `UNION` for latency: seven small concurrent scans
 *     over the `postgres-js` pool cost roughly the slowest one; a `UNION` serialises them
 *     into one plan on one connection.
 *  4. Per-type chip counts fall out for free from per-arm results — no extra `COUNT(*)`.
 *
 * ── NO RELATIONAL `with:` HYDRATION ANYWHERE ────────────────────────────────────────────
 *
 * Explicit `db.select({ … })` column maps only (memory
 * `reference_drizzle_with_hydration_leaks_secrets`). Relational `with:` hydrates WHOLE
 * rows, which on `users` means `workos_id` and on `credit_sessions` means
 * `expert_rate_minor_per_hour`, `balo_fee_bps` and `expert_accrued_minor`. Those must not
 * be in the row AT ALL, not merely unrendered — see `searchCreditSessions`.
 *
 * Each arm projects EXACTLY the columns a title/sub composer reads and nothing more. The
 * BAL-551 plan §1.4 enumerates a slightly wider allow-list per arm (`agencies.slug`,
 * `credit_wallets.expires_at`, `expert_profiles.agency_id`/`user_id`,
 * `credit_sessions.company_id`, `project_requests.send_to`); every one of those has no
 * reader in the composed sub-lines, so it is dropped. A narrower allow-list is strictly
 * safer than a wider one and never less so.
 *
 * ── ⚠⚠ UNINDEXED BY DELIBERATE CHOICE — REVISIT AT ~50,000 ROWS IN ANY ONE ARM. ─────────
 *
 * Every predicate here is a sequential scan. The schema has exactly ONE GIN index
 * (`expert_profiles_search_vector_idx`, headline + bio only — `schema/experts.ts:164`),
 * ZERO trigram indexes, and no `text_pattern_ops` anywhere, so the existing btree uniques
 * (`users_email_unique`, `expert_profiles_username_idx`) serve `=` only and never `ILIKE`.
 * None of the four `stripe_payment_intent_id` columns is indexed. This is the same stance
 * `expert-search.ts:241-256` already takes and states ("an optional gin_trgm_ops index …
 * skipped pre-PMF").
 *
 * WHY THAT IS FINE TODAY: this surface is platform-staff only, behind
 * `VIEW_PLATFORM_ADMIN`, capped at 20 results, minimum query length 2, and every arm is a
 * small table at pre-PMF volume. Seven concurrent small seq scans cost less than the
 * schema churn and the write amplification of seven trigram indexes.
 *
 * WHEN TO REVISIT: when any single arm's table passes ~50k live rows, or when p95 for
 * `platformLookupRepository.search` exceeds ~300ms in Axiom. The fix is then a `pg_trgm`
 * (`gin_trgm_ops`) index per matched text column plus `%`/`<%` operator predicates (the
 * OPERATORS, NOT the `word_similarity()` FUNCTION — only the operators are
 * index-accelerated; see `expert-search.ts:236-245`). That is a migration and a DBA phase;
 * it is deliberately NOT this ticket (BAL-551 scope ruling, B3).
 *
 * ⚠ NO `id::text LIKE 'abc%'` PREFIX MATCH ANYWHERE. A uuid PK btree cannot serve an
 * expression over the column under a non-C collation, and casting seven tables' primary keys
 * on every keystroke is a materially worse cost class than one ILIKE on one text column. A
 * uuid is matched with `eq()` when — and ONLY when — the query parses as a FULL uuid.
 *
 * ── ⚠ A PERSON WHO IS BOTH A USER AND AN EXPERT RETURNS TWO ROWS. DO NOT "FIX" IT. ──────
 *
 * Two rows, types `user` and `expert`, with distinct badges. That is the ticket's own chip
 * spec ("People (users + experts, **distinct badges**)") and the design prototype's
 * fixtures do exactly this. They are different entities with different Open policies — the
 * expert row may deep-link to a public profile, the user row never links anywhere. There
 * is deliberately no dedupe.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────────────────
 *
 * `@balo/db` NEVER reads a platform role — see `PlatformLookupSearchInput`.
 *
 * ── LOGGING ─────────────────────────────────────────────────────────────────────────────
 *
 * This module does not log, matching every other repository in the package: the Drizzle
 * logger hook in `packages/db/src/client.ts` already emits every query. The web LOADER
 * logs the caught-error boundary.
 */

// ── Constants ────────────────────────────────────────────────────────────────────────

/**
 * BAL-551 fix round R5 — `LOOKUP_RESULT_CAP`, `LOOKUP_ARM_LIMIT` and `LOOKUP_MIN_QUERY_LENGTH`
 * now live in `@balo/shared/lookup` (`./constants`), so a client component can read them
 * without a value import of `@balo/db` (memory `reference_balo_db_client_bundle_footgun`).
 * Re-exported here unchanged so every existing caller on this `@balo/db` path — this
 * module's own arm-limit clauses below, `repositories/index.ts`, `platform-lookup.test.ts`
 * and `platform-lookup.integration.test.ts` — keeps working without an import-path change.
 */
export { LOOKUP_RESULT_CAP, LOOKUP_ARM_LIMIT, LOOKUP_MIN_QUERY_LENGTH };

// ── Pure helpers (unit-tested in platform-lookup.test.ts) ────────────────────────────

/**
 * Escape the `LIKE` metacharacters so a typed `%`, `_` or `\` is a LITERAL, not a wildcard.
 *
 * Drizzle parameterises the pattern, so there is no injection surface — this exists so
 * `50% off` and `pi_3nq7…` behave as typed. An unescaped `_` in a PaymentIntent id is a
 * single-character wildcard, which silently WIDENS every session match. Postgres' default
 * `LIKE`/`ILIKE` escape character is `\`, so no `ESCAPE` clause is needed.
 *
 * Written as a character walk rather than a regex replace on purpose (memory
 * `reference_sonarcloud_redos_tagstrip_regex` — prefer no regex on a scan path).
 */
export function escapeLikePattern(value: string): string {
  let escaped = '';
  for (const char of value) {
    if (char === '\\' || char === '%' || char === '_') {
      escaped += '\\';
    }
    escaped += char;
  }
  return escaped;
}

/** `%<escaped>%` — the contains pattern every ILIKE arm uses. */
export function toContainsPattern(normalized: string): string {
  return `%${escapeLikePattern(normalized)}%`;
}

/**
 * trim + lowercase + collapse internal whitespace. Lowercasing is safe because every
 * predicate is either `ILIKE` (case-insensitive) or a uuid `eq` (uuids are case-insensitive
 * in Postgres and are canonically lowercase).
 *
 * Whitespace is collapsed with a token walk, not `split(/\s+/)`, to keep this file free of
 * regex on the per-keystroke path.
 */
export function normalizeLookupQuery(raw: string): string {
  const tokens: string[] = [];
  let current = '';
  for (const char of raw) {
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current !== '') {
    tokens.push(current);
  }
  return tokens.join(' ').toLowerCase();
}

/**
 * BAL-551 fix round F9 — re-exported so `isLookupUuid` stays importable from
 * `@balo/db`'s `platform-lookup` module (this file's own existing test imports it that way);
 * the DEFINITION now lives once, in `@balo/shared/lookup`, consumed by both this repository's
 * SQL-side uuid `eq()` gate and the web app's analytics-only classifier. See that module's
 * docblock for why a single case-insensitive predicate is correct for both callers.
 *
 * Load-bearing in two directions, unchanged by the hoist: a non-uuid passed to
 * `eq(<uuid column>, …)` makes Postgres raise 22P02 `invalid input syntax for type uuid` and
 * fail the whole arm, and a TRUNCATED uuid must resolve NOTHING (the no-prefix-match ruling).
 */
export { isLookupUuid };

/**
 * Round-robin merge across `LOOKUP_ENTITY_TYPES` order, NOT concat-and-slice.
 *
 * Concat-and-slice (what a `UNION … LIMIT 20` would do) lets 40 matching users crowd out
 * the single matching credit session — which is exactly the row a support person searching
 * a company name most needs. Round-robin guarantees every non-empty type contributes its
 * first row before any type contributes a second.
 *
 * `truncated` is `Σ|arm| > cap`, computed over the FULL arm lengths (each already capped at
 * `LOOKUP_ARM_LIMIT`), not over what survived the merge.
 */
export function mergeLookupResults(
  arms: ReadonlyMap<LookupEntityType, readonly LookupResult[]>,
  cap: number
): { results: LookupResult[]; truncated: boolean } {
  const { total, deepest } = measureArms(arms);

  const results: LookupResult[] = [];
  for (let round = 0; round < deepest && results.length < cap; round++) {
    for (const row of nthFromEachArm(arms, round)) {
      if (results.length >= cap) break;
      results.push(row);
    }
  }

  return { results, truncated: total > cap };
}

/** How many rows the arms hold in total, and how deep the deepest one is. */
function measureArms(arms: ReadonlyMap<LookupEntityType, readonly LookupResult[]>): {
  total: number;
  deepest: number;
} {
  let total = 0;
  let deepest = 0;
  for (const type of LOOKUP_ENTITY_TYPES) {
    const arm = arms.get(type);
    if (arm === undefined) continue;
    total += arm.length;
    if (arm.length > deepest) deepest = arm.length;
  }
  return { total, deepest };
}

/** One round of the round-robin: the `round`-th row of every arm that still has one. */
function nthFromEachArm(
  arms: ReadonlyMap<LookupEntityType, readonly LookupResult[]>,
  round: number
): LookupResult[] {
  const picked: LookupResult[] = [];
  for (const type of LOOKUP_ENTITY_TYPES) {
    const row = arms.get(type)?.[round];
    if (row !== undefined) picked.push(row);
  }
  return picked;
}

// ── Pure sub-line composers (unit-tested; the reason the merge is TS, not SQL) ────────

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * `12 Jun`, always in UTC. Hand-rolled rather than `toLocaleDateString` so the string is
 * identical in CI, on a laptop in Sydney and in a container with no ICU data.
 */
export function formatShortDate(value: Date): string {
  const month = MONTH_ABBREVIATIONS[value.getUTCMonth()];
  if (month === undefined) return '';
  return `${value.getUTCDate()} ${month}`;
}

/** Group a digit string in threes without a lookahead regex. */
function groupThousands(digits: string): string {
  const groups: string[] = [];
  let rest = digits;
  while (rest.length > 3) {
    groups.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  groups.unshift(rest);
  return groups.join(',');
}

/**
 * Minor units → `A$62.40`. A NEGATIVE balance renders with U+2212 MINUS SIGN, never the
 * hyphen a reader parses as a separating dash. `credit_wallets.currency` is CHECK-pinned to
 * `AUD`, but the code path degrades to `EUR 12.34` rather than mislabelling a future
 * currency as Australian dollars.
 */
export function formatMinorAmount(minor: number, currency: string): string {
  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const units = groupThousands(String(Math.trunc(absolute / 100)));
  const fraction = String(absolute % 100).padStart(2, '0');
  const symbol = currency === 'AUD' ? 'A$' : `${currency} `;
  return `${negative ? '−' : ''}${symbol}${units}.${fraction}`;
}

/** Turn `proposal_submitted` into `proposal submitted`. Never a regex. */
export function humanizeEnumLabel(value: string): string {
  return value.split('_').join(' ');
}

/** Join the non-empty segments of a sub-line, so an absent fact leaves no dangling `·`. */
function joinSegments(segments: readonly (string | null)[]): string {
  return segments.filter((segment): segment is string => segment !== null).join(' · ');
}

const COMPANY_ROLE_LABELS: Record<'owner' | 'admin' | 'member', string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/** The one live company membership rendered on a user row, plus how many they hold. */
export interface LookupUserMembership {
  readonly role: 'owner' | 'admin' | 'member';
  readonly companyName: string;
  /** Total LIVE memberships for that user, including this one. */
  readonly liveMembershipCount: number;
}

/**
 * `Owner @ Northwind Industrial · client mode`, `… +2 more · client mode` with more than
 * one live membership, `No company membership · client mode` with none.
 *
 * `activeMode` is reported as a FACT about the row, never as an authorization input
 * (ADR-1029: it is a view toggle).
 */
export function buildUserSub(
  activeMode: 'client' | 'expert',
  membership: LookupUserMembership | undefined
): string {
  const mode = `${activeMode} mode`;
  if (membership === undefined) {
    return joinSegments(['No company membership', mode]);
  }
  const extra =
    membership.liveMembershipCount > 1 ? ` +${membership.liveMembershipCount - 1} more` : '';
  return joinSegments([
    `${COMPANY_ROLE_LABELS[membership.role]} @ ${membership.companyName}${extra}`,
    mode,
  ]);
}

/**
 * `Client company · 6 members · northwind.com.au · wallet A$62.40`.
 *
 * "no wallet yet" and `A$0.00` are DIFFERENT facts and never collapse. A `null` domain
 * drops its whole segment rather than leaving a dangling separator.
 */
export function buildCompanySub(input: {
  readonly isPersonal: boolean;
  readonly memberCount: number;
  readonly domain: string | null;
  readonly walletBalanceMinor: number | null;
  readonly walletCurrency: string | null;
}): string {
  const kind = input.isPersonal ? 'Personal workspace' : 'Client company';

  let members: string;
  if (input.memberCount === 0) {
    members = 'no members yet';
  } else if (input.memberCount === 1) {
    members = '1 member';
  } else {
    members = `${input.memberCount} members`;
  }

  let wallet: string;
  if (input.walletBalanceMinor === null) {
    wallet = 'no wallet yet';
  } else {
    const amount = formatMinorAmount(input.walletBalanceMinor, input.walletCurrency ?? 'AUD');
    wallet = input.walletBalanceMinor < 0 ? `wallet ${amount} (overdrawn)` : `wallet ${amount}`;
  }

  return joinSegments([kind, members, input.domain, wallet]);
}

/** `Agency · 4 experts · cloudpeak.io`; `Agency · no experts yet` with none. */
export function buildAgencySub(input: {
  readonly expertCount: number;
  readonly domain: string | null;
}): string {
  let experts: string;
  if (input.expertCount === 0) {
    experts = 'no experts yet';
  } else if (input.expertCount === 1) {
    experts = '1 expert';
  } else {
    experts = `${input.expertCount} experts`;
  }
  return joinSegments(['Agency', experts, input.domain]);
}

/**
 * `Expert @ CloudPeak · @priya · approved · searchable`.
 *
 * Independent (null `agencyId`) reads `Independent expert`. A null username drops the
 * `@handle` segment. Approval state comes from `approvedAt` — `applicationStatus` only
 * sharpens the UNAPPROVED wording (`draft application` / `submitted, awaiting approval`),
 * because a staffer triaging an application wants to know which of those it is.
 */
export function buildExpertSub(input: {
  readonly agencyName: string | null;
  readonly username: string | null;
  readonly approvedAt: Date | null;
  readonly applicationStatus: string;
  readonly searchable: boolean;
}): string {
  const affiliation =
    input.agencyName === null ? 'Independent expert' : `Expert @ ${input.agencyName}`;

  let approval: string;
  if (input.approvedAt !== null) {
    approval = 'approved';
  } else if (input.applicationStatus === 'draft') {
    approval = 'draft application';
  } else if (input.applicationStatus === 'rejected') {
    approval = 'application rejected';
  } else {
    approval = 'awaiting approval';
  }

  return joinSegments([
    affiliation,
    input.username === null ? null : `@${input.username}`,
    approval,
    input.searchable ? 'searchable' : 'not searchable',
  ]);
}

/** `Project request · Northwind Industrial · proposal submitted · created 12 Jun`. */
export function buildProjectRequestSub(input: {
  readonly companyName: string;
  readonly status: string;
  readonly createdAt: Date;
}): string {
  return joinSegments([
    'Project request',
    input.companyName,
    humanizeEnumLabel(input.status),
    `created ${formatShortDate(input.createdAt)}`,
  ]);
}

/**
 * `Consultation · 12 Aug · 45 min`. The date is the session's most meaningful instant —
 * ended, else connected, else created. Minutes read `— min` while the session is still
 * `pending`, because a `connected_minutes` of 0 on an unstarted session is not "0 minutes
 * long", it is "not started".
 */
export function buildCreditSessionTitle(input: {
  readonly status: string;
  readonly connectedMinutes: number;
  readonly connectedAt: Date | null;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
}): string {
  const when = input.endedAt ?? input.connectedAt ?? input.createdAt;
  const minutes = input.status === 'pending' ? '— min' : `${input.connectedMinutes} min`;
  return joinSegments(['Consultation', formatShortDate(when), minutes]);
}

/**
 * `Northwind Industrial × Tom Okafor · ended · settled`.
 *
 * `× expert unavailable` when the session's expert profile is gone or its owning `users`
 * row is soft-deleted — the LEFT JOIN carries the null through rather than dropping the
 * session, because a support person looking up a PaymentIntent still needs to find it.
 */
export function buildCreditSessionSub(input: {
  readonly companyName: string;
  readonly expertFirstName: string | null;
  readonly expertLastName: string | null;
  readonly status: string;
  readonly settlementStatus: string;
}): string {
  const expertName = joinNameParts(input.expertFirstName, input.expertLastName);
  const parties = `${input.companyName} × ${expertName ?? 'expert unavailable'}`;
  return joinSegments([
    parties,
    humanizeEnumLabel(input.status),
    humanizeEnumLabel(input.settlementStatus),
  ]);
}

/**
 * BAL-555 — `CPQ implementation — replace legacy quoting tool`, else `Untitled project` /
 * `Untitled case`. Not `UNTITLED_ENGAGEMENT_LABEL` (`reviews.ts` = `'your project'`) — that
 * string is second-person email copy and reads wrong here.
 */
export function buildEngagementTitle(input: {
  readonly engagementType: string;
  readonly caseTitle: string | null;
  readonly requestTitle: string | null;
}): string {
  if (input.caseTitle !== null) return input.caseTitle;
  if (input.requestTitle !== null) return input.requestTitle;
  return input.engagementType === 'case' ? 'Untitled case' : 'Untitled project';
}

/**
 * BAL-555 — `Project · Northwind Industrial × Priya Nair · active · started 12 Jun`.
 * `× expert unavailable` when the name is null, mirroring `buildCreditSessionSub`.
 */
export function buildEngagementSub(input: {
  readonly engagementType: string;
  readonly companyName: string;
  readonly expertFirstName: string | null;
  readonly expertLastName: string | null;
  readonly status: string;
  readonly createdAt: Date;
}): string {
  const expertName = joinNameParts(input.expertFirstName, input.expertLastName);
  const parties = `${input.companyName} × ${expertName ?? 'expert unavailable'}`;
  const typeLabel = input.engagementType.charAt(0).toUpperCase() + input.engagementType.slice(1);
  return joinSegments([
    typeLabel,
    parties,
    humanizeEnumLabel(input.status),
    `started ${formatShortDate(input.createdAt)}`,
  ]);
}

/**
 * `"{first} {last}"` with the nullable halves handled, or `null` when both are absent.
 * `users` has NO `name` column — nullable `first_name` / `last_name` — which is why this
 * exists and why the SQL-side match uses the same `coalesce … || ' ' || coalesce …` shape
 * `expert-search.ts:263` already uses.
 */
export function joinNameParts(firstName: string | null, lastName: string | null): string | null {
  const joined = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  return joined === '' ? null : joined;
}

// ── SQL fragments ────────────────────────────────────────────────────────────────────

/**
 * The `users` display-name match. `users` has no `name` column, so the concat is built in
 * SQL — the exact shape `expert-search.ts:263` uses, so both surfaces agree on what "the
 * person's name" means (including the single space that lets `"dana whit"` match across it).
 */
function nameConcatMatches(pattern: string): SQL {
  return sql`coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '') ILIKE ${pattern}`;
}

/**
 * `EXISTS (SELECT 1 FROM party_domains …)` — "this party has a registered domain matching
 * the query".
 *
 * ⚠ `agencies` HAS NO `domain` COLUMN. Agency domains live only in the POLYMORPHIC
 * `party_domains` (`party_type='agency'`, `party_id` uuid, NO foreign key —
 * `schema/party-domains.ts:40`), so the `partyType` literal is what scopes the read; it is
 * not optional. Both halves of the "Companies & agencies" chip go through THIS ONE helper
 * so they cannot drift into different semantics: *"matches any registered domain of the
 * party."* The company arm additionally keeps `companies.domain ILIKE`, because that scalar
 * is the company's own primary domain and is not guaranteed mirrored into `party_domains`.
 *
 * Soft-delete-aware: a soft-deleted mapping is not a domain the party still owns.
 */
function partyDomainMatches(
  partyType: 'company' | 'agency',
  partyIdColumn: PgColumn,
  pattern: string
): SQL {
  return exists(
    db
      .select({ matched: sql`1` })
      .from(partyDomains)
      .where(
        and(
          eq(partyDomains.partyType, partyType),
          eq(partyDomains.partyId, partyIdColumn),
          isNull(partyDomains.deletedAt),
          ilike(partyDomains.domain, pattern)
        )
      )
  );
}

// ── The seven arms ───────────────────────────────────────────────────────────────────
//
// Soft-delete reality, VERIFIED against the schema — do not guess these:
//   users            YES  (schema/users.ts:56)
//   companies        NO   (`...timestamps` only — the `softDelete` nearby belongs to
//                          `company_members`; memory `reference_companies_table_no_deleted_at`)
//   agencies         NO   (schema/agencies.ts:26)
//   expert_profiles  NO   (guard the OWNING `users` row instead)
//   credit_wallets   NO
//   project_requests YES
//   credit_sessions  YES
//   party_domains    YES
//   engagements      YES  (schema/engagements.ts)
//   case_engagements / project_engagements  YES (both)
//   company_members / agency_members  YES (both)
//
// ⚠ Every soft-delete guard on a JOINED table sits in the JOIN CONDITION, never the WHERE
// clause — in the WHERE it silently converts a LEFT JOIN into an INNER JOIN and drops the
// row entirely (memory `reference_softdelete_join_filter_where_vs_join`). That is exactly
// the credit-session-with-a-deleted-expert case, which must still be findable.

interface UserArmRow {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string;
  readonly activeMode: 'client' | 'expert';
  readonly createdAt: Date;
}

function searchUsers(pattern: string, uuidValue: string | null): Promise<UserArmRow[]> {
  return db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      activeMode: users.activeMode,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        or(
          ilike(users.email, pattern),
          nameConcatMatches(pattern),
          uuidValue === null ? undefined : eq(users.id, uuidValue)
        )
      )
    )
    .orderBy(desc(users.createdAt), asc(users.id))
    .limit(LOOKUP_ARM_LIMIT);
}

function searchCompanies(pattern: string, uuidValue: string | null) {
  // `credit_wallets` is 1:1 with `companies` — guaranteed by the UNIQUE
  // `credit_wallets_company_idx` (`schema/credit-wallets.ts:236`) — so this LEFT JOIN
  // cannot multiply rows. It has no `deleted_at`, so its join condition carries no guard.
  return db
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      isPersonal: companies.isPersonal,
      walletBalanceMinor: creditWallets.balanceMinor,
      walletCurrency: creditWallets.currency,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .leftJoin(creditWallets, eq(creditWallets.companyId, companies.id))
    .where(
      or(
        ilike(companies.name, pattern),
        ilike(companies.domain, pattern),
        partyDomainMatches('company', companies.id, pattern),
        uuidValue === null ? undefined : eq(companies.id, uuidValue)
      )
    )
    .orderBy(desc(companies.createdAt), asc(companies.id))
    .limit(LOOKUP_ARM_LIMIT);
}

function searchAgencies(pattern: string, uuidValue: string | null) {
  return db
    .select({
      id: agencies.id,
      name: agencies.name,
      createdAt: agencies.createdAt,
    })
    .from(agencies)
    .where(
      or(
        ilike(agencies.name, pattern),
        partyDomainMatches('agency', agencies.id, pattern),
        uuidValue === null ? undefined : eq(agencies.id, uuidValue)
      )
    )
    .orderBy(desc(agencies.createdAt), asc(agencies.id))
    .limit(LOOKUP_ARM_LIMIT);
}

/**
 * ⚠⚠ THE MARKETPLACE PREDICATE IS STRIPPED, DELIBERATELY.
 *
 * `expert-search.ts:141-143` always applies `verticalId = ? AND searchable = true AND
 * approvedAt IS NOT NULL`. That is a PUBLIC-MARKETPLACE VISIBILITY GATE. Admin Lookup
 * exists precisely to find the UNAPPROVED and UNSEARCHABLE expert, so none of those three
 * conditions appears here and `expert-search.ts` is neither reused, imported nor extended —
 * this is an independent read. Re-adding `eq(expertProfiles.searchable, true)` fails an
 * integration assertion.
 */
function searchExpertProfiles(pattern: string, uuidValue: string | null) {
  return (
    db
      .select({
        id: expertProfiles.id,
        username: expertProfiles.username,
        searchable: expertProfiles.searchable,
        approvedAt: expertProfiles.approvedAt,
        applicationStatus: expertProfiles.applicationStatus,
        // `agencyName` alone decides affiliation — `agencies` has no soft delete and the FK
        // forbids a dangling `agency_id`, so `agencyName === null ⟺ agencyId === null`.
        agencyName: agencies.name,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        createdAt: expertProfiles.createdAt,
      })
      .from(expertProfiles)
      // `expert_profiles` has no `deleted_at`; the OWNING user's soft delete is the profile's
      // liveness, and it belongs in the join condition (see the block comment above).
      .innerJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(agencies, eq(agencies.id, expertProfiles.agencyId))
      .where(
        or(
          nameConcatMatches(pattern),
          ilike(users.email, pattern),
          ilike(expertProfiles.username, pattern),
          uuidValue === null ? undefined : eq(expertProfiles.id, uuidValue)
        )
      )
      .orderBy(desc(expertProfiles.createdAt), asc(expertProfiles.id))
      .limit(LOOKUP_ARM_LIMIT)
  );
}

function searchProjectRequests(pattern: string, uuidValue: string | null) {
  return db
    .select({
      id: projectRequests.id,
      title: projectRequests.title,
      status: projectRequests.status,
      companyName: companies.name,
      createdAt: projectRequests.createdAt,
    })
    .from(projectRequests)
    .innerJoin(companies, eq(companies.id, projectRequests.companyId))
    .where(
      and(
        isNull(projectRequests.deletedAt),
        or(
          ilike(projectRequests.title, pattern),
          ilike(companies.name, pattern),
          uuidValue === null ? undefined : eq(projectRequests.id, uuidValue)
        )
      )
    )
    .orderBy(desc(projectRequests.createdAt), asc(projectRequests.id))
    .limit(LOOKUP_ARM_LIMIT);
}

/**
 * ⚠ TWO MATCHABLE COLUMNS, AND ONLY TWO: the session's own `id`, and
 * `credit_sessions.stripe_payment_intent_id` — the SETTLEMENT PaymentIntent, on the session
 * row itself (`schema/credit-sessions.ts:231`, written by `markSettlementResult`). The
 * ticket's "via the ledger" is wrong: `credit_ledger.stripe_payment_intent_id` is a
 * DIFFERENT PaymentIntent (top-up / purchase charges) and the two never overlap. The other
 * two PI columns (`credit_receivables`, `credit_wallets.pending_topup_payment_intent_id`)
 * are NOT searched. Neither the title nor the parties are matchable, so a session is
 * reachable only by pasting an id — which is exactly the support workflow.
 *
 * ⚠⚠ THE PROJECTION IS A FEE-SAFE ALLOW-LIST. Explicitly ABSENT, and they must stay
 * absent: `expertRateMinorPerHour`, `expertRateMinorPerMinute`, `clientRateMinorPerMinute`,
 * `baloFeeBps`, `expertAccruedMinor`, `effectiveCeilingMinor`, `overdraftSettledMinor`,
 * every `settlementStripe*` column, and `stripePaymentIntentId` itself (matched ON, never
 * returned). Margin-bearing figures reach a staffer only through the Money section's
 * capability-gated API hop, never through a search row.
 */
function searchCreditSessions(pattern: string, uuidValue: string | null) {
  return (
    db
      .select({
        id: creditSessions.id,
        status: creditSessions.status,
        settlementStatus: creditSessions.settlementStatus,
        connectedAt: creditSessions.connectedAt,
        endedAt: creditSessions.endedAt,
        connectedMinutes: creditSessions.connectedMinutes,
        companyName: companies.name,
        expertFirstName: users.firstName,
        expertLastName: users.lastName,
        createdAt: creditSessions.createdAt,
      })
      .from(creditSessions)
      .innerJoin(companies, eq(companies.id, creditSessions.companyId))
      .leftJoin(expertProfiles, eq(expertProfiles.id, creditSessions.expertProfileId))
      // Guard in the JOIN CONDITION: a soft-deleted expert user must null out the NAME, not
      // drop the session from the result set.
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .where(
        and(
          isNull(creditSessions.deletedAt),
          or(
            ilike(creditSessions.stripePaymentIntentId, pattern),
            uuidValue === null ? undefined : eq(creditSessions.id, uuidValue)
          )
        )
      )
      .orderBy(desc(creditSessions.createdAt), asc(creditSessions.id))
      .limit(LOOKUP_ARM_LIMIT)
  );
}

/**
 * BAL-555 — the seventh arm: engagements.
 *
 * Matchable, and only these: the engagement uuid (`eq`, full uuid only — no `id::text
 * LIKE`), the case title (`case_engagements.title`), the originating project-request title
 * (`project_requests.title` via `project_engagements.project_request_id`), the client
 * company name, and the delivering expert's name (`nameConcatMatches`, resolved against the
 * expert's `users` row in this arm's join graph).
 *
 * ⚠ A DELIBERATE ASYMMETRY WITH THE SESSION ARM, STATED NOT HIDDEN. `searchCreditSessions`
 * matches only on an id, because a session is an instant a support person identifies by a
 * pasted id. An engagement is a durable object people NAME ("the Northwind CPQ
 * engagement"), so it matches on parties and titles.
 *
 * ⚠⚠ THE PROJECTION IS A FEE-SAFE ALLOW-LIST, the `searchCreditSessions` rule applied to
 * this arm. Explicitly ABSENT and required to stay absent: `engagements.baloFeeBps`,
 * `engagements.currency`, `project_engagements.priceCents` / `depositCents` / `rateCents`,
 * and every other `project_engagements` commercial column. Pinned by an integration
 * key-set assertion.
 */
function searchEngagements(pattern: string, uuidValue: string | null) {
  return (
    db
      .select({
        id: engagements.id,
        engagementType: engagements.engagementType,
        status: engagements.status,
        createdAt: engagements.createdAt,
        companyName: companies.name,
        expertFirstName: users.firstName,
        expertLastName: users.lastName,
        caseTitle: caseEngagements.title,
        requestTitle: projectRequests.title,
      })
      .from(engagements)
      .innerJoin(companies, eq(companies.id, engagements.companyId))
      .leftJoin(expertProfiles, eq(expertProfiles.id, engagements.expertProfileId))
      // Guard in the JOIN CONDITION: a soft-deleted expert user nulls the NAME, never drops
      // the row.
      .leftJoin(users, and(eq(users.id, expertProfiles.userId), isNull(users.deletedAt)))
      .leftJoin(
        caseEngagements,
        and(eq(caseEngagements.engagementId, engagements.id), isNull(caseEngagements.deletedAt))
      )
      .leftJoin(
        projectEngagements,
        and(
          eq(projectEngagements.engagementId, engagements.id),
          isNull(projectEngagements.deletedAt)
        )
      )
      .leftJoin(
        projectRequests,
        and(
          eq(projectRequests.id, projectEngagements.projectRequestId),
          isNull(projectRequests.deletedAt)
        )
      )
      .where(
        and(
          isNull(engagements.deletedAt),
          or(
            ilike(caseEngagements.title, pattern),
            ilike(projectRequests.title, pattern),
            ilike(companies.name, pattern),
            nameConcatMatches(pattern),
            uuidValue === null ? undefined : eq(engagements.id, uuidValue)
          )
        )
      )
      .orderBy(desc(engagements.createdAt), asc(engagements.id))
      .limit(LOOKUP_ARM_LIMIT)
  );
}

// ── Enrichment: four bounded follow-up reads, each keyed on ≤20 ids ───────────────────
//
// The `projects-inbox.ts` "one batched follow-up, never N+1" pattern. Each returns early
// with an empty Map when its arm is empty, so an empty arm issues NO query (and an empty
// `inArray` — a SQL error — is unreachable).
//
// Note the asymmetry, stated rather than hidden: the domain MATCH (`domain ILIKE`, above)
// is a sequential scan, while the domain READ-BACK below rides the existing
// `party_domains_party_idx (party_type, party_id)`.

/**
 * E1 — one live company membership per matched user, plus how many they hold.
 *
 * "One" is the OLDEST live membership (`joined_at ASC, id ASC`) — their original workspace,
 * and a deterministic choice rather than an arbitrary one. Role is read here for DISPLAY
 * only; it is never interpreted into a capability (`packages/shared/src/authz/index.ts` is
 * the single place a role string becomes a capability, ADR-1029).
 */
async function loadUserMemberships(
  userIds: readonly string[]
): Promise<Map<string, LookupUserMembership>> {
  if (userIds.length === 0) return new Map();

  const rows = await db
    .select({
      userId: companyMembers.userId,
      role: companyMembers.role,
      companyName: companies.name,
    })
    .from(companyMembers)
    .innerJoin(companies, eq(companies.id, companyMembers.companyId))
    .where(and(isNull(companyMembers.deletedAt), inArray(companyMembers.userId, [...userIds])))
    .orderBy(asc(companyMembers.joinedAt), asc(companyMembers.id));

  const byUser = new Map<string, LookupUserMembership>();
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (existing === undefined) {
      byUser.set(row.userId, {
        role: row.role,
        companyName: row.companyName,
        liveMembershipCount: 1,
      });
    } else {
      byUser.set(row.userId, {
        role: existing.role,
        companyName: existing.companyName,
        liveMembershipCount: existing.liveMembershipCount + 1,
      });
    }
  }
  return byUser;
}

/** E2 — live member count per matched company. */
async function loadCompanyMemberCounts(
  companyIds: readonly string[]
): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();

  const rows = await db
    .select({ companyId: companyMembers.companyId, memberCount: count() })
    .from(companyMembers)
    .where(
      and(isNull(companyMembers.deletedAt), inArray(companyMembers.companyId, [...companyIds]))
    )
    .groupBy(companyMembers.companyId);

  return new Map(rows.map((row) => [row.companyId, row.memberCount]));
}

/**
 * E3 — live member count per matched agency. Every live agency member is counted, not only
 * role `expert`: an agency's owner and admins deliver too, and the sub-line is a size
 * signal for a support person, not a role census.
 */
async function loadAgencyMemberCounts(agencyIds: readonly string[]): Promise<Map<string, number>> {
  if (agencyIds.length === 0) return new Map();

  const rows = await db
    .select({ agencyId: agencyMembers.agencyId, memberCount: count() })
    .from(agencyMembers)
    .where(and(isNull(agencyMembers.deletedAt), inArray(agencyMembers.agencyId, [...agencyIds])))
    .groupBy(agencyMembers.agencyId);

  return new Map(rows.map((row) => [row.agencyId, row.memberCount]));
}

/** E4 — the primary (oldest live) registered domain per matched agency. */
async function loadAgencyDomains(agencyIds: readonly string[]): Promise<Map<string, string>> {
  if (agencyIds.length === 0) return new Map();

  const rows = await db
    .select({ partyId: partyDomains.partyId, domain: partyDomains.domain })
    .from(partyDomains)
    .where(
      and(
        eq(partyDomains.partyType, 'agency'),
        isNull(partyDomains.deletedAt),
        inArray(partyDomains.partyId, [...agencyIds])
      )
    )
    .orderBy(asc(partyDomains.createdAt), asc(partyDomains.id));

  const byAgency = new Map<string, string>();
  for (const row of rows) {
    if (!byAgency.has(row.partyId)) {
      byAgency.set(row.partyId, row.domain);
    }
  }
  return byAgency;
}

// ── Public API ───────────────────────────────────────────────────────────────────────

export interface PlatformLookupSearchInput {
  /** The raw query as typed. Normalised (trim + lowercase + collapse) inside. */
  readonly query: string;
  /**
   * ⚠⚠ THE CALLER'S ASSERTION THAT IT HAS ALREADY RESOLVED
   * `PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN` FOR THIS VIEWER (ADR-1029 / ADR-1035).
   * `@balo/db` NEVER reads a platform role and never will — this repository has no
   * `platformRole` import, no `isPlatformAdmin` call and no capability logic.
   *
   * Typed as the LITERAL `true`, not `boolean`, so a caller cannot pass a variable it has
   * not proven: writing the word `true` is a deliberate act at every call site, and a
   * `boolean`-typed value fails tsc.
   *
   * The ONE authorized caller today is
   * `apps/web/src/app/(dashboard)/admin/lookup/_lib/load-lookup.ts`, which resolves the
   * capability itself before calling. A second caller must do the same.
   */
  readonly authorizedPlatformStaff: true;
}

export const platformLookupRepository = {
  /**
   * Search all seven entity types at once. Returns at most `LOOKUP_RESULT_CAP` results,
   * round-robin merged; `truncated` says the arms held more than fitted; `tooShort` says
   * the query was refused before any table was touched.
   *
   * `input.authorizedPlatformStaff` is INTENTIONALLY not destructured or read — it is a
   * type-level obligation on the caller, and an unused local binding is a static-analysis
   * smell.
   */
  async search(input: PlatformLookupSearchInput): Promise<LookupSearchResult> {
    const normalized = normalizeLookupQuery(input.query);
    if (normalized.length < LOOKUP_MIN_QUERY_LENGTH) {
      return { results: [], truncated: false, tooShort: true };
    }

    const pattern = toContainsPattern(normalized);
    const uuidValue = isLookupUuid(normalized) ? normalized : null;

    const [
      userRows,
      companyRows,
      agencyRows,
      expertRows,
      requestRows,
      engagementRows,
      sessionRows,
    ] = await Promise.all([
      searchUsers(pattern, uuidValue),
      searchCompanies(pattern, uuidValue),
      searchAgencies(pattern, uuidValue),
      searchExpertProfiles(pattern, uuidValue),
      searchProjectRequests(pattern, uuidValue),
      searchEngagements(pattern, uuidValue),
      searchCreditSessions(pattern, uuidValue),
    ]);

    const agencyIds = agencyRows.map((row) => row.id);
    const [userMemberships, companyMemberCounts, agencyMemberCounts, agencyDomains] =
      await Promise.all([
        loadUserMemberships(userRows.map((row) => row.id)),
        loadCompanyMemberCounts(companyRows.map((row) => row.id)),
        loadAgencyMemberCounts(agencyIds),
        loadAgencyDomains(agencyIds),
      ]);

    const arms = new Map<LookupEntityType, readonly LookupResult[]>([
      [
        'user',
        userRows.map((row) => ({
          id: row.id,
          type: 'user' as const,
          title: joinNameParts(row.firstName, row.lastName) ?? row.email,
          sub: buildUserSub(row.activeMode, userMemberships.get(row.id)),
          publicExpertUsername: null,
          engagementType: null,
        })),
      ],
      [
        'expert',
        expertRows.map((row) => ({
          id: row.id,
          type: 'expert' as const,
          title: joinNameParts(row.firstName, row.lastName) ?? row.email,
          sub: buildExpertSub({
            agencyName: row.agencyName,
            username: row.username,
            approvedAt: row.approvedAt,
            applicationStatus: row.applicationStatus,
            searchable: row.searchable,
          }),
          // The Open-link policy's ONE type-specific input: the public profile page 404s
          // unless the profile is approved AND searchable AND its user is live (the last
          // is already guaranteed by this arm's INNER JOIN).
          publicExpertUsername:
            row.username !== null && row.searchable && row.approvedAt !== null
              ? row.username
              : null,
          engagementType: null,
        })),
      ],
      [
        'company',
        companyRows.map((row) => ({
          id: row.id,
          type: 'company' as const,
          title: row.name,
          sub: buildCompanySub({
            isPersonal: row.isPersonal,
            memberCount: companyMemberCounts.get(row.id) ?? 0,
            domain: row.domain,
            walletBalanceMinor: row.walletBalanceMinor,
            walletCurrency: row.walletCurrency,
          }),
          publicExpertUsername: null,
          engagementType: null,
        })),
      ],
      [
        'agency',
        agencyRows.map((row) => ({
          id: row.id,
          type: 'agency' as const,
          title: row.name,
          sub: buildAgencySub({
            expertCount: agencyMemberCounts.get(row.id) ?? 0,
            domain: agencyDomains.get(row.id) ?? null,
          }),
          publicExpertUsername: null,
          engagementType: null,
        })),
      ],
      [
        'project_request',
        requestRows.map((row) => ({
          id: row.id,
          type: 'project_request' as const,
          title: row.title,
          sub: buildProjectRequestSub({
            companyName: row.companyName,
            status: row.status,
            createdAt: row.createdAt,
          }),
          publicExpertUsername: null,
          engagementType: null,
        })),
      ],
      [
        'engagement',
        engagementRows.map((row) => ({
          id: row.id,
          type: 'engagement' as const,
          title: buildEngagementTitle({
            engagementType: row.engagementType,
            caseTitle: row.caseTitle,
            requestTitle: row.requestTitle,
          }),
          sub: buildEngagementSub({
            engagementType: row.engagementType,
            companyName: row.companyName,
            expertFirstName: row.expertFirstName,
            expertLastName: row.expertLastName,
            status: row.status,
            createdAt: row.createdAt,
          }),
          publicExpertUsername: null,
          engagementType: row.engagementType,
        })),
      ],
      [
        'credit_session',
        sessionRows.map((row) => ({
          id: row.id,
          type: 'credit_session' as const,
          title: buildCreditSessionTitle({
            status: row.status,
            connectedMinutes: row.connectedMinutes,
            connectedAt: row.connectedAt,
            endedAt: row.endedAt,
            createdAt: row.createdAt,
          }),
          sub: buildCreditSessionSub({
            companyName: row.companyName,
            expertFirstName: row.expertFirstName,
            expertLastName: row.expertLastName,
            status: row.status,
            settlementStatus: row.settlementStatus,
          }),
          publicExpertUsername: null,
          engagementType: null,
        })),
      ],
    ]);

    const { results, truncated } = mergeLookupResults(arms, LOOKUP_RESULT_CAP);
    return { results, truncated, tooShort: false };
  },
};
