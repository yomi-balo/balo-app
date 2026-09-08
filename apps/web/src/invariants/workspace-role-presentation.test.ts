// @vitest-environment node
import path from 'node:path';
import ts from 'typescript';
import { describe, it, expect, beforeAll } from 'vitest';
import { resolveRouteDir, scanRouteSources } from './_source-scan';
import type { CompanyWorkspace, MembershipCompanyWorkspace } from '@balo/shared/workspaces';

/**
 * BAL-507 / ADR-1029 — THE FIRST COMPILER-API INVARIANT IN THIS REPO.
 *
 * ADR-1029 (CLAUDE.md "Auth Model") is capability-based: authorization is always resolved via
 * `hasCapability(actor, capability, subject)` at the call site — never by reading a role, lens,
 * or view off a data object. `CompanyWorkspace.role` (`MembershipCompanyWorkspace.role`) is
 * PRESENTATION ONLY — it exists so a switcher row can display "Client · Owner" — and must never
 * become an authorization gate (`workspace.role === 'owner'` deciding what someone MAY DO).
 * This suite is the CI-enforced half of that rule; the type-level half (a representation
 * workspace cannot carry a role at all) is pinned below in the AC-1 describe block.
 *
 * ⚠⚠ WHY A TEXT SCAN IS IMPOSSIBLE HERE (unlike every other invariant in this directory). The
 * sole production reader (`workspaceSubtitle`, `apps/web/src/components/layout/
 * workspace-presentation.ts`) DESTRUCTURES: `const { role } = workspace;`. A grep for the CODE
 * form `.role` / `workspace.role` finds ZERO production hits as actual property access —
 * including the one legitimate, allowlisted read — so a naive text scan would pass vacuously and
 * its "guards the guard" test would be unwritable. (The literal substring `workspace.role` DOES
 * now appear once in production source, but only inside this file's own explanatory comment at
 * `workspace-presentation.ts` line ~60 — never as code. That is exactly the false-positive a
 * textual scan cannot distinguish from a real read, and the type-checker approach sidesteps it
 * entirely by only ever looking at AST node kinds, never raw text.) Conversely, a bare `role`
 * grep collides with `MembershipCompanyInput.role`,
 * `membership.role`, `companyRole` / `platformRole` / `recipientRole`, work-history `entry.role`,
 * and `roleHasCapability(role, …)` all over `lib/authz`. Catching BOTH the property-access form
 * and the destructuring form, while resolving the RECEIVER's type, requires a real type checker
 * — hence this suite uses the raw TypeScript compiler API (never ts-morph — R-B ruling) rather
 * than the regex-free line-oriented scans `_source-scan.ts` otherwise provides.
 *
 * This suite does NOT "lift an exclusion" from `nav-registry-capability-gated.test.ts` — that
 * scan has no exclusion mechanism at all (its docblock note is a directive to future authors,
 * not implemented code); this is a wholly separate, new mechanism.
 *
 * ⚠⚠ KNOWN BLIND SPOTS — do not assume coverage this suite does not have. The receiver-type
 * resolution in `workspaceTypeNameOf` only recognizes the WORKSPACE_TYPE_NAMES symbols
 * themselves; it does NOT see through a value that has been laundered into an anonymous or
 * mapped type before the `.role` read:
 *   - `const copy = { ...w }; copy.role;`            — spread copy → anonymous object type
 *   - `const { ...copy } = w; copy.role;`            — full-rest destructure → anonymous type
 *   - `(w: Readonly<MembershipCompanyWorkspace>) => w.role`  — mapped-type wrapper
 * All three require the AUTHOR to deliberately re-type or re-wrap the value first — this is
 * laundering, not accidental drift, and the suite still catches every direct read (property
 * access, element access, destructuring, including renamed and parameter forms) off the real
 * Workspace-family types, which is what every accidental `.role` gate in this codebase's history
 * has looked like. Closing these blind spots (e.g. by walking through spreads/mapped types to
 * their operand's type) is future hardening, not required for this suite to be worth having.
 *
 * ⚠ RUNTIME BUDGET (measured, not estimated): architect's plan measured ~10.5s CPU / ~6.4s wall
 * unloaded on a 10-core dev machine; ~15-30s wall expected on a 2-vCPU CI runner. Independently
 * re-measured during the BAL-507 build via `process.cpuUsage()` (wall-clock is meaningless on
 * this machine — load average was ~145 on 10 cores at measurement time): **~11.95s total CPU**
 * (program construction ~5.6s, checker + AST walk the remainder) — consistent with the
 * architect's figure and well inside the 60s stop-and-flag threshold.
 *
 * ⚠ THE FIGURE ABOVE WAS MEASURED WITHOUT COVERAGE. CI runs `pnpm test:coverage` → `vitest run
 * --coverage`, a different, heavier mode. A reviewer measured **≈20s CPU under `--coverage`, the
 * mode CI actually uses (~1.1 GB peak RSS), vs ~12.5s CPU / ~1.00 GB without** — the coverage
 * instrumentation costs roughly +60%. Still far under the 60s stop-and-flag threshold, but the
 * uninstrumented figure alone understates the CI path; both numbers are recorded here rather
 * than only the faster one.
 *
 * A lexical prefilter was measured and rejected — it saves nothing because the `.d.ts`
 * transitive closure dominates program construction, not the root file count. If a CI run ever
 * exceeds 60s CPU, STOP AND FLAG rather than softening this suite (narrowing coverage, `.skip`,
 * raising the timeout) — see `.implement/rulings-bal-507.md` Q2.
 */

const WEB_SRC = resolveRouteDir(['src', 'apps/web/src']);
const SHARED_SRC = resolveRouteDir(['packages/shared/src', '../../packages/shared/src']);
const WEB_ROOT = WEB_SRC === '' ? '' : path.dirname(WEB_SRC); // …/apps/web
const TSCONFIG = path.join(WEB_ROOT, 'tsconfig.json');

interface ScanTarget {
  readonly absolute: string;
  readonly rel: string;
}

function targetsUnder(
  dir: string,
  relPrefix: string,
  excludedDirs: readonly string[]
): ScanTarget[] {
  return scanRouteSources(dir, '', excludedDirs)
    .filter((f) => !f.rel.includes('.spec.') && !f.rel.includes('fixtures/'))
    .map((f) => ({ absolute: path.join(dir, f.rel), rel: `${relPrefix}/${f.rel}` }));
}

const TARGETS: readonly ScanTarget[] = [
  ...targetsUnder(WEB_SRC, 'apps/web/src', ['test']), // 'test' kills src/test/**
  ...targetsUnder(SHARED_SRC, 'packages/shared/src', ['testing']),
];

// ── The self-proving in-memory probe ────────────────────────────────────────────────────────
//
// A virtual root that exists ONLY in memory, overlaid onto the program via a CompilerHost. It
// exercises both forms the real scan must catch, proving on EVERY run — not via a one-time
// manual mutation — that the matcher has teeth. `MembershipCompanyWorkspace` is used as the
// probe's parameter type (rather than `CompanyWorkspace`) so the probe body itself is
// type-error-free: `.role` does not exist on the representation arm, and diagnostics are never
// read by this scan, so an error INSIDE the probe risks degrading the receiver's resolved type.

const PROBE_REL = 'apps/web/src/__workspace_role_probe__.ts';
const PROBE_ABS = path.join(WEB_SRC, '__workspace_role_probe__.ts');
const PROBE_SOURCE = `
import type { MembershipCompanyWorkspace } from '@balo/shared/workspaces';
export function probeAccess(workspace: MembershipCompanyWorkspace): unknown {
  return workspace.role;                       // property-access form
}
export function probeDestructure(workspace: MembershipCompanyWorkspace): unknown {
  const { role } = workspace;                  // destructuring form — what the real reader uses
  return role;
}
`;

// ── Program construction ────────────────────────────────────────────────────────────────────

function buildProgram(): ts.Program {
  const configFile = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, WEB_ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };

  const host = ts.createCompilerHost(options, /* setParentNodes */ true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  host.fileExists = (f) => path.normalize(f) === PROBE_ABS || origFileExists(f);
  host.readFile = (f) => (path.normalize(f) === PROBE_ABS ? PROBE_SOURCE : origReadFile(f));
  host.getSourceFile = (f, lv, oe, sh) =>
    path.normalize(f) === PROBE_ABS
      ? ts.createSourceFile(f, PROBE_SOURCE, lv, true)
      : origGetSourceFile(f, lv, oe, sh);

  return ts.createProgram({
    rootNames: [...TARGETS.map((t) => t.absolute), PROBE_ABS],
    options,
    host,
  });
}

// ── The AST walk ────────────────────────────────────────────────────────────────────────────

type HitKind = 'access' | 'element' | 'destructure';

function receiverFor(node: ts.Node): { readonly receiver: ts.Node; readonly kind: HitKind } | null {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'role') {
    return { receiver: node.expression, kind: 'access' }; // w.role, w?.role
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'role'
  ) {
    return { receiver: node.expression, kind: 'element' }; // w['role']
  }
  if (ts.isBindingElement(node)) {
    const named = node.propertyName ?? node.name; // handles `{ role: myRole }`
    if (ts.isIdentifier(named) && named.text === 'role') {
      return { receiver: node.parent, kind: 'destructure' }; // the ObjectBindingPattern
    }
  }
  return null;
}

const WORKSPACE_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Workspace',
  'CompanyWorkspace',
  'MembershipCompanyWorkspace',
  'RepresentationCompanyWorkspace',
  'ExpertWorkspace',
]);

const SHARED_INDEX_REL = 'packages/shared/src/workspaces/index.ts';

/**
 * F-4 (BAL-507 fix round) — WORKSPACE_TYPE_NAMES above is a hand-maintained mirror of "the
 * Workspace-family arm names", and `workspaceTypeNameOf`'s union/intersection `collect()` walk
 * means a receiver typed as the UNION (`Workspace` / `CompanyWorkspace`) is always reported
 * under its resolved CONSTITUENT arm name instead — so those two entries can never themselves be
 * the match. Harmless today, but it means a future third arm (e.g. a hypothetical
 * `AgencyWorkspace`) added to `packages/shared/src/workspaces/index.ts` without a matching
 * entry here would be silently MISSED by the whole scan — the one fail-OPEN direction that can
 * happen by accident rather than by deliberate laundering. This walks the shared module's own
 * AST (already in the program) for every EXPORTED interface whose name ends in `Workspace`, so
 * `WORKSPACE_TYPE_NAMES` can be checked against ground truth rather than trusted by hand.
 */
function exportedWorkspaceInterfaceNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement)) continue;
    const isExported = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0;
    if (!isExported) continue;
    if (statement.name.text.endsWith('Workspace')) names.push(statement.name.text);
  }
  return names;
}

/**
 * Match by type NAME with a declaration-file confirmation — never bare symbol identity. pnpm
 * symlinks `node_modules/@balo/shared` → `packages/shared`; if TypeScript ever resolved the
 * module through the symlinked path, a symbol-identity check against a symbol fetched from the
 * REAL path would silently match nothing — a vacuous pass, the worst failure mode for an
 * invariant. Name matching cannot produce a false negative; the declaration-file check removes
 * the false-alarm risk. Per `.implement/rulings-bal-507.md` Q4: if the declaration-file check
 * ever fails on a path-form mismatch, relax it to `.includes('workspaces/index.ts')` — never
 * delete it.
 */
function workspaceTypeNameOf(type: ts.Type): string | null {
  const seen: ts.Symbol[] = [];
  const collect = (t: ts.Type): void => {
    if (t.isUnion() || t.isIntersection()) {
      t.types.forEach(collect);
      return;
    }
    const symbol = t.aliasSymbol ?? t.getSymbol();
    if (symbol !== undefined) seen.push(symbol);
  };
  collect(type);
  for (const symbol of seen) {
    if (!WORKSPACE_TYPE_NAMES.has(symbol.getName())) continue;
    const declaredIn = symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
    // Confirm it is OUR type, not a same-named type from somewhere else.
    if (declaredIn.includes('/shared/src/workspaces/')) return symbol.getName();
  }
  return null;
}

interface Hit {
  readonly file: string;
  readonly kind: HitKind;
  readonly typeName: string;
  readonly line: number;
}

function walkSourceFile(
  sourceFile: ts.SourceFile,
  rel: string,
  checker: ts.TypeChecker,
  hits: Hit[]
): void {
  const visit = (node: ts.Node): void => {
    const found = receiverFor(node);
    if (found !== null) {
      const type = checker.getTypeAtLocation(found.receiver);
      const typeName = workspaceTypeNameOf(type);
      if (typeName !== null) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        hits.push({ file: rel, kind: found.kind, typeName, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

// ── Allowlist and failure message ───────────────────────────────────────────────────────────

/**
 * ADR-1029 — files permitted to read `role` off a Workspace-typed value.
 * Adding an entry is a DELIBERATE act in its own PR: it asserts the new read is PRESENTATION,
 * never a gate. It is not a way to make this suite green.
 *
 * ⚠ Adding to this list is NOT enough — the reality pin below ("reality pin: exactly one real
 * hit today…") asserts the EXACT set of real hits, so a new legitimate read turns THAT test red
 * regardless of this allowlist. A new read must be added THERE too. Two edits, both reviewed —
 * deliberately.
 */
const ALLOWLIST: readonly string[] = [
  'packages/shared/src/workspaces/index.ts', // the derive/build site
  'apps/web/src/components/layout/workspace-presentation.ts', // the sole presentation consumer
];

const FAILURE = [
  'ADR-1029 — `Workspace.role` / `CompanyWorkspace.role` is PRESENTATION ONLY and is NEVER an',
  'authorization input. Authorization resolves a CAPABILITY at the call site:',
  '  hasCapability(actor, capability, { companyId })   — @balo/shared/authz',
  'Gating on `role ===` makes the presentation layer and `hasCapability` disagree, which is',
  'exactly the drift ADR-1029 exists to prevent.',
  'If this read is genuinely presentation (a subtitle, a badge, a label), add the file to',
  'ALLOWLIST in this suite in its OWN PR, with the justification in the PR body.',
  'Offending reads:',
].join('\n');

function formatHit(hit: Hit): string {
  return `${hit.file}:${hit.line} (${hit.kind} on ${hit.typeName})`;
}

// ── Build once, share across every `it` ─────────────────────────────────────────────────────

let program: ts.Program;
let allHits: Hit[] = [];
let realFileRelPaths: ReadonlySet<string>;

beforeAll(() => {
  program = buildProgram();
  const checker = program.getTypeChecker();
  const relByAbsolute = new Map<string, string>([
    ...TARGETS.map((t): [string, string] => [t.absolute, t.rel]),
    [PROBE_ABS, PROBE_REL],
  ]);
  realFileRelPaths = new Set(TARGETS.map((t) => t.rel));

  const hits: Hit[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    const rel = relByAbsolute.get(path.normalize(sourceFile.fileName));
    if (rel === undefined) continue; // skip the ~3400 .d.ts files pulled into the closure
    walkSourceFile(sourceFile, rel, checker, hits);
  }
  allHits = hits;
}, 180_000);

function violationsAmong(hits: readonly Hit[]): Hit[] {
  return hits.filter((h) => !ALLOWLIST.includes(h.file));
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────

describe('workspace .role reads — allowlisted presentation only (ADR-1029 / BAL-507)', () => {
  it('guards the guard: both trees resolve', () => {
    expect(WEB_SRC).not.toBe('');
    expect(SHARED_SRC).not.toBe('');
  });

  it('guards the guard: the scan really scanned', () => {
    expect(TARGETS.length).toBeGreaterThan(500);
    expect(program.getSourceFiles().length).toBeGreaterThan(1000);
  });

  it('guards the guard: the matcher catches PROPERTY ACCESS', () => {
    expect(allHits).toContainEqual(expect.objectContaining({ file: PROBE_REL, kind: 'access' }));
  });

  it('guards the guard: the matcher catches DESTRUCTURING', () => {
    expect(allHits).toContainEqual(
      expect.objectContaining({ file: PROBE_REL, kind: 'destructure' })
    );
  });

  it('guards the guard: a non-allowlisted file IS reported as a violation', () => {
    const probeViolations = violationsAmong(allHits).filter((h) => h.file === PROBE_REL);
    expect(probeViolations.length).toBeGreaterThan(0);
  });

  it('THE INVARIANT — no non-allowlisted production file reads .role off a Workspace', () => {
    const realHits = allHits.filter((h) => realFileRelPaths.has(h.file));
    const violations = violationsAmong(realHits);
    expect(violations, `${FAILURE}\n${violations.map(formatHit).join('\n')}`).toEqual([]);
  });

  it('reality pin: exactly one real hit today, in the allowlisted presentation consumer', () => {
    const realHits = allHits.filter((h) => realFileRelPaths.has(h.file));
    const deduped = Array.from(
      new Map(realHits.map((h) => [`${h.file}:${h.kind}`, { file: h.file, kind: h.kind }])).values()
    );
    expect(deduped).toEqual([
      { file: 'apps/web/src/components/layout/workspace-presentation.ts', kind: 'destructure' },
    ]);
  });

  it('decoy pin: derive-workspaces.ts reads MembershipCompanyInput.role, not a Workspace — the scan is TYPED, not textual', () => {
    const realHits = allHits.filter((h) => realFileRelPaths.has(h.file));
    expect(realHits.some((h) => h.file.endsWith('lib/workspaces/derive-workspaces.ts'))).toBe(
      false
    );
  });

  it('WORKSPACE_TYPE_NAMES is not a stale hand-maintained mirror — every exported *Workspace interface in the shared module is present (F-4)', () => {
    const sharedIndexTarget = TARGETS.find((t) => t.rel === SHARED_INDEX_REL);
    expect(sharedIndexTarget).not.toBeUndefined();
    if (sharedIndexTarget === undefined) return; // narrows for TS; unreachable after the assertion above

    const sourceFile = program.getSourceFile(sharedIndexTarget.absolute);
    expect(sourceFile).not.toBeUndefined();
    if (sourceFile === undefined) return;

    const declaredNames = exportedWorkspaceInterfaceNames(sourceFile);
    // guards the guard: the walk itself must find something, or this test would pass vacuously.
    expect(declaredNames.length).toBeGreaterThan(0);
    for (const name of declaredNames) {
      expect(WORKSPACE_TYPE_NAMES.has(name), `WORKSPACE_TYPE_NAMES is missing '${name}'`).toBe(
        true
      );
    }
  });
});

// ── AC-1 (R-C) — the union makes the illegal state unrepresentable ────────────────────────────

describe('AC-1 (ADR-1029 / BAL-507) — the union makes the illegal state unrepresentable', () => {
  it('a representation workspace cannot carry a role — compile-time pin', () => {
    // ⚠ THIS PIN LIVES IN `apps/web` ON PURPOSE. `pnpm typecheck` runs
    // `turbo run typecheck check-types`, and `@balo/shared` has NO `scripts` block at all —
    // `@balo/shared#typecheck` and `#check-types` are both <NONEXISTENT>, so NOTHING in CI
    // compiles `packages/shared/src/**/*.test.ts`. `web#check-types` (`next typegen && tsc
    // --noEmit`) DOES compile this file. Same reasoning, same reason, as the conditional-type
    // pin at `apps/web/src/lib/auth/session-cookie-size.test.ts:117-128`.
    // Deleting the directive below must make `pnpm --filter web check-types` fail — empirically
    // TS2353 ("Object literal may only specify known properties … 'role' does not exist in type
    // 'RepresentationCompanyWorkspace'"), the excess-property check on the discriminated union's
    // matched arm, not TS2322 as first assumed; mutation-verified (BAL-507 build). If it ever
    // stops failing, TS2578 ("unused '@ts-expect-error' directive") fires instead.
    const illegal: CompanyWorkspace = {
      type: 'company',
      key: 'company:11111111-1111-4111-8111-111111111111',
      companyId: '11111111-1111-4111-8111-111111111111',
      name: 'Northwind Industrial',
      isPersonal: false,
      via: 'representation',
      // @ts-expect-error ADR-1029 / BAL-507 — RepresentationCompanyWorkspace has no `role` member.
      role: 'owner',
    };
    expect(illegal.via).toBe('representation');
  });

  it('a membership workspace REQUIRES a role — compile-time pin', () => {
    // The other half of the biconditional. A conditional type rather than @ts-expect-error,
    // because "property is required" is not an excess-property error.
    type RoleIsRequired = undefined extends MembershipCompanyWorkspace['role'] ? never : true;
    const pin: RoleIsRequired = true;
    expect(pin).toBe(true);
  });
});
