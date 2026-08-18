import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { stripComments } from '@balo/shared/testing';
import { calendarConnections } from '../schema/calendar';

/**
 * ADR-1021, amendment 18 Aug 2026 (BAL-467), §1 — "A calendar connection is per
 * (expert, provider). Each connected provider is a distinct Apiroc End User Account,
 * stored as its own `calendar_connections` row, unique on `(expertId, provider)`. An
 * expert may hold connections to multiple providers at once; availability is the union of
 * busy blocks across all of the expert's connections; connect, disconnect, and reconnect
 * are per-provider. `targetCalendarId` is per connection."
 *
 * ⚠ THAT AMENDMENT, NOT THE PARENT ADR. ADR-1021's body rules on vendor selection and the
 * `endUserAccountId` pointer model and says NOTHING about cardinality. Citing the parent
 * would send the next reader to a document that does not contain the rule.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. Before BAL-467 the table was unique on
 * `expert_profile_id` ALONE, which made a second provider physically unrepresentable. The
 * migration replaces that with a PARTIAL unique on `(expert_profile_id, provider)`. Three
 * distinct regressions would each silently restore the old world, and none is caught by
 * typecheck, lint, or the mocked unit test:
 *
 *   1. someone re-adds a unique index on `expert_profile_id` alone (Layer 1);
 *   2. someone drops the `WHERE deleted_at IS NULL` predicate, which makes
 *      disconnect → reconnect fail 23505 against an invisible soft-deleted row (Layer 2);
 *   3. someone "fixes" (2) by putting `deleted_at` in the KEY COLUMNS instead — which
 *      looks equivalent, is not, and permits UNLIMITED live duplicates because NULL is
 *      not equal to itself in a unique index (Layer 2);
 *   4. someone points the repository's ON CONFLICT arbiter back at `expertProfileId`
 *      alone, or drops its `targetWhere` (Layer 3).
 *
 * THE BAR (set by `sync-token-parity.test.ts`): this must fail when someone writes the
 * WRONG CODE, not merely when someone flips a constant. Layers 1 and 2 read the LIVE
 * table metadata via `getTableConfig` — structural, so a comment cannot satisfy them, and
 * a renamed index cannot dodge them. Layer 3 reads the repository SOURCE, because the
 * arbiter is a call-site fact that no table metadata records.
 *
 * ⚠ EXPLICITLY NOT IN THIS FILE: the real-Postgres behavioural proof — two providers
 * coexist, a duplicate `(expert, provider)` is rejected with 23505, `upsertConnection`
 * updates rather than raising 42P10, and reconnect-after-soft-delete succeeds. Those need
 * a database and live in `repositories/calendar.integration.test.ts`. They CANNOT live
 * here: this file runs in the UNIT job with no Docker, where the integration suite's global
 * setup would need to reach Docker to provision Testcontainers. Correction (fix brief round
 * 2, item 14 — measured with `DOCKER_HOST=tcp://127.0.0.1:1`): the console banner claims
 * "No test files found" / "exiting with code 0", but `global-setup.ts` actually throws
 * FIRST and the process exits 1 — Docker-down turns CI red, it does not falsely pass. A
 * unit-job-safe structural guard is still the right design here regardless.
 */

// ── Layer 1 + 2 subject: the declared table metadata ──────────────

const TABLE = getTableConfig(calendarConnections);
const DIALECT = new PgDialect();

interface ParsedIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly predicate: string | undefined;
}

/**
 * `config.columns` holds `PgColumn` objects for plain column references and raw SQL for
 * expression indexes. Only `.name` is read, and a missing one falls through to a marker
 * string rather than throwing — a parse failure must surface as a FAILED assertion below,
 * never as a thrown error that reads like infrastructure noise.
 */
function parseIndex(index: (typeof TABLE.indexes)[number]): ParsedIndex {
  const config = index.config;
  const columns = config.columns.map((column) =>
    'name' in column && typeof column.name === 'string' ? column.name : '<expression>'
  );
  return {
    // Drizzle types `name` as optional (`index()` may be declared unnamed). Every index
    // on this table IS named; the fallback exists so an unnamed one shows up in a failure
    // message as `<unnamed>` rather than crashing the parse.
    name: config.name ?? '<unnamed>',
    unique: config.unique === true,
    columns,
    predicate: config.where === undefined ? undefined : DIALECT.sqlToQuery(config.where).sql,
  };
}

const INDEXES: readonly ParsedIndex[] = TABLE.indexes.map(parseIndex);
const UNIQUE_INDEXES = INDEXES.filter((index) => index.unique);

// ── Layer 3 subject: the repository source ───────────────────────

const REPOSITORY_PATH = fileURLToPath(new URL('../repositories/calendar.ts', import.meta.url));

/**
 * ⚠ COMMENTS ARE STRIPPED, AND THAT IS LOAD-BEARING HERE SPECIFICALLY. The repository's
 * docblocks deliberately NAME the old single-expert arbiter (`target: [expertProfileId]`)
 * in order to explain that it is gone and why. Without the stripper, Layer 3 would fail
 * on the prose that documents it.
 */
const REPOSITORY_SOURCE = stripComments(readFileSync(REPOSITORY_PATH, 'utf8'));

/**
 * Extract the balanced `{ … }` argument of every `.onConflictDoUpdate(` call.
 * indexOf + brace counting, never a regex — a nested-brace regex is both wrong here
 * (the argument contains object literals) and a ReDoS finding (S5852).
 */
function onConflictArguments(source: string): string[] {
  const marker = '.onConflictDoUpdate(';
  const blocks: string[] = [];
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    const open = source.indexOf('{', cursor + marker.length);
    if (open === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      const char = source.charAt(i);
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    blocks.push(source.slice(open, end + 1));
    cursor = source.indexOf(marker, end);
  }
  return blocks;
}

/** The `target: [ … ]` array of one onConflict argument block, source text as written. */
function targetClause(block: string): string | undefined {
  const at = block.indexOf('target:');
  if (at === -1) return undefined;
  const open = block.indexOf('[', at);
  const close = block.indexOf(']', open);
  if (open === -1 || close === -1) return undefined;
  return block.slice(open, close + 1);
}

/**
 * Whether `clauseText` references `qualifiedColumn` as a whole identifier — i.e. NOT merely
 * as a substring prefix of a longer identifier. Fix brief round 2, item 4: a plain
 * `.includes('calendarConnections.provider')` also matches
 * `calendarConnections.providerEmail` (a real column on this table, `schema/calendar.ts:58`),
 * so an arbiter accidentally targeting `providerEmail` instead of `provider` would pass this
 * check while matching no index and raising 42P10 at plan time. No nested/overlapping
 * quantifiers here (S5852) — a single bounded negated-class lookahead.
 */
function referencesColumn(clauseText: string, qualifiedColumn: string): boolean {
  const escaped = qualifiedColumn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?![A-Za-z0-9_])`);
  return pattern.test(clauseText);
}

const ALL_ONCONFLICT_BLOCKS = onConflictArguments(REPOSITORY_SOURCE);
const CONNECTION_UPSERTS = ALL_ONCONFLICT_BLOCKS.filter((block) =>
  referencesColumn(targetClause(block) ?? '', 'calendarConnections.provider')
);

/**
 * Fix brief round 2, item 5 — independent positive control on `CONNECTION_UPSERTS`, computed
 * a DIFFERENT way than the `target:`-clause filter above: counts `.insert(calendarConnections)`
 * call sites directly. Hoisting the arbiter to a const (or `import { calendarConnections as
 * cc }`, which would also rename this call site) drops `CONNECTION_UPSERTS` to an empty array
 * while both real Layer-3 checks below silently iterate nothing and pass green. This count is
 * asserted to match, so that specific silent-empty failure mode is caught here instead.
 */
const CALENDAR_CONNECTIONS_INSERT_COUNT = (
  REPOSITORY_SOURCE.match(/\.insert\(calendarConnections\)/g) ?? []
).length;

// ── Layer 4 subject: the Drizzle relations source (D1, review WARNING) ────

/**
 * `expertProfilesRelations.calendarConnection` used to be `one(calendarConnections, …)` —
 * arbitrary-of-N under the amendment, and outside every other guard in this file (Layers
 * 1–3 read the table and the REPOSITORY, never `schema/experts.ts`). Renamed to `many()`
 * (D1 fix); this layer catches `one(calendarConnections …)` being silently reintroduced
 * under the CURRENT import name. Fix brief round 2, item 7 — this is dodgeable by an
 * aliased import (`import { calendarConnections as calConns }` then `one(calConns, …)`),
 * so "cannot be reintroduced under any name" (the original claim here) overstated it; this
 * layer is a source-text check, not a semantic one.
 */
const EXPERTS_SCHEMA_PATH = fileURLToPath(new URL('../schema/experts.ts', import.meta.url));
const EXPERTS_SCHEMA_SOURCE = stripComments(readFileSync(EXPERTS_SCHEMA_PATH, 'utf8'));

// ── Layer 1 — DATA: the declared index is the ruling's shape ──────

describe('invariant: calendar connections are unique per (expert, provider) — ADR-1021 §1 (18 Aug 2026)', () => {
  it('parses at least one index off the live table (positive control — guards a vacuous pass)', () => {
    // If a Drizzle bump changes `getTableConfig`'s shape, EVERY assertion below would
    // pass over an empty array. This is the tripwire for that.
    expect(
      INDEXES.length,
      'getTableConfig() returned no indexes for calendar_connections. The parse, not the ' +
        'schema, is broken — every assertion in Layers 1 and 2 is vacuous until it is fixed.'
    ).toBeGreaterThan(0);
    expect(INDEXES.map((index) => index.name)).toContain('cal_conn_expert_provider_idx');
  });

  it('declares EXACTLY ONE unique index, and it is keyed on (expert_profile_id, provider) in that order', () => {
    expect(
      UNIQUE_INDEXES.map((index) => index.name),
      'calendar_connections must carry exactly one unique index — the (expert, provider) ' +
        'cardinality rule. A second one is a second, unruled cardinality claim.'
    ).toEqual(['cal_conn_expert_provider_idx']);

    const [uniqueIndex] = UNIQUE_INDEXES;
    expect(
      uniqueIndex?.columns,
      'The unique key must be (expert_profile_id, provider), IN THAT ORDER. The order is ' +
        'not cosmetic: expert_profile_id leading is what lets this one index also serve ' +
        'the prefix lookups the dropped cal_conn_expert_profile_idx used to serve, which ' +
        'is why BAL-467 adds no separate expert_profile_id index.'
    ).toEqual(['expert_profile_id', 'provider']);
  });

  it('no index — unique or otherwise — is keyed on expert_profile_id ALONE', () => {
    // Asserted as a property over ALL indexes, not by name, so re-adding the dropped
    // `cal_conn_expert_profile_idx` under ANY name fails here.
    const offenders = INDEXES.filter(
      (index) => index.columns.length === 1 && index.columns[0] === 'expert_profile_id'
    );
    expect(
      offenders.map((index) => index.name),
      'An index keyed on expert_profile_id alone is back. If it is UNIQUE it restores the ' +
        'one-connection-per-expert world the ADR-1021 amendment repealed; if it is not, it ' +
        'is redundant with the leading column of cal_conn_expert_provider_idx.'
    ).toEqual([]);
  });

  // ── Layer 2 — RULING: both wrong "fixes" are unrepresentable ────

  it('the unique index is PARTIAL on deleted_at — reconnect after disconnect must not collide', () => {
    const [uniqueIndex] = UNIQUE_INDEXES;
    expect(
      uniqueIndex?.predicate,
      'cal_conn_expert_provider_idx lost its WHERE predicate. It MUST be partial: ' +
        'disconnect soft-deletes the row, so a non-partial unique makes ' +
        'disconnect -> reconnect fail 23505 against a row the application cannot see. ' +
        'The amendment makes per-provider reconnect a first-class user action, so this ' +
        'is a user-facing break, not a theoretical one.'
    ).toBeDefined();
    expect(
      uniqueIndex?.predicate,
      `The predicate must gate on deleted_at. Got: ${uniqueIndex?.predicate}`
    ).toContain('deleted_at');
    expect(uniqueIndex?.predicate).toContain('IS NULL');
  });

  it('deleted_at is NOT one of the unique key columns — the plausible-but-wrong fix', () => {
    const [uniqueIndex] = UNIQUE_INDEXES;
    expect(
      uniqueIndex?.columns,
      'deleted_at has been moved into the KEY COLUMNS of cal_conn_expert_provider_idx. ' +
        'That looks like it solves the same problem and does the OPPOSITE: NULL is not ' +
        'equal to itself in a unique index, so (expert, provider, NULL) never conflicts ' +
        'with (expert, provider, NULL) and UNLIMITED live duplicate connections become ' +
        'legal — exactly the bug the WHERE predicate closes. The predicate belongs in ' +
        'the WHERE, never in the key.'
    ).not.toContain('deleted_at');
  });

  // ── Layer 3 — SOURCE: no arbiter re-introduces single-connection uniqueness ──

  it('finds at least one calendar_connections upsert in the repository (positive control)', () => {
    // Without this, the whole layer passes vacuously the day someone renames the method
    // or moves the upsert to another file.
    expect(
      CONNECTION_UPSERTS.length,
      'No onConflictDoUpdate targeting calendarConnections was found in ' +
        'repositories/calendar.ts. Either the upsert moved (re-point this scan) or the ' +
        'extractor broke — either way Layer 3 is asserting nothing.'
    ).toBeGreaterThan(0);
  });

  it('the target-clause extraction did not silently drop the calendar_connections upsert (item 5 positive control)', () => {
    // Independent count, NOT derived from `targetClause`/`referencesColumn` — hoisting the
    // arbiter to a const, or aliasing the import (`calendarConnections as cc`), would drop
    // `CONNECTION_UPSERTS` to empty while `ALL_ONCONFLICT_BLOCKS` (all onConflictDoUpdate
    // calls in the file, calendarConnections AND availabilityCache) stays non-empty — the
    // "> 0" control above alone would not catch that, since it only checks CONNECTION_UPSERTS
    // itself is non-empty, not that it matches an independently-derived expectation.
    expect(
      CONNECTION_UPSERTS.length,
      `Found ${CALENDAR_CONNECTIONS_INSERT_COUNT} .insert(calendarConnections) call site(s) ` +
        `but only ${CONNECTION_UPSERTS.length} matching ON CONFLICT arbiter(s). The target-` +
        'clause extraction likely silently dropped an upsert (e.g. the arbiter was hoisted ' +
        'to a const, or the import was aliased) — Layer 3 below would iterate fewer blocks ' +
        'than actually exist and pass green on an unguarded upsert.'
    ).toBe(CALENDAR_CONNECTIONS_INSERT_COUNT);
    expect(
      ALL_ONCONFLICT_BLOCKS.length,
      'repositories/calendar.ts has fewer onConflictDoUpdate call sites than expected — the ' +
        'block extractor itself may be broken (re-check against availabilityCache’s two ' +
        'upserts, which are also in this file).'
    ).toBeGreaterThanOrEqual(CONNECTION_UPSERTS.length);
  });

  it('every calendar_connections ON CONFLICT arbiter names provider', () => {
    for (const block of CONNECTION_UPSERTS) {
      expect(
        referencesColumn(targetClause(block) ?? '', 'calendarConnections.provider'),
        'An ON CONFLICT arbiter on calendar_connections does not name ' +
          'calendarConnections.provider (as a whole identifier — providerEmail does not ' +
          'count). Arbiting on expertProfileId alone matches the DROPPED ' +
          'cal_conn_expert_profile_idx and raises 42P10 ("no unique or exclusion ' +
          'constraint matching the ON CONFLICT specification") at PLAN time — on the ' +
          'first statement, on an empty table, with typecheck green.'
      ).toBe(true);
    }
  });

  it('every calendar_connections ON CONFLICT arbiter restates the partial predicate as targetWhere', () => {
    for (const block of CONNECTION_UPSERTS) {
      expect(
        block,
        'An ON CONFLICT arbiter on calendar_connections is missing targetWhere. The ' +
          'arbiter index is PARTIAL; Postgres only selects a partial index as an arbiter ' +
          'when the statement RESTATES its predicate. Without it every upsert raises ' +
          '42P10 — and the mocked unit test cannot see it, because it only records the ' +
          'argument object. Drizzle 0.38 spells it `targetWhere`; the bare `where` key is ' +
          'deprecated on this builder.'
      ).toContain('targetWhere');
      expect(block).toContain('isNull(calendarConnections.deletedAt)');
    }
  });

  // ── Layer 4 — SOURCE: no Drizzle relation reintroduces a singular connection ──

  it('finds schema/experts.ts and the calendarConnections relations block survived stripComments (positive control)', () => {
    // Fix brief round 2, item 7 — `.length > 0` passes on a 1-character string and does not
    // prove the relations block survived `stripComments` (which drops the file remainder on
    // an unterminated `/*`, or the rest of a line on `//` inside a string literal). Assert
    // the actual content the layer below depends on is present.
    expect(EXPERTS_SCHEMA_SOURCE.length).toBeGreaterThan(0);
    expect(EXPERTS_SCHEMA_SOURCE).toContain('many(calendarConnections');
  });

  it('no Drizzle relation in schema/experts.ts declares a singular one(calendarConnections …)', () => {
    expect(
      EXPERTS_SCHEMA_SOURCE.includes('one(calendarConnections'),
      '`schema/experts.ts` declares `one(calendarConnections …)`. Under the ADR-1021 ' +
        'amendment an expert may hold two live connections, so a singular relation names an ' +
        'arbitrary one of them. Use `many(calendarConnections)` instead.'
    ).toBe(false);
  });
});
