import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `reminderWaitsRepository` is the web app's read-only window onto `scheduled_notifications`
 * (BAL-666; every write stays API-only, ADR-1047 Decision 11). This pins that it never grows a
 * write: no Drizzle insert/update/delete, no upsert clause, no raw SQL write verb.
 */
const REPOSITORY_FILE = join(__dirname, '..', 'repositories', 'reminder-waits.ts');

const WRITE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: '.insert(', pattern: /\.insert\s*\(/ },
  { name: '.update(', pattern: /\.update\s*\(/ },
  { name: '.delete(', pattern: /\.delete\s*\(/ },
  { name: 'onConflict', pattern: /onConflict/i },
  { name: 'sql.raw(', pattern: /\bsql\s*\.\s*raw\s*\(/ },
  {
    name: 'raw SQL write verb',
    pattern: /\b(INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO)\b/i,
  },
];

/** Source with line and block comments blanked, so prose about writes does not trip the scan. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The names of every write pattern found in `source`. */
function findWrites(source: string): string[] {
  const code = stripComments(source);
  return WRITE_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name);
}

/** Every module the repository may import. A new import fails until it is reviewed and added. */
const ALLOWED_IMPORTS: readonly string[] = [
  '../client',
  '../schema',
  '@balo/shared/lookup',
  '@balo/shared/notifications',
  'drizzle-orm',
  'drizzle-orm/pg-core',
];

/** Module specifiers of every static import or re-export in `source`, sorted and de-duplicated. */
function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found = [...code.matchAll(/\bfrom\s+'([^']+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  return [...new Set(found)].sort();
}

/** Imports that reach a sibling repository, where a borrowed write would come from. */
function siblingRepositoryImports(source: string): string[] {
  return importSpecifiers(source).filter(
    (spec) => spec.startsWith('./') || spec.startsWith('../repositories/')
  );
}

describe('reminderWaitsRepository reads only', () => {
  it('imports exactly the allowed modules', () => {
    expect(importSpecifiers(readFileSync(REPOSITORY_FILE, 'utf8'))).toEqual([...ALLOWED_IMPORTS]);
  });

  it('imports no sibling repository', () => {
    expect(siblingRepositoryImports(readFileSync(REPOSITORY_FILE, 'utf8'))).toEqual([]);
  });

  it.each([
    [
      'a sibling by ./',
      "import { x } from './scheduled-notifications';",
      ['./scheduled-notifications'],
    ],
    [
      'a sibling by ../repositories/',
      "import { x } from '../repositories/notification-log';",
      ['../repositories/notification-log'],
    ],
    ['a re-export of a sibling', "export { x } from './companies';", ['./companies']],
    ['allowed modules', "import { db } from '../client';\nimport { t } from '../schema';", []],
  ])('flags %s (positive control)', (_label, source, expected) => {
    expect(siblingRepositoryImports(source)).toEqual(expected);
  });

  it('lists a new import so it fails the exact-set pin (positive control)', () => {
    expect(importSpecifiers("import a from 'x';\nimport b from '../client';")).toEqual([
      '../client',
      'x',
    ]);
  });

  it('contains no write', () => {
    expect(findWrites(readFileSync(REPOSITORY_FILE, 'utf8'))).toEqual([]);
  });

  it.each([
    ['a Drizzle insert', 'await db.insert(table).values(x);', ['.insert(']],
    ['a Drizzle update', 'await db\n  .update(table).set(x);', ['.update(']],
    ['a Drizzle delete', 'await db.delete(table);', ['.delete(']],
    ['an upsert clause', 'q.onConflictDoNothing()', ['onConflict']],
    ['a raw insert', 'sql`insert into t values (1)`', ['raw SQL write verb']],
    ['a raw update', 'sql`update t set a = 1`', ['raw SQL write verb']],
    ['a raw delete', 'sql`DELETE FROM t`', ['raw SQL write verb']],
    ['a raw truncate', 'sql`truncate t`', ['raw SQL write verb']],
    ['sql.raw', 'sql.raw(`insert`)', ['sql.raw(']],
    ['a raw merge', 'sql`merge into t using u`', ['raw SQL write verb']],
  ])('catches %s (positive control)', (_label, source, expected) => {
    expect(findWrites(source)).toEqual(expected);
  });

  it('ignores write words in comments and selects', () => {
    expect(
      findWrites('// .insert( is never called\n/* DELETE FROM t */\nawait db.select().from(t);')
    ).toEqual([]);
  });
});
