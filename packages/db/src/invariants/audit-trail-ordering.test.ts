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
 * `findLatestByEntityAndAction` docblock, and ADR-1030's PENDING BAL-426 amendment — drafted in
 * this PR's body, NOT yet written to the Notion page — all say the same thing): every ordered read of `audit_events` orders by `created_at` THEN `seq`, BOTH COLUMNS
 * IN THE SAME DIRECTION, and NEVER tiebreaks on `id` — a `defaultRandom()` uuid, which is a coin
 * flip for same-transaction rows.
 *
 * WHY THIS IS A TEST AND NOT ONLY A COMMENT. AC #2 is a GLOBAL claim ("no reader tiebreaks on
 * `id`"). Editing the nine sites this ticket touches holds the contract TODAY; nothing holds it
 * TOMORROW — and the EIGHT copies of `asc(auditEvents.id)` this ticket removes accumulated
 * precisely because nothing checked. (The ninth ordered reader,
 * `repositories/audit-events.ts`'s `findLatestByEntityAndAction`, was worse still: it had NO
 * tiebreaker AT ALL, so "the most recent row" was already arbitrary on a tie.) This file is that check, run on every unit pass (no
 * Docker). It mechanically fences THREE independent ways the contract can silently break:
 *
 *   1. a NEW reader tiebreaks on `auditEvents.id` (the original defect, reintroduced);
 *   2. a reader orders by `created_at` (or `seq`) alone, dropping the tiebreak entirely;
 *   3. a reader mixes DIRECTIONS — e.g. `desc(auditEvents.createdAt), asc(auditEvents.seq)`.
 *      This is the R2/O3 TRAP: pasting the documented ascending pair into a `DESC … LIMIT 1`
 *      reader (`findLatestByEntityAndAction`'s shape) silently returns the EARLIEST row of a
 *      same-transaction tie instead of the latest. No amount of prose catches this reliably —
 *      only a structural same-direction check does.
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
 * Extract the balanced-paren argument LIST of every `.orderBy(` call in `source`. indexOf +
 * paren-depth counting, never a regex (S5852) — mirrors `onConflictArguments` in
 * `calendar-connection-cardinality.test.ts`, brace-counting swapped for paren-counting.
 *
 * Not a lexer: a `)` inside a string or template literal inside the argument list would close
 * early. No caller in this codebase puts one there (every `.orderBy(` argument is `asc(...)` /
 * `desc(...)` column references) — the same accepted limitation `stripComments` itself
 * documents.
 */
function orderByArguments(source: string): string[] {
  const marker = '.orderBy(';
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
        'walk. BAL-426 touches at least: the one production reader, the seven ' +
        '`auditEventsForEntity`-shaped test helpers, the request-shared-files helper, and the ' +
        'new audit-events.integration.test.ts trailFor — ten sites. A count this low means the ' +
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
});
