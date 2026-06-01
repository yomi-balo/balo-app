import { and, eq, gte, lte, isNotNull, inArray, exists, sql, type SQL } from 'drizzle-orm';
import { db } from '../client';
import {
  expertProfiles,
  expertSkills,
  expertLanguages,
  expertIndustries,
  skills,
  supportTypes,
  languages,
  verticals,
} from '../schema';

// ── Public types ─────────────────────────────────────────────────

export interface ExpertSearchParams {
  query?: string;
  productIds: string[];
  supportTypeIds: string[];
  languageIds: string[];
  industryIds: string[];
  verticalId: string; // resolved from slug by the route
  timeframe?: 'today' | '3days' | 'week';
  rateMinCents?: number;
  rateMaxCents?: number;
  sort: 'best_match' | 'soonest' | 'lowest_rate' | 'most_experienced';
  page: number;
  pageSize: number;
  availabilityGateEnabled: boolean; // route passes isAvailabilityGateEnabled()
  now: Date; // injected for deterministic gate/timeframe boundaries
}

export interface ExpertSearchRow {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
  headline: string | null;
  bio: string | null;
  rateCents: number | null;
  earliestAvailableAt: Date | null;
  isSalesforceMvp: boolean;
  isSalesforceCta: boolean;
  isCertifiedTrainer: boolean;
  yearStartedSalesforce: number | null;
  agencyName: string | null;
  agencyLogoUrl: string | null;
  consultationCount: number;
  languages: { name: string; flagEmoji: string | null }[];
}

export interface FacetCount {
  id: string;
  name: string;
  count: number;
}

// ── Timeframe boundaries (deterministic, computed in JS from now) ──

const DAY_MS = 24 * 60 * 60 * 1000;

const TIMEFRAME_DAYS: Record<NonNullable<ExpertSearchParams['timeframe']>, number> = {
  today: 1,
  '3days': 3,
  week: 7,
};

/**
 * Upper bound for a timeframe filter: `now + N days`. Returned as a Date so it
 * is bound as a parameter (no `now() + interval` raw SQL → deterministic).
 */
export function timeframeBoundary(
  timeframe: NonNullable<ExpertSearchParams['timeframe']>,
  now: Date
): Date {
  return new Date(now.getTime() + TIMEFRAME_DAYS[timeframe] * DAY_MS);
}

// ── Shared gate predicate (single source of truth) ───────────────

/**
 * The two SQL fragments that implement the availability gate: a cached slot must
 * exist AND be in the future. Used by BOTH `buildWhereConditions` (the search
 * gate) and `facetEligibilityConditions` (the facet-count gate) so the gate
 * semantics live in one place. The boundary is bound as an ISO string + cast to
 * timestamptz — `ac.earliest_available_at` is a raw SQL fragment (not a typed
 * Drizzle column), so the Date needs an explicit encoder via the cast.
 */
function availabilityGatePredicates(now: Date): SQL[] {
  return [
    sql`ac.earliest_available_at IS NOT NULL`,
    sql`ac.earliest_available_at > ${now.toISOString()}::timestamptz`,
  ];
}

// ── Pure helper: WHERE conditions ────────────────────────────────

/**
 * Build the array of WHERE conditions for a search. Pure — no DB access, no
 * `process.env`. Composition rules:
 *   - Base visibility: vertical + searchable + approved (always).
 *   - Filters: OR-within a facet (via `inArray` inside one `exists`), AND-across
 *     facets (each facet contributes one `exists` term combined by the caller's
 *     `and(...)`). Empty facet arrays are skipped (no invalid `IN ()`).
 *   - Availability gate (env-flagged): when enabled, require a future cached slot.
 *   - Timeframe (user filter, gate-independent): require a cached slot on/before
 *     `now + N days` — self-gates even when the availability flag is off.
 *   - Rate bounds exclude null-rate experts only when a bound is set.
 *   - Full-text match (only when `q` present): strict FTS @@ OR trigram fuzzy on
 *     headline OR trigram fuzzy on any skill name.
 *
 * NOTE: `expert_profiles` has NO `deleted_at` column — do NOT filter it here.
 */
export function buildWhereConditions(params: ExpertSearchParams, now: Date): SQL[] {
  const conditions: SQL[] = [
    eq(expertProfiles.verticalId, params.verticalId),
    eq(expertProfiles.searchable, true),
    isNotNull(expertProfiles.approvedAt),
  ];

  // OR-within / AND-across facet filters via correlated EXISTS.
  if (params.productIds.length) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(expertSkills)
          .where(
            and(
              eq(expertSkills.expertProfileId, expertProfiles.id),
              inArray(expertSkills.skillId, params.productIds)
            )
          )
      )
    );
  }

  if (params.supportTypeIds.length) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(expertSkills)
          .where(
            and(
              eq(expertSkills.expertProfileId, expertProfiles.id),
              inArray(expertSkills.supportTypeId, params.supportTypeIds)
            )
          )
      )
    );
  }

  if (params.languageIds.length) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(expertLanguages)
          .where(
            and(
              eq(expertLanguages.expertProfileId, expertProfiles.id),
              inArray(expertLanguages.languageId, params.languageIds)
            )
          )
      )
    );
  }

  if (params.industryIds.length) {
    conditions.push(
      exists(
        db
          .select({ x: sql`1` })
          .from(expertIndustries)
          .where(
            and(
              eq(expertIndustries.expertProfileId, expertProfiles.id),
              inArray(expertIndustries.industryId, params.industryIds)
            )
          )
      )
    );
  }

  // Rate bounds (per-minute cents). Null-rate experts excluded only when bounded.
  if (params.rateMinCents != null) {
    conditions.push(gte(expertProfiles.rateCents, params.rateMinCents));
  }
  if (params.rateMaxCents != null) {
    conditions.push(lte(expertProfiles.rateCents, params.rateMaxCents));
  }

  // Availability gate (env-flagged): require a future cached slot. Shared with
  // facet counts via availabilityGatePredicates (single source of truth).
  if (params.availabilityGateEnabled) {
    conditions.push(...availabilityGatePredicates(now));
  }

  // Timeframe (user filter, independent of the gate flag): require a cached slot
  // on/before the boundary. Implies future availability.
  if (params.timeframe) {
    const boundary = timeframeBoundary(params.timeframe, now);
    conditions.push(sql`ac.earliest_available_at IS NOT NULL`);
    conditions.push(sql`ac.earliest_available_at <= ${boundary.toISOString()}::timestamptz`);
  }

  // Full-text match: strict FTS OR trigram fuzzy (headline + skill names).
  // Only added when `q` is present — no per-skill subquery on a wide-open browse.
  //
  // Fuzzy term uses `word_similarity(q, text) > 0.3` (NOT the whole-string `%`
  // operator): `%` compares the ENTIRE headline/skill string to q, so any
  // multi-word headline ("Salesforce platform architect") scores far below the
  // 0.3 `%` threshold and a real typo ("salezforce") would never match. The
  // word-similarity form compares q against the best-matching word/extent, which
  // is what "fuzzy near-miss on a token" actually means. Note: word_similarity()
  // called as a FUNCTION (the explicit `> 0.3` predicate) is NOT accelerated by
  // gin_trgm_ops indexes — only the `<% / %>` operators are — so we deliberately
  // do not maintain trigram indexes for it; this fallback runs over the
  // base-visibility-narrowed candidate set.
  const q = normalizeQuery(params.query);
  if (q) {
    conditions.push(
      sql`(
        ${expertProfiles.searchVector} @@ websearch_to_tsquery('english', ${q})
        OR word_similarity(${q}, coalesce(${expertProfiles.headline}, '')) > 0.3
        OR EXISTS (
          SELECT 1 FROM ${expertSkills} es
          JOIN ${skills} s ON s.id = es.skill_id
          WHERE es.expert_profile_id = ${expertProfiles.id}
            AND word_similarity(${q}, s.name) > 0.3
        )
      )`
    );
  }

  return conditions;
}

// ── Pure helper: ORDER BY ────────────────────────────────────────

/**
 * Build the ORDER BY expression list per sort mode. Pure — no DB access. Every
 * sort appends `expert_profiles.id ASC` as a stable final tiebreaker so
 * pagination is deterministic.
 *
 * `best_match` references the `rank` relevance alias (0 when `q` absent → falls
 * through to the browse order: soonest, then most consultations).
 */
export function buildOrderBy(sort: ExpertSearchParams['sort']): SQL[] {
  const idTiebreaker = sql`${expertProfiles.id} ASC`;

  switch (sort) {
    case 'soonest':
      return [sql`${availabilityCacheEarliest} ASC NULLS LAST`, idTiebreaker];

    case 'lowest_rate':
      return [sql`${expertProfiles.rateCents} ASC NULLS LAST`, idTiebreaker];

    case 'most_experienced':
      return [
        sql`${expertProfiles.yearStartedSalesforce} ASC NULLS LAST`,
        sql`${expertProfiles.projectCountMin} DESC NULLS LAST`,
        sql`consultation_count DESC`,
        idTiebreaker,
      ];

    case 'best_match':
    default:
      return [
        sql`rank DESC NULLS LAST`,
        sql`${availabilityCacheEarliest} ASC NULLS LAST`,
        sql`consultation_count DESC`,
        idTiebreaker,
      ];
  }
}

// ── Shared SQL fragments ─────────────────────────────────────────

/**
 * Correlated reference to `availability_cache.earliest_available_at` for the
 * expert currently in scope. The main query LEFT JOINs availability_cache, so
 * this column is selectable + sortable even when the gate is off.
 */
const availabilityCacheEarliest = sql`ac.earliest_available_at`;

/** Strip/normalize the free-text query; returns null when there is nothing to match. */
function normalizeQuery(query: string | undefined): string | null {
  const trimmed = query?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Relevance expression. A/B from the stored vector dominate; skills participate
 * via a real `setweight(..., 'C')` term; a small trigram bump keeps fuzzy-only
 * hits above non-matches. Emits literal `0` when `q` is absent (no FTS / skills
 * subquery runs at all).
 */
function relevanceExpression(q: string | null): SQL {
  if (!q) return sql`0`;
  return sql`(
    ts_rank(${expertProfiles.searchVector}, websearch_to_tsquery('english', ${q}))
    + COALESCE((
        SELECT MAX(ts_rank(setweight(to_tsvector('english', s.name), 'C'),
                           websearch_to_tsquery('english', ${q})))
        FROM ${expertSkills} es JOIN ${skills} s ON s.id = es.skill_id
        WHERE es.expert_profile_id = ${expertProfiles.id}
      ), 0)
    + 0.1 * word_similarity(${q}, coalesce(${expertProfiles.headline}, ''))
  )`;
}

/**
 * consultationCount proxy: confirmed, non-soft-deleted consultations. Real-data
 * no-op at launch (consultations is an empty stub → every expert gets 0), so the
 * tiebreaker is inert until the consultations feature ships completed rollups.
 * Index-supported by `consultations_expert_status_range_idx`.
 */
const consultationCountExpression = sql`COALESCE((
  SELECT count(*) FROM consultations c
  WHERE c.expert_profile_id = ${expertProfiles.id}
    AND c.status = 'confirmed' AND c.deleted_at IS NULL
), 0)`;

/** Per-row languages aggregation (avoids N+1) via correlated json_agg. */
const languagesJsonExpression = sql<{ name: string; flagEmoji: string | null }[]>`COALESCE((
  SELECT json_agg(json_build_object('name', l.name, 'flagEmoji', l.flag_emoji)
                  ORDER BY l.name)
  FROM ${expertLanguages} el JOIN ${languages} l ON l.id = el.language_id
  WHERE el.expert_profile_id = ${expertProfiles.id}
), '[]'::json)`;

// ── Internal: visibility predicate for facet counts ──────────────

/**
 * Base eligibility predicate for facet counts: visibility + (optional) gate.
 * Selection-INDEPENDENT — never narrowed by `q` or facet selections.
 */
function facetEligibilityConditions(
  verticalId: string,
  availabilityGateEnabled: boolean,
  now: Date
): SQL[] {
  const conditions: SQL[] = [
    eq(expertProfiles.verticalId, verticalId),
    eq(expertProfiles.searchable, true),
    isNotNull(expertProfiles.approvedAt),
  ];
  if (availabilityGateEnabled) {
    conditions.push(...availabilityGatePredicates(now));
  }
  return conditions;
}

// ── Internal: shape of the raw search SELECT ─────────────────────

/**
 * The row shape returned by the main search SELECT. Declared explicitly because
 * the raw `sql` joins (users/agencies/availability_cache) erase Drizzle's
 * inferred join typing — this keeps the mapper fully typed.
 */
interface SearchSelectRow {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  countryCode: string | null;
  headline: string | null;
  bio: string | null;
  rateCents: number | null;
  earliestAvailableAt: Date | null;
  isSalesforceMvp: boolean;
  isSalesforceCta: boolean;
  isCertifiedTrainer: boolean;
  yearStartedSalesforce: number | null;
  agencyName: string | null;
  agencyLogoUrl: string | null;
  consultationCount: number;
  languages: { name: string; flagEmoji: string | null }[];
  rank: number;
  totalCount: number;
}

// ── Repository ───────────────────────────────────────────────────

export const expertSearchRepository = {
  /** Resolve a vertical slug to its id. Returns null if not found (route → 400). */
  async resolveVerticalId(slug: string): Promise<string | null> {
    const row = await db.query.verticals.findFirst({
      where: eq(verticals.slug, slug),
      columns: { id: true },
    });
    return row?.id ?? null;
  },

  /**
   * Ranked, paginated rows + total. Single query using `count(*) OVER ()` for a
   * snapshot-consistent total vs the returned page. LEFT JOINs availability_cache
   * so earliest_available_at is selectable for the mapper + `soonest` sort even
   * when the gate is off.
   */
  async search(params: ExpertSearchParams): Promise<{ rows: ExpertSearchRow[]; total: number }> {
    const q = normalizeQuery(params.query);
    const conditions = buildWhereConditions(params, params.now);
    const orderBy = buildOrderBy(params.sort);

    const rows = (await db
      .select({
        id: expertProfiles.id,
        username: expertProfiles.username,
        firstName: sql<string | null>`u.first_name`,
        lastName: sql<string | null>`u.last_name`,
        avatarUrl: sql<string | null>`u.avatar_url`,
        countryCode: sql<string | null>`u.country_code`,
        headline: expertProfiles.headline,
        bio: expertProfiles.bio,
        rateCents: expertProfiles.rateCents,
        earliestAvailableAt: sql<Date | null>`ac.earliest_available_at`,
        isSalesforceMvp: expertProfiles.isSalesforceMvp,
        isSalesforceCta: expertProfiles.isSalesforceCta,
        isCertifiedTrainer: expertProfiles.isCertifiedTrainer,
        yearStartedSalesforce: expertProfiles.yearStartedSalesforce,
        agencyName: sql<string | null>`ag.name`,
        agencyLogoUrl: sql<string | null>`ag.logo_url`,
        consultationCount: sql<number>`${consultationCountExpression}::int`.as(
          'consultation_count'
        ),
        languages: languagesJsonExpression,
        rank: relevanceExpression(q).as('rank'),
        totalCount: sql<number>`count(*) OVER ()`.as('total_count'),
      })
      .from(expertProfiles)
      .innerJoin(sql`users u`, sql`u.id = ${expertProfiles.userId}`)
      .leftJoin(sql`agencies ag`, sql`ag.id = ${expertProfiles.agencyId}`)
      .leftJoin(sql`availability_cache ac`, sql`ac.expert_profile_id = ${expertProfiles.id}`)
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize)) as unknown as SearchSelectRow[];

    const total = rows.length > 0 ? Number(rows[0]!.totalCount) : 0;

    const mapped: ExpertSearchRow[] = rows.map((r: SearchSelectRow) => ({
      id: r.id,
      username: r.username,
      firstName: r.firstName,
      lastName: r.lastName,
      avatarUrl: r.avatarUrl,
      countryCode: r.countryCode,
      headline: r.headline,
      bio: r.bio,
      rateCents: r.rateCents,
      earliestAvailableAt: r.earliestAvailableAt ? new Date(r.earliestAvailableAt) : null,
      isSalesforceMvp: r.isSalesforceMvp,
      isSalesforceCta: r.isSalesforceCta,
      isCertifiedTrainer: r.isCertifiedTrainer,
      yearStartedSalesforce: r.yearStartedSalesforce,
      agencyName: r.agencyName,
      agencyLogoUrl: r.agencyLogoUrl,
      consultationCount: Number(r.consultationCount),
      languages: (r.languages ?? []).map((l: { name: string; flagEmoji: string | null }) => ({
        name: l.name,
        flagEmoji: l.flagEmoji,
      })),
    }));

    return { rows: mapped, total };
  },

  /**
   * Selection-INDEPENDENT facet totals (one GROUP BY per facet group). Respects
   * base visibility + availability gate ONLY — EXCLUDES `q` and all facet
   * selections, so the result depends solely on `(verticalId, gateOn)`.
   * `count(DISTINCT expert_profile_id)` prevents double-counting an expert with
   * multiple skills mapping to one facet value.
   */
  async facetCounts(
    verticalId: string,
    availabilityGateEnabled: boolean,
    now: Date
  ): Promise<{
    products: FacetCount[];
    supportTypes: FacetCount[];
    languages: FacetCount[];
  }> {
    const eligible = facetEligibilityConditions(verticalId, availabilityGateEnabled, now);
    const eligibleWhere = and(...eligible);

    const eligibleSet = db
      .select({ id: expertProfiles.id })
      .from(expertProfiles)
      .leftJoin(sql`availability_cache ac`, sql`ac.expert_profile_id = ${expertProfiles.id}`)
      .where(eligibleWhere);

    const [productRows, supportTypeRows, languageRows] = await Promise.all([
      db
        .select({
          id: skills.id,
          name: skills.name,
          count: sql<number>`count(DISTINCT ${expertSkills.expertProfileId})::int`,
        })
        .from(expertSkills)
        .innerJoin(skills, eq(skills.id, expertSkills.skillId))
        .where(inArray(expertSkills.expertProfileId, eligibleSet))
        .groupBy(skills.id, skills.name),

      db
        .select({
          id: supportTypes.id,
          name: supportTypes.name,
          count: sql<number>`count(DISTINCT ${expertSkills.expertProfileId})::int`,
        })
        .from(expertSkills)
        .innerJoin(supportTypes, eq(supportTypes.id, expertSkills.supportTypeId))
        .where(inArray(expertSkills.expertProfileId, eligibleSet))
        .groupBy(supportTypes.id, supportTypes.name),

      db
        .select({
          id: languages.id,
          name: languages.name,
          count: sql<number>`count(DISTINCT ${expertLanguages.expertProfileId})::int`,
        })
        .from(expertLanguages)
        .innerJoin(languages, eq(languages.id, expertLanguages.languageId))
        .where(inArray(expertLanguages.expertProfileId, eligibleSet))
        .groupBy(languages.id, languages.name),
    ]);

    const toFacet = (r: { id: string; name: string; count: number }): FacetCount => ({
      id: r.id,
      name: r.name,
      count: Number(r.count),
    });

    return {
      products: productRows.map(toFacet),
      supportTypes: supportTypeRows.map(toFacet),
      languages: languageRows.map(toFacet),
    };
  },
};
