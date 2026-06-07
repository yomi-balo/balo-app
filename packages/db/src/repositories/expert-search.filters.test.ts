// `buildWhereConditions` composes its facet `EXISTS` terms via `db.select(...)`,
// so the Drizzle `db` client must exist before the repository module loads. The
// client (`client.ts`) initializes EAGERLY at module-evaluation time from
// `process.env.DATABASE_URL` (postgres-js connects lazily, so no Postgres is
// contacted — these tests only inspect the composed SQL ASTs, never execute a
// query). Static `import` declarations are hoisted ABOVE top-level statements, so
// setting the env var on a top-level line would run too late; the repository must
// therefore be loaded via a dynamic `import()` AFTER the env var is set.
process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/test';

import { describe, it, expect, beforeAll } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ExpertSearchParams } from './expert-search';

type ExpertSearchModule = typeof import('./expert-search');

let buildWhereConditions: ExpertSearchModule['buildWhereConditions'];
let buildOrderBy: ExpertSearchModule['buildOrderBy'];
let timeframeBoundary: ExpertSearchModule['timeframeBoundary'];

beforeAll(async () => {
  // Loaded dynamically so `client.ts` evaluates with DATABASE_URL already set
  // (a real, lazily-connecting query builder rather than an undefined client).
  const mod = await import('./expert-search');
  buildWhereConditions = mod.buildWhereConditions;
  buildOrderBy = mod.buildOrderBy;
  timeframeBoundary = mod.timeframeBoundary;
});

const dialect = new PgDialect();
const toSql = (s: SQL): string => dialect.sqlToQuery(s).sql;
const joinSql = (arr: SQL[]): string => arr.map(toSql).join(' || ');

const NOW = new Date('2026-06-02T00:00:00.000Z');

function params(overrides: Partial<ExpertSearchParams> = {}): ExpertSearchParams {
  return {
    productIds: [],
    supportTypeIds: [],
    languageIds: [],
    industryIds: [],
    verticalId: 'vertical-1',
    sort: 'best_match',
    page: 1,
    pageSize: 20,
    availabilityGateEnabled: false,
    now: NOW,
    ...overrides,
  };
}

describe('buildWhereConditions — base visibility', () => {
  it('always includes vertical + searchable + approved (and nothing else when empty)', () => {
    const conds = buildWhereConditions(params(), NOW);
    expect(conds).toHaveLength(3);
    const sql = joinSql(conds);
    expect(sql).toContain('"vertical_id"');
    expect(sql).toContain('"searchable"');
    expect(sql).toContain('"approved_at" is not null');
  });

  it('does NOT filter deleted_at on expert_profiles (no such column)', () => {
    const sql = joinSql(buildWhereConditions(params(), NOW));
    expect(sql).not.toContain('deleted_at');
  });
});

describe('buildWhereConditions — facet filters (OR-within / AND-across)', () => {
  it('adds one EXISTS per non-empty facet (AND-across)', () => {
    const conds = buildWhereConditions(
      params({
        productIds: ['p1'],
        supportTypeIds: ['st1'],
        languageIds: ['l1'],
        industryIds: ['i1'],
      }),
      NOW
    );
    // 3 base + 4 facet exists
    expect(conds).toHaveLength(7);
  });

  it('emits an IN list for OR-within a facet (multiple product ids)', () => {
    const conds = buildWhereConditions(params({ productIds: ['p1', 'p2', 'p3'] }), NOW);
    const existsSql = toSql(conds[3]);
    expect(existsSql).toContain('exists');
    expect(existsSql).toContain('"expert_competency"');
    expect(existsSql).toContain('"product_id" in ($1, $2, $3)');
  });

  it('uses support_type_id for the supportTypes facet', () => {
    const conds = buildWhereConditions(params({ supportTypeIds: ['st1'] }), NOW);
    expect(toSql(conds[3])).toContain('"support_type_id" in');
  });

  it('uses expert_languages for the languages facet', () => {
    const conds = buildWhereConditions(params({ languageIds: ['l1'] }), NOW);
    expect(toSql(conds[3])).toContain('"expert_languages"');
  });

  it('uses expert_industries for the industries facet', () => {
    const conds = buildWhereConditions(params({ industryIds: ['i1'] }), NOW);
    expect(toSql(conds[3])).toContain('"expert_industries"');
  });

  it('skips empty facet arrays (no invalid IN ())', () => {
    const conds = buildWhereConditions(params({ productIds: [] }), NOW);
    expect(conds).toHaveLength(3);
    expect(joinSql(conds)).not.toContain('in ()');
  });
});

describe('buildWhereConditions — rate bounds', () => {
  it('adds a >= bound for rateMin', () => {
    const conds = buildWhereConditions(params({ rateMinCents: 100 }), NOW);
    expect(toSql(conds[3])).toContain('"rate_cents" >=');
  });

  it('adds a <= bound for rateMax', () => {
    const conds = buildWhereConditions(params({ rateMaxCents: 200 }), NOW);
    expect(toSql(conds[3])).toContain('"rate_cents" <=');
  });

  it('adds both bounds when both are set', () => {
    const conds = buildWhereConditions(params({ rateMinCents: 100, rateMaxCents: 200 }), NOW);
    expect(conds).toHaveLength(5);
  });

  it('adds no rate predicate when neither bound is set', () => {
    const sql = joinSql(buildWhereConditions(params(), NOW));
    expect(sql).not.toContain('"rate_cents"');
  });
});

describe('buildWhereConditions — availability gate', () => {
  it('adds NOT NULL + future predicates when the gate is enabled', () => {
    const conds = buildWhereConditions(params({ availabilityGateEnabled: true }), NOW);
    expect(conds).toHaveLength(5);
    expect(toSql(conds[3])).toBe('ac.earliest_available_at IS NOT NULL');
    expect(toSql(conds[4])).toContain('ac.earliest_available_at >');
    expect(toSql(conds[4])).toContain('::timestamptz');
  });

  it('adds no availability predicate when the gate is disabled', () => {
    const sql = joinSql(buildWhereConditions(params({ availabilityGateEnabled: false }), NOW));
    expect(sql).not.toContain('earliest_available_at');
  });
});

describe('buildWhereConditions — timeframe (gate-independent)', () => {
  it('adds NOT NULL + upper-bound predicates regardless of the gate flag', () => {
    const conds = buildWhereConditions(
      params({ timeframe: 'today', availabilityGateEnabled: false }),
      NOW
    );
    expect(conds).toHaveLength(5);
    expect(toSql(conds[3])).toBe('ac.earliest_available_at IS NOT NULL');
    expect(toSql(conds[4])).toContain('ac.earliest_available_at <=');
  });

  it('stacks with the gate when both are present', () => {
    const conds = buildWhereConditions(
      params({ timeframe: 'week', availabilityGateEnabled: true }),
      NOW
    );
    // 3 base + 2 gate + 2 timeframe
    expect(conds).toHaveLength(7);
  });
});

describe('buildWhereConditions — full-text query', () => {
  it('adds an FTS+fuzzy match clause only when q is present', () => {
    expect(buildWhereConditions(params(), NOW)).toHaveLength(3);
    const conds = buildWhereConditions(params({ query: 'agentforce' }), NOW);
    expect(conds).toHaveLength(4);
    const sql = toSql(conds[3]);
    expect(sql).toContain('websearch_to_tsquery');
    expect(sql).toContain('word_similarity');
    expect(sql).toContain('"search_vector" @@');
  });

  it('treats a blank/whitespace q as absent', () => {
    expect(buildWhereConditions(params({ query: '   ' }), NOW)).toHaveLength(3);
  });
});

describe('buildOrderBy', () => {
  it('best_match: rank primary, then soonness, consultations, id', () => {
    const ob = buildOrderBy('best_match');
    expect(ob).toHaveLength(4);
    expect(toSql(ob[0])).toBe('rank DESC NULLS LAST');
    expect(toSql(ob[1])).toContain('ac.earliest_available_at ASC NULLS LAST');
    expect(toSql(ob[2])).toContain('consultation_count DESC');
    expect(toSql(ob[3])).toContain('"id" ASC');
  });

  it('soonest: earliest availability then id', () => {
    const ob = buildOrderBy('soonest');
    expect(ob).toHaveLength(2);
    expect(toSql(ob[0])).toContain('ac.earliest_available_at ASC NULLS LAST');
    expect(toSql(ob[1])).toContain('"id" ASC');
  });

  it('lowest_rate: rate ascending (nulls last) then id', () => {
    const ob = buildOrderBy('lowest_rate');
    expect(ob).toHaveLength(2);
    expect(toSql(ob[0])).toContain('"rate_cents" ASC NULLS LAST');
    expect(toSql(ob[1])).toContain('"id" ASC');
  });

  it('most_experienced: year started asc, project count desc, consultations, id', () => {
    const ob = buildOrderBy('most_experienced');
    expect(ob).toHaveLength(4);
    expect(toSql(ob[0])).toContain('"year_started_salesforce" ASC NULLS LAST');
    expect(toSql(ob[1])).toContain('"project_count_min" DESC NULLS LAST');
    expect(toSql(ob[2])).toContain('consultation_count DESC');
    expect(toSql(ob[3])).toContain('"id" ASC');
  });

  it('every sort ends with the stable id tiebreaker', () => {
    for (const sort of ['best_match', 'soonest', 'lowest_rate', 'most_experienced'] as const) {
      const ob = buildOrderBy(sort);
      expect(toSql(ob[ob.length - 1])).toContain('"id" ASC');
    }
  });
});

describe('timeframeBoundary', () => {
  it('today → now + 1 day', () => {
    expect(timeframeBoundary('today', NOW).toISOString()).toBe('2026-06-03T00:00:00.000Z');
  });

  it('3days → now + 3 days', () => {
    expect(timeframeBoundary('3days', NOW).toISOString()).toBe('2026-06-05T00:00:00.000Z');
  });

  it('week → now + 7 days', () => {
    expect(timeframeBoundary('week', NOW).toISOString()).toBe('2026-06-09T00:00:00.000Z');
  });
});
