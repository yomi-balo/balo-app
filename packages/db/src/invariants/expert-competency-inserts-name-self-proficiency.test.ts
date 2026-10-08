import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { listSourceFiles, stripComments, toDisplayPath } from '@balo/shared/testing';

/**
 * Every `expert_competency` INSERT must name `selfProficiency`, even when it
 * writes NULL. The column is nullable so a plain insert that omits it compiles and runs fine —
 * it just silently drops self-ratings on a path nobody meant to be applicant-blind. Making the
 * omission a type error is not possible (the column is genuinely optional at the schema level:
 * a staff-added product inserts `selfProficiency: null` on purpose), so this is a SOURCE-SCAN
 * invariant instead, same shape as `no-full-row-product-read-outside-reference-data.test.ts`.
 *
 * WALK: every non-`*.test.ts` `.ts`/`.tsx` file under `packages/db/src` and `apps/api/src`
 * (`@balo/shared/testing`'s shared walker — see that module's docblock for why one walker,
 * not a fourth copy).
 *
 * MATCH: `.insert(expertCompetency)` or `.insert(schema.expertCompetency)`, identifier-boundary
 * checked (so `xinsert(` or `reinsert(` can never match) via an indexOf scan — never a
 * backtracking regex (S5852).
 *
 * FOR EACH MATCH, the full chained statement — from the match through the following
 * `.values(...)` / `.onConflictDoUpdate(...)` / `.onConflictDoNothing()` chain, to the next
 * top-level `;` — is extracted by bracket-depth counting (never a regex). The site passes when
 * EITHER:
 *   (a) `selfProficiency` appears in that statement directly (an inline object literal, or a
 *       `.map(...)` / `.flatMap(...)` building one); or
 *   (b) `.values(` takes a bare identifier (a ROW-BUILDER built earlier in the same file, e.g.
 *       `seed-service.ts`'s `competencyRows`), and that identifier's OWN `const`/`let`
 *       declaration (to its next top-level `;`) mentions `selfProficiency`.
 * Anything else is an offender: an insert this invariant could not prove sets the column.
 *
 * If this test fails: add `selfProficiency` to the insert (or to the row-builder it reads from).
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const WALK_INPUT = {
  repoRoot: REPO_ROOT,
  rootNames: ['packages/db/src', 'apps/api/src'],
  selfPath: SELF_PATH,
};

const MARKERS: readonly string[] = ['insert(expertCompetency)', 'insert(schema.expertCompetency)'];

function isIdentifierChar(char: string): boolean {
  return (
    char !== '' &&
    (char === '_' ||
      char === '$' ||
      char.toLowerCase() !== char.toUpperCase() ||
      (char >= '0' && char <= '9'))
  );
}

/** Every start index of `needle` in `source`, excluding a match that is the tail of a longer
 *  identifier (so `xinsert(expertCompetency)` never matches `insert(expertCompetency)`). */
function findMarkerStarts(source: string, needle: string): number[] {
  const starts: number[] = [];
  let i = source.indexOf(needle);
  while (i !== -1) {
    if (!isIdentifierChar(source.charAt(i - 1))) starts.push(i);
    i = source.indexOf(needle, i + 1);
  }
  return starts;
}

/** The full chained statement starting at `start`: bracket-depth counted from `start` to the
 *  next top-level (depth-0) `;`, or to EOF if the statement is never terminated. */
function extractStatement(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ';' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/** The bare identifier passed to `.values(` in `statement`, or `null` when the argument is
 *  anything else (an inline literal, a `.map(...)` call, a member expression, …). */
function valuesBareIdentifier(statement: string): string | null {
  const marker = '.values(';
  const markerIndex = statement.indexOf(marker);
  if (markerIndex === -1) return null;
  const rest = statement.slice(markerIndex + marker.length);
  let i = 0;
  while (i < rest.length && /\s/.test(rest.charAt(i))) i += 1;
  const identStart = i;
  while (i < rest.length && isIdentifierChar(rest.charAt(i))) i += 1;
  if (i === identStart) return null;
  const identifier = rest.slice(identStart, i);
  let j = i;
  while (j < rest.length && /\s/.test(rest.charAt(j))) j += 1;
  return rest.charAt(j) === ')' ? identifier : null;
}

/** The initializer of `identifier`'s `const`/`let` declaration in `source` (from its `=` to the
 *  next top-level `;`), or `null` when no such declaration is found. */
function declarationInitializer(source: string, identifier: string): string | null {
  for (const keyword of ['const ', 'let ']) {
    const declMarker = `${keyword}${identifier}`;
    let i = source.indexOf(declMarker);
    while (i !== -1) {
      if (i === 0 || !isIdentifierChar(source.charAt(i - 1))) {
        const afterIdent = i + declMarker.length;
        if (!isIdentifierChar(source.charAt(afterIdent))) {
          const eq = source.indexOf('=', afterIdent);
          if (eq !== -1) return extractStatement(source, eq);
        }
      }
      i = source.indexOf(declMarker, i + 1);
    }
  }
  return null;
}

interface InsertSite {
  readonly displayPath: string;
  readonly statement: string;
  readonly namesSelfProficiency: boolean;
}

function scanFile(displayPath: string, rawSource: string): InsertSite[] {
  const source = stripComments(rawSource);
  const sites: InsertSite[] = [];
  for (const marker of MARKERS) {
    for (const start of findMarkerStarts(source, marker)) {
      const statement = extractStatement(source, start);
      let namesSelfProficiency = statement.includes('selfProficiency');
      if (!namesSelfProficiency) {
        const identifier = valuesBareIdentifier(statement);
        if (identifier !== null) {
          const initializer = declarationInitializer(source, identifier);
          namesSelfProficiency = initializer !== null && initializer.includes('selfProficiency');
        }
      }
      sites.push({ displayPath, statement, namesSelfProficiency });
    }
  }
  return sites;
}

const SOURCE_FILES = listSourceFiles(WALK_INPUT);
const ALL_SITES: InsertSite[] = SOURCE_FILES.flatMap((abs) =>
  scanFile(toDisplayPath(REPO_ROOT, abs), readFileSync(abs, 'utf8'))
);

describe('invariant: every expert_competency insert names selfProficiency (BAL-593)', () => {
  it('walks a non-empty source tree and finds at least 5 insert sites (guards a vacuous scan)', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(50);
    expect(
      ALL_SITES.length,
      `Found only ${ALL_SITES.length} expert_competency insert sites — expected at least 5. ` +
        'If this dropped, the marker or walk is broken, and the scan below is vacuous.'
    ).toBeGreaterThanOrEqual(5);
  });

  it('the detector recognises an inline insert that omits selfProficiency (mutation self-test)', () => {
    const bad = scanFile(
      'fixture.ts',
      `await db.insert(expertCompetency).values({ expertProfileId, productId, supportTypeId, proficiency: 3 });`
    );
    expect(bad).toHaveLength(1);
    expect(bad[0]?.namesSelfProficiency).toBe(false);
  });

  it('the detector recognises an inline insert that DOES name selfProficiency', () => {
    const good = scanFile(
      'fixture.ts',
      `await db.insert(expertCompetency).values({ expertProfileId, productId, supportTypeId, proficiency: 3, selfProficiency: null });`
    );
    expect(good).toHaveLength(1);
    expect(good[0]?.namesSelfProficiency).toBe(true);
  });

  it('the detector resolves a row-builder declared earlier in the same file', () => {
    const resolved = scanFile(
      'fixture.ts',
      `const rows = items.map((c) => ({ productId: c.id, selfProficiency: c.proficiency }));
       await tx.insert(expertCompetency).values(rows);`
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.namesSelfProficiency).toBe(true);
  });

  it('the detector flags a row-builder that never mentions selfProficiency (mutation self-test)', () => {
    const unresolved = scanFile(
      'fixture.ts',
      `const rows = items.map((c) => ({ productId: c.id, proficiency: c.proficiency }));
       await tx.insert(expertCompetency).values(rows);`
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.namesSelfProficiency).toBe(false);
  });

  it.each(ALL_SITES.map((site) => [site.displayPath, site] as const))(
    '%s names selfProficiency on its expert_competency insert',
    (_displayPath, site) => {
      expect(
        site.namesSelfProficiency,
        `${site.displayPath} inserts expert_competency without naming selfProficiency ` +
          `(statement: ${site.statement.slice(0, 200)}…)`
      ).toBe(true);
    }
  );
});
