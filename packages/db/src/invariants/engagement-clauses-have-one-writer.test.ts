import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT — `engagement_clauses` HAS EXACTLY ONE WRITER: THE KICKOFF SNAPSHOT.
 *
 * The rows are the assumptions, exclusions and additional terms the client agreed to in the
 * accepted proposal. `snapshotClausesFromProposalTx` copies them at kickoff, inside
 * `materializeFromKickoff`, which records the ADR-1030 audit `engagement.clauses_snapshotted`.
 * After that they are read-only: a change order never edits them (ADR-1057), and the delivery
 * card reads them as "what was agreed at the start". A second writer (an edit helper, a delete,
 * a raw `sql` update) would let the agreed record change after the fact with no audit, and
 * nothing at runtime would notice.
 *
 * ⚠ WHAT THE SCAN SEES. Every non-test `.ts` file under `repositories/` is parsed with the
 * TypeScript compiler (syntax only), so comments never count. Three rules:
 *
 *   1. WRITERS. Each `.insert(<table>)`, `.update(<table>)` or `.delete(<table>)` call, where
 *      `<table>` is `engagementClauses` under any local spelling (the plain import, an `as`
 *      alias, a namespace member, or a `const` bound to one of those), is credited to its
 *      nearest NAMED enclosing function: a function declaration, a method, or an arrow /
 *      function expression bound by `const x =` or `x:`. Anonymous callbacks are looked
 *      through. The writers must be exactly the snapshot.
 *   2. RAW SQL. A reference to the table inside a tagged template (`sql\`…\``) or an
 *      `.execute(…)` argument fails anywhere outside the snapshot.
 *   3. RAW NAME. No non-test repository source names `engagement_clauses` at all (comments
 *      stripped first), which closes `sql.raw` and string-built SQL.
 *
 * Each rule has a fixture-backed positive control below.
 *
 * ⚠ COVERAGE BOUNDARY, NAMED. A write through a table passed in as a parameter is invisible to
 * this scan. The migration 0128 backfill, re-run verbatim by 0129, writes the table too, for
 * engagements kicked off before it existed; both sit in `drizzle/`, outside `repositories/`, by
 * construction, and run once with no actor.
 */

const REPO_DIR = fileURLToPath(new URL('../repositories/', import.meta.url));

const TABLE = 'engagementClauses';
const RAW_NAME = 'engagement_clauses';
const WRITE_METHODS: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);

const EXPECTED_WRITERS: readonly string[] = ['engagement-clauses.ts:snapshotClausesFromProposalTx'];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(abs);
    return entry.isFile() && abs.endsWith('.ts') && !abs.endsWith('.test.ts') ? [abs] : [];
  });
}

function descendants(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isTableRef(expr: ts.Expression, aliases: ReadonlySet<string>): boolean {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return aliases.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return node.name.text === TABLE;
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === TABLE
    );
  }
  return false;
}

/** Every local name bound to the table: the import under any alias, plus `const` copies. */
function tableAliases(nodes: readonly ts.Node[]): Set<string> {
  const aliases = new Set<string>([TABLE]);
  for (const node of nodes) {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === TABLE) {
      aliases.add(node.name.text);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !aliases.has(node.name.text) &&
        node.initializer !== undefined &&
        isTableRef(node.initializer, aliases)
      ) {
        aliases.add(node.name.text);
        grew = true;
      }
    }
  }
  return aliases;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : undefined;
}

function bindingParent(node: ts.Node): ts.Node {
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    parent = parent.parent;
  }
  return parent;
}

/** The name a function-like node is declared or bound under, or `undefined` when anonymous. */
function functionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name === undefined ? undefined : propertyNameText(node.name);
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isFunctionExpression(node) && node.name !== undefined) return node.name.text;
    const parent = bindingParent(node);
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return propertyNameText(parent.name);
    }
  }
  return undefined;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    const name = functionName(current);
    if (name !== undefined) return name;
    current = current.parent;
  }
  return '<module>';
}

function isWriteCall(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  const [target] = node.arguments;
  return (
    ts.isPropertyAccessExpression(callee) &&
    WRITE_METHODS.has(callee.name.text) &&
    target !== undefined &&
    isTableRef(target, aliases)
  );
}

function isRawSqlSite(node: ts.Node): boolean {
  if (ts.isTaggedTemplateExpression(node)) return true;
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return (
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'execute') ||
    (ts.isIdentifier(callee) && callee.text === 'execute')
  );
}

/** A reference to the table itself or to one of its columns (`engagementClauses.body`). */
function referencesTable(root: ts.Node, aliases: ReadonlySet<string>): boolean {
  return descendants(root).some(
    (n) =>
      (ts.isIdentifier(n) && aliases.has(n.text)) ||
      (ts.isPropertyAccessExpression(n) && n.name.text === TABLE)
  );
}

interface Scan {
  /** `file:function` of every write call on the table. */
  writers: string[];
  /** `file:function` of every tagged template or `.execute(` that references the table. */
  rawSqlRefs: string[];
}

function scan(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = descendants(source);
  const aliases = tableAliases(nodes);
  const writers: string[] = [];
  const rawSqlRefs: string[] = [];
  for (const node of nodes) {
    if (isWriteCall(node, aliases)) writers.push(`${file}:${enclosingFunctionName(node)}`);
    if (isRawSqlSite(node) && referencesTable(node, aliases)) {
      rawSqlRefs.push(`${file}:${enclosingFunctionName(node)}`);
    }
  }
  return { writers, rawSqlRefs };
}

const SOURCES = listSourceFiles(REPO_DIR).map((abs) => {
  const file = abs.slice(REPO_DIR.length);
  const text = readFileSync(abs, 'utf8');
  return { file, stripped: stripComments(text), scan: scan(file, text) };
});

function distinctSorted(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

describe('INVARIANT: engagement_clauses has one writer, the kickoff snapshot', () => {
  it('⚠ POSITIVE CONTROL — the scan reads the repository sources', () => {
    expect(SOURCES.some((s) => s.file === 'engagement-clauses.ts')).toBe(true);
    expect(SOURCES.some((s) => s.file === 'project-engagements.ts')).toBe(true);
  });

  it('⚠ POSITIVE CONTROL — writes are credited under every function-header shape and write verb', () => {
    const fixture = [
      'async function declared(tx) {',
      '  await tx.insert(engagementClauses).values({ body: "x" });',
      '}',
      'const arrowWriter = async (tx) => {',
      '  await tx.update(engagementClauses).set({ body: "y" });',
      '};',
      'export const repo = {',
      '  propertyWriter: async (tx) => tx.delete(engagementClauses),',
      '  async methodWriter(input) {',
      '    return db.transaction(async (tx) => {',
      '      await tx.update(engagementClauses).set({ deletedAt: new Date() });',
      '    });',
      '  },',
      '};',
      'async function reader(tx) { return tx.select().from(engagementClauses); }',
    ].join('\n');
    expect(distinctSorted(scan('fixture.ts', fixture).writers)).toEqual([
      'fixture.ts:arrowWriter',
      'fixture.ts:declared',
      'fixture.ts:methodWriter',
      'fixture.ts:propertyWriter',
    ]);
  });

  it('⚠ POSITIVE CONTROL — the table is recognised under an alias, a namespace and a const copy', () => {
    const fixture = [
      "import { engagementClauses as ec } from '../schema';",
      "import * as schema from '../schema';",
      'const copy = schema.engagementClauses;',
      'async function viaAlias(tx) { await tx.update(ec).set({ body: "a" }); }',
      'async function viaNamespace(tx) { await tx.delete(schema.engagementClauses); }',
      'async function viaCopy(tx) { await tx.insert(copy).values({ body: "c" }); }',
      'async function otherTable(tx) { await tx.update(engagementMilestones).set({}); }',
    ].join('\n');
    expect(distinctSorted(scan('fixture.ts', fixture).writers)).toEqual([
      'fixture.ts:viaAlias',
      'fixture.ts:viaCopy',
      'fixture.ts:viaNamespace',
    ]);
  });

  it('⚠ POSITIVE CONTROL — a table reference inside sql or execute is detected', () => {
    const fixture = [
      "import { engagementClauses as ec } from '../schema';",
      'async function viaExecute(tx) {',
      '  await tx.execute(sql`delete from ${engagementClauses}`);',
      '}',
      "function viaColumn() { return sql`${ec.body} || '!'`; }",
      'function otherTable() { return sql`${engagementMilestones.title}`; }',
    ].join('\n');
    expect(distinctSorted(scan('fixture.ts', fixture).rawSqlRefs)).toEqual([
      'fixture.ts:viaColumn',
      'fixture.ts:viaExecute',
    ]);
  });

  it('⚠ POSITIVE CONTROL — the raw table name is seen in code and ignored in comments', () => {
    const inCode = "await tx.execute(sql.raw('update engagement_clauses set body = 1'));";
    const inComment = '// engagement_clauses is read-only\n/** engagement_clauses */\nconst x = 1;';
    expect(stripComments(inCode).includes(RAW_NAME)).toBe(true);
    expect(stripComments(inComment).includes(RAW_NAME)).toBe(false);
  });

  it('the functions that write engagement_clauses are exactly the snapshot', () => {
    const writers = SOURCES.flatMap((s) => s.scan.writers);
    expect(distinctSorted(writers)).toEqual(EXPECTED_WRITERS);
  });

  it('no sql template or execute call references the table outside the snapshot', () => {
    const offenders = SOURCES.flatMap((s) => s.scan.rawSqlRefs).filter(
      (key) => !EXPECTED_WRITERS.includes(key)
    );
    expect(offenders).toEqual([]);
  });

  it('no repository source names the raw engagement_clauses table', () => {
    const offenders = SOURCES.filter((s) => s.stripped.includes(RAW_NAME)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
