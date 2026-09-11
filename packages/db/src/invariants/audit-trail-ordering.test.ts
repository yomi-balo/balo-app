import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT — THE BAL-426 AUDIT TRAIL ORDERING CONTRACT, MECHANICALLY FENCED.
 *
 * `audit_events.created_at` is `defaultNow()` = `transaction_timestamp()`, so every row one
 * `db.transaction` writes carries an IDENTICAL instant — and ADR-1030 makes several audit rows
 * per transaction the DESIGNED shape, not an edge case. `audit_events.seq`
 * (`schema/audit-events.ts`) is the monotonic bigint IDENTITY that makes those rows orderable.
 *
 * THE CONTRACT (`schema/audit-events.ts`'s `seq` docblock, `repositories/audit-events.ts`'s
 * `findLatestByEntityAndAction` docblock, and ADR-1030's BAL-426 amendment (“Amendment —
 * 2026-09-08 (trail ordering, BAL-426 / PR #294)”) — all say the same thing): every ordered
 * read of `audit_events` orders by `created_at` THEN `seq`, BOTH COLUMNS IN THE SAME DIRECTION,
 * and NEVER tiebreaks on `id` — a `defaultRandom()` uuid, which is a coin flip for
 * same-transaction rows.
 *
 * WHY THIS IS A TEST AND NOT ONLY A COMMENT. AC #2 is a GLOBAL claim ("no reader tiebreaks on
 * `id`"). Editing the nine sites this ticket touches holds the contract TODAY; nothing holds it
 * TOMORROW — and the EIGHT copies of `asc(auditEvents.id)` this ticket removes accumulated
 * precisely because nothing checked. (The ninth ordered reader,
 * `repositories/audit-events.ts`'s `findLatestByEntityAndAction`, was worse still: it had NO
 * tiebreaker AT ALL, so "the most recent row" was already arbitrary on a tie.) This file is that check, run on every unit pass (no
 * Docker). It mechanically fences FOUR independent ways the contract can silently break
 * (docblock addition, BAL-555 fix round F7 — this line read "THREE" before residual 3 below was
 * added as a fourth, separate assertion and the summary was never updated to match):
 *
 *   1. a NEW reader tiebreaks on `auditEvents.id` (the original defect, reintroduced);
 *   2. a reader orders by `created_at` (or `seq`) alone, dropping the tiebreak entirely;
 *   3. a reader mixes DIRECTIONS — e.g. `desc(auditEvents.createdAt), asc(auditEvents.seq)`.
 *      This is the R2/O3 TRAP: pasting the documented ascending pair into a `DESC … LIMIT 1`
 *      reader (`findLatestByEntityAndAction`'s shape) silently returns the EARLIEST row of a
 *      same-transaction tie instead of the latest. No amount of prose catches this reliably —
 *      only a structural same-direction check does.
 *   4. a reader compares `auditEvents.seq` with a Drizzle SCALAR comparison helper (`lt`/`lte`/
 *      `gt`/`gte`/`eq`/`ne`) in a WHERE clause instead of `auditTrailKeysetBefore`'s raw `sql`
 *      ROW-VALUE tuple — BAL-426 residual 3 (BAL-555), assertion (c) below. `seq` has exactly
 *      one purpose (breaking a same-transaction tie), so any scalar comparison on it can only be
 *      a WRONG keyset predicate; `and(lt(createdAt, x), lt(seq, y))` silently drops rows that
 *      are older but carry a higher `seq`.
 *
 * ⚠⚠ ACCEPTED LIMITATIONS — four still-open blind spots in this mechanism, not closed by
 * BAL-555 or any turn since; documented rather than fixed because closing them needs a real
 * lexer/AST pass over the source for a marginal remaining defect surface. Three of these mirror
 * ADR-1030's 2026-09-08 amendment (they are generic hazards of every indexOf + paren-depth
 * `_source-scan`-style invariant in this package, not specific to this file); the fourth is
 * fresh to this file and is NOT in the ADR:
 *
 *   (a) AN ALIASED IMPORT evades every check here. `import { auditEvents as ae }` then writing
 *       `ae.seq` / `ae.createdAt` never contains the literal substring `auditEvents.`, so neither
 *       the `.orderBy(` extractor nor the WHERE-comparison extractor (assertion (c)) ever sees
 *       the site — "cannot be reintroduced under any name" would overstate what a source-text
 *       check proves.
 *   (b) A SPREAD ORDER LIST evades the `.orderBy(` extractor. `.orderBy(...SOME_ORDER_CONST)`,
 *       where `SOME_ORDER_CONST` is `[desc(auditEvents.createdAt), desc(auditEvents.seq)]`
 *       defined elsewhere, never puts the literal column reference inside the `.orderBy(...)`
 *       argument list this file extracts — the extractor sees only `...SOME_ORDER_CONST`, which
 *       does not contain the substring `auditEvents.` and is silently dropped by the
 *       `AUDIT_ORDERBY_SITES` filter.
 *   (c) THE RELATIONAL `orderBy:` KEY evades the `.orderBy(` extractor entirely. Drizzle's
 *       relational query builder (`db.query.auditEvents.findMany({ orderBy: (fields, { asc }) =>
 *       [...] })`) orders via an object KEY, not a chained `.orderBy(...)` call — the literal
 *       marker this file searches for never appears, so a relational read of `audit_events`
 *       (were one ever added) is invisible to every assertion in this file.
 *   (d) THE `.orderBy(` EXTRACTOR STRUCTURALLY NEVER INSPECTS `WHERE` — NOT in the ADR amendment,
 *       written fresh here. Assertions (AC #2 and the direction check) walk only the argument
 *       list of `.orderBy(...)` calls, so a WRONG keyset predicate hidden inside a `.where(...)`
 *       clause was invisible to BOTH of them from the day this file shipped (BAL-426) — that gap
 *       is exactly why residual 3 / assertion (c) had to be a SEPARATE extractor (generalising
 *       `balancedArguments` to `COMPARISON_MARKERS`) rather than a tweak to the existing one.
 *       Assertion (c) closes this SPECIFICALLY for `auditEvents.seq` scalar comparisons — the one
 *       shape a keyset cursor on this table could wrongly take — but it does not generalise to
 *       every possible WHERE-clause defect, and limitations (a)-(c) above apply to it exactly as
 *       they apply to the `.orderBy(` extractor.
 *
 * ⚠ THIS FILE IS NAMED BY PATH FROM `schema/audit-events.ts`'s `seq` docblock. If it moves,
 * update that docblock's path too — it forward-references this exact file.
 *
 * MECHANICS, following `repositories-never-notify.test.ts` / `an-account-hold-outlives-only-an-
 * unpaid-balance.test.ts` verbatim: `readFileSync` + `fileURLToPath(new URL(…, import.meta.url))`
 * (cwd-INDEPENDENT — CI runs web vitest from the repo root, so a `process.cwd()`-relative path
 * is a known footgun here), `stripComments` from `@balo/shared/testing` (a docblock explaining
 * the contract by NAMING `asc(auditEvents.id)` must not trip the very ban it explains), and an
 * indexOf + paren-depth extractor — never a BACKTRACKING regex over arbitrary source (SonarCloud
 * S5852 / ReDoS; a nested-quantifier scan is exactly the shape that rule bans). `normalize()`
 * does apply `/\s+/g` to the extracted argument, which is linear and S5852-safe.
 *
 * WALK: `packages/db/src`, `apps/api/src`, `apps/web/src` — every `.ts`/`.tsx` file, skipping
 * `node_modules`, `dist`, `.next`, and any `coverage*` directory. For speed, a file is scanned
 * further only if its RAW (pre-strip) source contains the substring `auditEvents` — a cheap
 * pre-filter (79 files today out of 3 064 walked) that only ever WIDENS the candidate set
 * (comments and string literals can still trip it; `stripComments` narrows correctly afterward).
 * This invariant file itself is excluded from the walk — it names the forbidden token in prose
 * and in this docblock, which would otherwise trip its own ban.
 *
 * VACUITY GUARDS (a broken walker must FAIL, never pass silently — house rule: a source-scan
 * test that matches nothing and passes is not evidence): the walk must visit more than 500
 * files total, find at least 20 files whose raw source mentions `auditEvents`, resolve at least
 * one audit `.orderBy(` site from `repositories/audit-events.ts` (the one production reader),
 * and extract at least 5 audit `.orderBy(` sites overall.
 *
 * ⚠⚠ BAL-426 RESIDUAL 3 (BAL-555) — A FOURTH ASSERTION, ON `WHERE`, NOT `orderBy(`. §(c) below:
 * no source file passes `auditEvents.seq` to a Drizzle SCALAR comparison helper (`lt`, `lte`,
 * `gt`, `gte`, `eq`, `ne`). `seq` has exactly one purpose — breaking a same-transaction tie —
 * so a comparison on it can only be a keyset cursor, and a keyset cursor on this table must be
 * a raw `sql` ROW-VALUE tuple (`auditTrailKeysetBefore`, `repositories/audit-events.ts`). The
 * `and`-joined pair silently drops rows; the expanded `or`/`and` form is equivalent but easy to
 * mis-nest. This is precisely the shape the `.orderBy(` scan could never see — it never
 * inspects `WHERE` at all, which is why this fourth assertion is written FRESH here rather than
 * lifted from ADR-1030's amendment (which only documents the first three).
 *
 * Deliberately NARROW: a comparison on `auditEvents.createdAt` stays LEGAL, because
 * `countByActorAndActionSince` uses `gte(auditEvents.createdAt, input.since)` as a legitimate
 * WINDOW filter, not a cursor — and that site is this fourth assertion's own positive control
 * (a broken extractor that resolves nothing must fail, not pass silently).
 */

// ── Walk ───────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const WALK_ROOT_NAMES: readonly string[] = ['packages/db/src', 'apps/api/src', 'apps/web/src'];

const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', '.next']);

function isSkippedDir(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name) || name.startsWith('coverage');
}

/** This invariant's own absolute path — excluded from the walk (see docblock). */
const SELF_PATH = fileURLToPath(import.meta.url);

/** Every `.ts`/`.tsx` file under `dir`, recursively, excluding this file. */
function listSourceFilesRecursive(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A configured root that does not exist (e.g. a deliberately-broken path in the mutation
    // proof) yields nothing here — the emptiness is what the vacuity guards below must catch.
    return [];
  }
  return entries.flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return isSkippedDir(entry.name) ? [] : listSourceFilesRecursive(abs);
    }
    if (!entry.isFile()) return [];
    if (!(abs.endsWith('.ts') || abs.endsWith('.tsx'))) return [];
    if (abs === SELF_PATH) return [];
    return [abs];
  });
}

/** Display path relative to the repo root, POSIX-separated for readable failure messages. */
function displayPath(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

const ALL_SOURCE_FILES: string[] = WALK_ROOT_NAMES.flatMap((root) =>
  listSourceFilesRecursive(path.join(REPO_ROOT, root))
);

interface ScannedFile {
  readonly displayPath: string;
  /** Comments stripped — see the docblock on why the raw pre-filter is a superset. */
  readonly source: string;
}

/**
 * Files whose RAW source mentions `auditEvents` — the cheap pre-filter. Reading every file's
 * raw content is unavoidable to decide membership, but stripping comments (the expensive half)
 * only happens for files that pass this filter.
 */
const AUDIT_MENTIONING_FILES: ScannedFile[] = ALL_SOURCE_FILES.filter((abs) =>
  readFileSync(abs, 'utf8').includes('auditEvents')
).map((abs) => ({
  displayPath: displayPath(abs),
  source: stripComments(readFileSync(abs, 'utf8')),
}));

// ── Extraction ─────────────────────────────────────────────────────────

/**
 * Extract the balanced-paren argument LIST of every `marker`-prefixed call in `source`.
 * indexOf + paren-depth counting, never a regex (S5852) — mirrors `onConflictArguments` in
 * `calendar-connection-cardinality.test.ts`, brace-counting swapped for paren-counting.
 *
 * Not a lexer: a `)` inside a string or template literal inside the argument list would close
 * early. No caller in this codebase puts one there (every argument here is an `asc(...)` /
 * `desc(...)` / `lt(...)` / etc. column reference) — the same accepted limitation
 * `stripComments` itself documents.
 *
 * ⚠ BAL-555 (BAL-426 residual 3) — GENERALISED from the original `orderBy(`-only extractor so
 * assertion (c) below can reuse it for `lt(`/`lte(`/`gt(`/`gte(`/`eq(`/`ne(` too, on the SAME
 * indexOf + paren-depth algorithm. `orderByArguments` keeps its name and signature as a thin
 * wrapper so nothing else in this file (or a future consumer) needs to change.
 */
function balancedArguments(source: string, marker: string): string[] {
  const results: string[] = [];
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    const argStart = cursor + marker.length;
    let depth = 1;
    let end = -1;
    for (let i = argStart; i < source.length; i += 1) {
      const char = source.charAt(i);
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // unterminated — fail closed, extract nothing further from here
    results.push(source.slice(argStart, end));
    cursor = source.indexOf(marker, end);
  }
  return results;
}

/** Thin wrapper — kept so `.orderBy(`'s own extraction reads the same as it always has. */
function orderByArguments(source: string): string[] {
  return balancedArguments(source, '.orderBy(');
}

/**
 * BAL-555 (BAL-426 residual 3) — every Drizzle SCALAR comparison helper that could (wrongly)
 * be applied to `auditEvents.seq` as a keyset predicate. Deliberately EXCLUDES `lt`/`gt`
 * called on `createdAt` used as a window filter — the filter below narrows to sites that
 * actually MENTION `auditEvents.seq`, not to the marker set itself.
 */
const COMPARISON_MARKERS: readonly string[] = ['lt(', 'lte(', 'gt(', 'gte(', 'eq(', 'ne('];

/** Whitespace-normalised — survives a Prettier rewrap of a multi-line `.orderBy(...)`. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ');
}

interface AuditOrderBySite {
  readonly file: string;
  readonly argText: string;
}

/**
 * Every extracted `.orderBy(...)` argument list, from every audit-mentioning file, that itself
 * mentions `auditEvents.` — i.e. an ORDERED read of `audit_events`. A file can mention
 * `auditEvents` (import, unrelated `.orderBy` on another table) without every `.orderBy(` site
 * in it being an audit read; this filters down to the ones that are.
 */
const AUDIT_ORDERBY_SITES: AuditOrderBySite[] = AUDIT_MENTIONING_FILES.flatMap((file) =>
  orderByArguments(file.source)
    .map(normalize)
    .filter((argText) => argText.includes('auditEvents.'))
    .map((argText) => ({ file: file.displayPath, argText }))
);

interface AuditComparisonSite {
  readonly file: string;
  readonly marker: string;
  readonly argText: string;
}

/**
 * BAL-555 (BAL-426 residual 3) — every `COMPARISON_MARKERS` call site, from every
 * audit-mentioning file, whose argument list mentions ANY `auditEvents.` column. Unfiltered
 * by column so the extractor's own positive control (a legitimate `auditEvents.createdAt`
 * window filter) is drawn from the SAME set assertion (c) filters down from — a broken
 * extractor that resolves nothing would otherwise make BOTH the guard and (c) pass silently
 * together.
 */
const AUDIT_COMPARISON_SITES: AuditComparisonSite[] = AUDIT_MENTIONING_FILES.flatMap((file) =>
  COMPARISON_MARKERS.flatMap((marker) =>
    balancedArguments(file.source, marker)
      .map(normalize)
      .filter((argText) => argText.includes('auditEvents.'))
      .map((argText) => ({ file: file.displayPath, marker, argText }))
  )
);

/**
 * The WHERE fence itself — every comparison site whose argument list mentions
 * `auditEvents.seq` specifically. `seq` has exactly one purpose (breaking a
 * same-transaction tie), so any scalar comparison on it can only be a (WRONG) keyset
 * predicate — a keyset cursor on this table must be `auditTrailKeysetBefore`'s raw `sql`
 * ROW-VALUE tuple instead. `auditEvents.createdAt` comparisons are NOT in this set —
 * `countByActorAndActionSince`'s `gte(auditEvents.createdAt, …)` window filter stays legal.
 */
const AUDIT_SEQ_COMPARISON_SITES: AuditComparisonSite[] = AUDIT_COMPARISON_SITES.filter((site) =>
  site.argText.includes('auditEvents.seq')
);

describe('INVARIANT: the audit trail ordering contract (BAL-426) — created_at then seq, same direction, never id', () => {
  // ── Vacuity guards ─────────────────────────────────────────────────

  it('walks more than 500 source files (guards a broken/empty walk root)', () => {
    expect(
      ALL_SOURCE_FILES.length,
      `Walked only ${ALL_SOURCE_FILES.length} files across ${WALK_ROOT_NAMES.join(', ')}. ` +
        'A directory that does not resolve (a bad relative path off import.meta.url, or a ' +
        'renamed root) makes every assertion below vacuously pass. Fix the walk before trusting ' +
        'this suite.'
    ).toBeGreaterThan(500);
  });

  it('finds at least 20 files whose raw source mentions auditEvents (guards a broken pre-filter)', () => {
    expect(
      AUDIT_MENTIONING_FILES.length,
      `Only ${AUDIT_MENTIONING_FILES.length} files mention "auditEvents". Expected at least 20 ` +
        '(repositories, integration tests, and services that read/write the audit trail). If ' +
        "this dropped to near-zero, the pre-filter or the walk roots are broken — this suite's " +
        'real assertions below would then be scanning almost nothing.'
    ).toBeGreaterThanOrEqual(20);
  });

  it('resolves at least one audit .orderBy( site from repositories/audit-events.ts (positive control)', () => {
    const fromAuditRepo = AUDIT_ORDERBY_SITES.filter((site) =>
      site.file.endsWith('repositories/audit-events.ts')
    );
    expect(
      fromAuditRepo.length,
      'No audit .orderBy( site was found in repositories/audit-events.ts — the ONE production ' +
        'reader (findLatestByEntityAndAction). If that function moved, was renamed, or the ' +
        'extractor broke, every assertion below is scanning the wrong (or an empty) set.'
    ).toBeGreaterThan(0);
  });

  it('extracts at least 5 audit .orderBy( sites overall (guards a vacuous pass)', () => {
    expect(
      AUDIT_ORDERBY_SITES.length,
      `Only extracted ${AUDIT_ORDERBY_SITES.length} audit .orderBy( site(s) across the whole ` +
        'walk. BAL-426/BAL-555 touch at least: the two production readers ' +
        "(findLatestByEntityAndAction and BAL-555's listTrailForEntity), the seven " +
        '`auditEventsForEntity`-shaped test helpers, the request-shared-files helper, and the ' +
        'audit-events.integration.test.ts trailFor — eleven sites. A count this low means the ' +
        'extraction is broken and the two rule assertions below are not exercising the codebase.'
    ).toBeGreaterThanOrEqual(5);
  });

  // ── The contract itself ────────────────────────────────────────────

  it('AC #2 — no audit .orderBy( argument list tiebreaks on auditEvents.id', () => {
    const offenders = AUDIT_ORDERBY_SITES.filter((site) => site.argText.includes('auditEvents.id'));
    expect(
      offenders.map((site) => `${site.file}: .orderBy(${site.argText})`),
      'A reader orders audit_events with a tiebreak on `id` — a defaultRandom() uuid. Ties on ' +
        '`created_at` (every row of one db.transaction) then resolve in random order per run. ' +
        'Use `seq` (a monotonic bigint IDENTITY) instead — see the BAL-426 trail contract in ' +
        'schema/audit-events.ts.'
    ).toEqual([]);
  });

  it('AC #2 + the R2/O3 trap — every audit .orderBy( names BOTH createdAt and seq, in the SAME direction', () => {
    const offenders = AUDIT_ORDERBY_SITES.filter((site) => {
      const { argText } = site;
      const hasAscCreatedAt = argText.includes('asc(auditEvents.createdAt)');
      const hasDescCreatedAt = argText.includes('desc(auditEvents.createdAt)');
      const hasAscSeq = argText.includes('asc(auditEvents.seq)');
      const hasDescSeq = argText.includes('desc(auditEvents.seq)');
      // Compliant iff createdAt appears in exactly one direction, paired with seq in THAT SAME
      // direction. Anything else — missing seq, missing createdAt, or a direction mismatch —
      // is an offender.
      const ascending = hasAscCreatedAt && hasAscSeq && !hasDescCreatedAt && !hasDescSeq;
      const descending = hasDescCreatedAt && hasDescSeq && !hasAscCreatedAt && !hasAscSeq;
      return !(ascending || descending);
    });
    expect(
      offenders.map((site) => `${site.file}: .orderBy(${site.argText})`),
      'An audit .orderBy( does not pair createdAt and seq in the SAME direction. The BAL-426 ' +
        'contract is `created_at` then `seq`, BOTH ascending or BOTH descending — never mixed, ' +
        'and never one without the other. A mismatched pair (e.g. `desc(createdAt), ' +
        'asc(seq)`) pasted into a `DESC … LIMIT 1` reader silently returns the EARLIEST row of ' +
        'a same-transaction tie instead of the latest.'
    ).toEqual([]);
  });

  // ── BAL-555 (BAL-426 residual 3) — the WHERE fence ──────────────────

  it('resolves at least one audit comparison site mentioning auditEvents.createdAt (positive control)', () => {
    const positiveControl = AUDIT_COMPARISON_SITES.filter(
      (site) =>
        site.file.endsWith('repositories/audit-events.ts') &&
        site.argText.includes('auditEvents.createdAt')
    );
    expect(
      positiveControl.length,
      'No comparison site mentioning auditEvents.createdAt was found in ' +
        "repositories/audit-events.ts — countByActorAndActionSince's `gte(auditEvents.createdAt, " +
        'input.since)` window filter. If that call moved, was renamed, or the comparison ' +
        'extractor broke, assertion (c) below is scanning the wrong (or an empty) set and would ' +
        'pass vacuously.'
    ).toBeGreaterThan(0);
  });

  it('AC #2 residual 3 — no source file compares auditEvents.seq with a Drizzle scalar helper', () => {
    expect(
      AUDIT_SEQ_COMPARISON_SITES.map((site) => `${site.file}: ${site.marker}${site.argText})`),
      'A reader passes `auditEvents.seq` to a scalar comparison helper (lt/lte/gt/gte/eq/ne). ' +
        '`seq` has exactly one purpose — breaking a same-transaction tie — so a comparison on ' +
        'it can only be a keyset cursor, and a keyset cursor on this table MUST be a raw `sql` ' +
        'ROW-VALUE tuple (`auditTrailKeysetBefore`, repositories/audit-events.ts). ' +
        '`and(lt(createdAt, x), lt(seq, y))` silently drops rows that are older but carry a ' +
        'higher seq; the expanded `or(lt(createdAt,x), and(eq(createdAt,x), lt(seq,y)))` form ' +
        'is equivalent but easy to mis-nest. Use `auditTrailKeysetBefore` instead.'
    ).toEqual([]);
  });
});
