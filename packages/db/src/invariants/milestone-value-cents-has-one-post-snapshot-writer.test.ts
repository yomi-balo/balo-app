import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT (BAL-622) — AFTER THE KICKOFF SNAPSHOT, `engagement_milestones.value_cents` HAS
 * EXACTLY ONE WRITER: AN APPROVED CHANGE ORDER.
 *
 * A milestone's value is part of what the client agreed to pay. It is copied from the accepted
 * proposal at kickoff (`snapshotFromProposalTx`) and may move afterwards only through a change
 * order the client approved (`applyChangeOrderLinesTx`, reached only from
 * `engagementChangeOrdersRepository.approve`). A third writer — a plain milestone edit that
 * grows a `valueCents` key, a new repository helper, a raw `sql` update — would let the money
 * move without the client's approval, and nothing at runtime would notice.
 *
 * ⚠ WHAT THE SCAN SEES. Every non-test `.ts` file under `repositories/` is parsed with the
 * TypeScript compiler (syntax only, no type checker), so comments never count. Four rules:
 *
 *   1. WRITERS. Each `.insert(<table>)` / `.update(<table>)` call, where `<table>` is the
 *      milestone table under any local spelling — the plain import, an `as` alias, a
 *      namespace member (`schema.engagementMilestones`) or a `const` bound to one of those —
 *      is credited to its nearest NAMED enclosing function: a function declaration, a method
 *      (async or not), or an arrow / function expression bound by `const x =` or `x:`.
 *      Anonymous callbacks (`db.transaction(async (tx) => …)`, `.map((m) => …)`) are looked
 *      through. That function is a value writer when its whole body names `valueCents`, so a
 *      payload built in a local (`set.valueCents = …`) counts as well as an inline one. The
 *      value writers must be exactly the snapshot and the approval.
 *   2. RAW SQL. A milestone-table `.valueCents` column reference inside a tagged template
 *      (`sql\`…\``) or an `.execute(…)` argument fails anywhere outside those two functions.
 *   3. RAW NAME. No non-test repository source names the raw column `value_cents` at all
 *      (comments stripped first), which closes `sql.raw` and string-built SQL.
 *   4. ONE ENTRY. `applyChangeOrderLinesTx` is referenced exactly once besides its declaration:
 *      a call inside `approve`. A second caller would be a second route to the write.
 *
 * Each rule has a fixture-backed positive control below.
 *
 * ⚠ COVERAGE BOUNDARY, NAMED. A write payload that reaches the call from ANOTHER function — a
 * parameter typed to allow `valueCents` (`advanceMilestoneStatus`'s `set` is one), or a
 * module-level payload builder — is invisible to a per-function scan; no caller passes
 * `valueCents` through one today. A write through a table passed in as a parameter is
 * likewise invisible.
 *
 * ⚠ SCOPE: `value_cents` ONLY. The plain-edit writers of `estimated_minutes`
 * (`editDescriptive`, `add`, `softDelete`) are deliberately not fenced here: closing them and
 * redirecting them to "Propose a change" is BAL-623's, which widens this invariant.
 */

const REPO_DIR = fileURLToPath(new URL('../repositories/', import.meta.url));

const TABLE = 'engagementMilestones';
const COLUMN = 'valueCents';
const APPLY_FN = 'applyChangeOrderLinesTx';

const EXPECTED_VALUE_WRITERS: readonly string[] = [
  'engagement-change-orders.ts:applyChangeOrderLinesTx',
  'engagement-milestones.ts:snapshotFromProposalTx',
];

const EXPECTED_APPLY_REFERENCES: readonly string[] = ['engagement-change-orders.ts:approve'];

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

/** Every local name bound to the milestone table: the import under any alias, plus `const` copies. */
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

interface NamedFunction {
  name: string;
  node: ts.Node;
}

function enclosingNamedFunction(node: ts.Node): NamedFunction | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    const name = functionName(current);
    if (name !== undefined) return { name, node: current };
    current = current.parent;
  }
  return undefined;
}

function namesColumn(root: ts.Node): boolean {
  return descendants(root).some(
    (n) => (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === COLUMN
  );
}

function isColumnRef(node: ts.Node, aliases: ReadonlySet<string>): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === COLUMN && isTableRef(node.expression, aliases);
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === COLUMN &&
      isTableRef(node.expression, aliases)
    );
  }
  return false;
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

interface MilestoneWrite {
  key: string;
  namesValueCents: boolean;
}

interface ApplyReference {
  key: string;
  isCall: boolean;
}

interface Scan {
  /** Every milestone write, keyed `file:function`, with whether that function names `valueCents`. */
  writes: MilestoneWrite[];
  /** `file:function` of each milestone `.valueCents` reference inside a tagged template or `.execute(`. */
  rawSqlColumnRefs: string[];
  /** Each reference to `applyChangeOrderLinesTx` other than its declaration. */
  applyReferences: ApplyReference[];
}

/** The milestone-table write a call expression makes, or `undefined` when it is not one. */
function milestoneWriteOf(
  node: ts.Node,
  file: string,
  source: ts.SourceFile,
  aliases: ReadonlySet<string>
): MilestoneWrite | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrap(node.expression);
  const [target] = node.arguments;
  const isWriteCall =
    ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === 'insert' || callee.name.text === 'update');
  if (!isWriteCall || target === undefined || !isTableRef(target, aliases)) return undefined;
  const enclosing = enclosingNamedFunction(node);
  return {
    key: `${file}:${enclosing?.name ?? '<module>'}`,
    namesValueCents: namesColumn(enclosing?.node ?? source),
  };
}

/** A reference to the apply function that is not its declaration name, keyed by its enclosing function. */
function applyReferenceOf(
  node: ts.Node,
  keyOf: (node: ts.Node) => string
): ApplyReference | undefined {
  if (!ts.isIdentifier(node) || node.text !== APPLY_FN) return undefined;
  const parent = node.parent;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return undefined;
  return {
    key: keyOf(node),
    isCall: ts.isCallExpression(parent) && parent.expression === node,
  };
}

function scan(file: string, text: string): Scan {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = descendants(source);
  const aliases = tableAliases(nodes);
  const keyOf = (node: ts.Node): string =>
    `${file}:${enclosingNamedFunction(node)?.name ?? '<module>'}`;

  const writes: MilestoneWrite[] = [];
  const rawSqlColumnRefs: string[] = [];
  const applyReferences: ApplyReference[] = [];

  for (const node of nodes) {
    const write = milestoneWriteOf(node, file, source, aliases);
    if (write !== undefined) writes.push(write);

    if (isRawSqlSite(node) && descendants(node).some((n) => isColumnRef(n, aliases))) {
      rawSqlColumnRefs.push(keyOf(node));
    }

    const reference = applyReferenceOf(node, keyOf);
    if (reference !== undefined) applyReferences.push(reference);
  }

  return { writes, rawSqlColumnRefs, applyReferences };
}

const SOURCES = listSourceFiles(REPO_DIR).map((abs) => {
  const file = abs.slice(REPO_DIR.length);
  const text = readFileSync(abs, 'utf8');
  return { file, stripped: stripComments(text), scan: scan(file, text) };
});

function valueWriters(writes: readonly MilestoneWrite[]): string[] {
  return [...new Set(writes.filter((w) => w.namesValueCents).map((w) => w.key))].sort();
}

describe('INVARIANT: engagement_milestones.value_cents has one post-snapshot writer (BAL-622)', () => {
  const writes = SOURCES.flatMap((s) => s.scan.writes);

  it('⚠ POSITIVE CONTROL — the scan finds milestone writes that do not name valueCents', () => {
    const reorder = writes.filter((w) => w.key === 'engagement-milestones.ts:reorder');
    expect(reorder.length).toBeGreaterThan(0);
    expect(reorder.every((w) => !w.namesValueCents)).toBe(true);
  });

  it('⚠ POSITIVE CONTROL — writers are credited under every function-header shape', () => {
    const fixture = [
      `async function ${APPLY_FN}(tx) {`,
      '  await tx.update(engagementMilestones).set({ valueCents: 1 });',
      '}',
      'const arrowWriter = async (tx) => {',
      '  await tx.update(engagementMilestones).set({ valueCents: 2 });',
      '};',
      'export const repo = {',
      '  propertyWriter: async (tx) => tx.insert(engagementMilestones).values({ valueCents: 3 }),',
      '  async methodWriter(tx) {',
      '    await tx.update(engagementMilestones).set({ valueCents: 4 });',
      '  },',
      '  syncWriter(input) {',
      '    return db.transaction(async (tx) => {',
      '      const set = {};',
      '      set.valueCents = input.value;',
      '      await tx.update(engagementMilestones).set(set);',
      '    });',
      '  },',
      '};',
    ].join('\n');
    expect(valueWriters(scan('fixture.ts', fixture).writes)).toEqual([
      `fixture.ts:${APPLY_FN}`,
      'fixture.ts:arrowWriter',
      'fixture.ts:methodWriter',
      'fixture.ts:propertyWriter',
      'fixture.ts:syncWriter',
    ]);
  });

  it('⚠ POSITIVE CONTROL — the table is recognised under an alias, a namespace and a const copy', () => {
    const fixture = [
      "import { engagementMilestones as em } from '../schema';",
      "import * as schema from '../schema';",
      'const copy = schema.engagementMilestones;',
      'async function viaAlias(tx) { await tx.update(em).set({ valueCents: 1 }); }',
      'async function viaNamespace(tx) {',
      '  await tx.update(schema.engagementMilestones).set({ valueCents: 1 });',
      '}',
      'async function viaCopy(tx) { await tx.insert(copy).values({ valueCents: 1 }); }',
    ].join('\n');
    expect(valueWriters(scan('fixture.ts', fixture).writes)).toEqual([
      'fixture.ts:viaAlias',
      'fixture.ts:viaCopy',
      'fixture.ts:viaNamespace',
    ]);
  });

  it('⚠ POSITIVE CONTROL — a milestone valueCents column inside sql or execute is detected', () => {
    const fixture = [
      "import { engagementMilestones as em } from '../schema';",
      'async function viaExecute(tx) {',
      '  await tx.execute(sql`update engagement_milestones set ${engagementMilestones.valueCents} = 0`);',
      '}',
      'async function viaAliasedTemplate() {',
      '  return sql`${em.valueCents} + 1`;',
      '}',
      'async function otherTable() {',
      '  return sql`${engagementChangeOrderLines.valueCents} + 1`;',
      '}',
    ].join('\n');
    expect(scan('fixture.ts', fixture).rawSqlColumnRefs).toEqual([
      'fixture.ts:viaExecute',
      'fixture.ts:viaExecute',
      'fixture.ts:viaAliasedTemplate',
    ]);
  });

  it(`⚠ POSITIVE CONTROL — every reference to ${APPLY_FN} is found and attributed`, () => {
    const fixture = [
      `async function ${APPLY_FN}(tx) {}`,
      'export const repo = {',
      `  async approve(input) { await ${APPLY_FN}(tx, input); },`,
      `  async decline(input) { await ${APPLY_FN}(tx, input); },`,
      '};',
      `const handle = ${APPLY_FN};`,
    ].join('\n');
    expect(scan('fixture.ts', fixture).applyReferences).toEqual([
      { key: 'fixture.ts:approve', isCall: true },
      { key: 'fixture.ts:decline', isCall: true },
      { key: 'fixture.ts:<module>', isCall: false },
    ]);
  });

  it('the functions that write valueCents to a milestone are exactly the snapshot and the approval', () => {
    expect(valueWriters(writes)).toEqual(EXPECTED_VALUE_WRITERS);
  });

  it('no sql template or execute call names the milestone valueCents column outside those two', () => {
    const offenders = SOURCES.flatMap((s) => s.scan.rawSqlColumnRefs).filter(
      (key) => !EXPECTED_VALUE_WRITERS.includes(key)
    );
    expect(offenders).toEqual([]);
  });

  it('no repository source names the raw value_cents column', () => {
    const offenders = SOURCES.filter((s) => s.stripped.includes('value_cents')).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it(`${APPLY_FN} has exactly one reference, a call inside approve`, () => {
    const references = SOURCES.flatMap((s) => s.scan.applyReferences);
    expect(references.every((r) => r.isCall)).toBe(true);
    expect(references.map((r) => r.key)).toEqual(EXPECTED_APPLY_REFERENCES);
  });
});
