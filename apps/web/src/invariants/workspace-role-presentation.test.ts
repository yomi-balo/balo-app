// @vitest-environment node
import { existsSync, readdirSync } from 'node:fs';
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
 * ⚠⚠ WHAT "A WORKSPACE" MEANS HERE, EXACTLY. The set of types this suite watches is DERIVED, not
 * hand-written: it is **the set of types reachable from the exported `Workspace` union in
 * `packages/shared/src/workspaces/index.ts`, resolved through the TypeChecker** (see
 * `deriveWatchedTypes`). Adding an arm to that union — exported or not — makes it watched
 * automatically, with NO edit to this file. That is a mechanism change made in BAL-507 after two
 * adversarial rounds defeated the previous hand-maintained name list; the reasoning, and the
 * decisive counter-example, are recorded in full at `deriveWatchedTypes`. The derivation
 * FAILS CLOSED: if `Workspace` cannot be resolved, is not a union, or yields a set missing a
 * known arm, `beforeAll` throws and every test here goes red rather than scanning vacuously.
 *
 * ⚠⚠ WHICH TREES ARE SCANNED. `apps/web/src`, `packages/shared/src`, and `packages/analytics/src`
 * (see `SCAN_ROOTS`) — every package that can see the `Workspace` union today. That the list is
 * COMPLETE is not assumed: "F-6: no UNSCANNED package imports the workspace module" walks every
 * other `<group>/<package>/src` in the monorepo and turns red the day one imports it. `apps/api`
 * does not, today.
 *
 * ⚠⚠ KNOWN BLIND SPOTS — do not assume coverage this suite does not have. EVERY BULLET BELOW WAS
 * RE-VERIFIED EMPIRICALLY AGAINST THE CODE AS IT NOW STANDS (BAL-507 FINAL round, re-run from
 * scratch — not copied forward from the fix round): each was written out as a real,
 * type-checking `role === 'owner'` gate in a scanned production file, the file was confirmed to
 * compile clean under `tsc --noEmit`, and the suite stayed GREEN. The two bullets that need a
 * union of a shape this repo does not have — the inline object arm, and the mapped-type union
 * arm — were measured by temporarily mutating the real shared module and restoring it
 * byte-for-byte. Nothing here is inherited unchecked.
 *
 * ⚠ AND THE LIST IS DELIBERATELY LEFT AS A LIST. Three rounds of "patch a form, find another
 * form" preceded this one; the final round fixed only the false positives it had introduced,
 * plus the ONE gap whose closure made an existing CLAIM true (the mapped-type heritage clause,
 * F-3). The rest are DOCUMENTED, not fixed, on purpose: every additional matcher surface is
 * additional false-positive risk, and a false alarm is worse than a known gap here — a noisy
 * invariant gets deleted by the next engineer, and then there is no invariant at all.
 *
 * (a) OUT OF SCOPE BY DEFINITION, AND WORTH SAYING PLAINLY: this suite enforces "no `.role` read
 * off a Workspace". A workspace-SHAPED type that is never reachable from the `Workspace` union is
 * not a Workspace, and a `.role` gate on it is NOT caught. Partial mitigation only: the F-4
 * cross-check below turns red if such a type is EXPORTED from the shared workspaces module AND
 * named `*Workspace`. It is invisible if the type is un-exported, named anything else, or
 * declared outside that module. Chasing this is explicitly not this suite's job.
 *
 *   ⚠ THE PRACTICAL SHAPE OF (a), and the one to recognise in review — A SECOND EXPORTED UNION
 *   ALIAS, NAMED OUT OF THE `*Workspace` FAMILY:
 *       interface DelegateScope { readonly type: 'delegate'; readonly role: CompanyMemberRole }
 *       export type { DelegateScope };
 *       export type AnyActorScope = Workspace | DelegateScope;   // in the shared module
 *   then `(s: DelegateScope) => s.role === 'owner'` in web. MEASURED green. Only the `Workspace`
 *   export is a derivation root, so nothing reachable from `AnyActorScope` alone is watched, and
 *   the out-of-family names slip the F-4 cross-check. Naming either `…Workspace` is what makes
 *   F-4 fire — so renaming out of family is the required laundering step, and it is a deliberate
 *   one. Adding a second derivation root is the remedy if such a union is ever wanted.
 *
 *   ⚠ F-6's ROOT-COVERAGE PIN IS A STATIC TEXT CHECK, AND A TRANSITIVE BARREL RE-EXPORT DEFEATS
 *   IT. "no UNSCANNED package imports the workspace module" greps each unscanned package's
 *   comment-stripped source for the literal specifier `@balo/shared/workspaces`. An unscanned
 *   package that reaches the type through an ALREADY-SCANNED package never writes that string.
 *   MEASURED: `packages/analytics/src/events/index.ts` re-exporting
 *   `export type { MembershipCompanyWorkspace } from '@balo/shared/workspaces'`, then
 *   `apps/api/src/…` doing `import type { MembershipCompanyWorkspace } from
 *   '@balo/analytics/events'` and gating `w.role === 'owner'` — the whole suite stayed GREEN.
 *   The pin's value is against the DIRECT importer, which is how a new package normally arrives;
 *   it is not a transitive-closure check and must not be read as one.
 *
 * (b) AN INLINE OBJECT ARM (`export type Workspace = … | { readonly role: 'owner' }`) is reachable
 * but has no name — MEASURED, not assumed: its constituent symbol comes back as the anonymous
 * `__type` — and `walkWorkspaceTypes` skips `__`-prefixed names because the scan matches by
 * name and no receiver can be DECLARED as `__type`. Not currently used; an arm in this codebase
 * is always a named interface or alias.
 *
 * (c) LAUNDERING AT THE READ SITE — the derivation decides WHICH TYPES are watched; these are all
 * about HOW a receiver's type is resolved. `workspaceTypeNameOf` does NOT see through a value
 * that has been re-typed into an anonymous or mapped type before the `.role` read:
 *   - `const copy = { ...w }; copy.role;`            — spread copy → anonymous object type
 *   - `const { ...copy } = w; copy.role;`            — full-rest destructure → anonymous type
 *   - ANY built-in mapped-type wrapper AROUND A WORKSPACE-FAMILY TYPE, in EVERY read form
 *     (property access, element access, and destructuring alike). Each read type-checks:
 *       `(w: Readonly<MembershipCompanyWorkspace>) => w.role`
 *       `(w: Pick<MembershipCompanyWorkspace, 'role'>) => w.role`
 *       `(w: Omit<MembershipCompanyWorkspace, 'via'>) => w.role`
 *       `(w: Partial<MembershipCompanyWorkspace>) => w.role`   // `role` optional; read still legal
 *     The gate-shaped form `w.role === 'owner'` is missed behind all four — i.e. the exact
 *     ADR-1029 violation this suite exists to stop is expressible and invisible there.
 *     ⚠ AND THE SAME WRAPPER BEHIND AN ALIAS INTERSECTION, which reads like a subtype but is
 *     not one: `type Row = Readonly<MembershipCompanyWorkspace> & { readonly isActive: boolean }`
 *     then `row.role === 'owner'`. MEASURED green as this suite stands. This is the exact
 *     non-heritage twin of the four HERITAGE forms the final round CLOSED (see F-3 below), and
 *     the difference is the position, not the wrapper: `heritageSymbolsOf` follows alias
 *     arguments, the matcher's own top-level `candidateSymbolsOf` call deliberately does not.
 *   - THE NON-IDENTIFIER DESTRUCTURING SPELLINGS. `receiverFor` matches a `BindingElement` only
 *     when `propertyName ?? name` is an IDENTIFIER, so the plain rename `const { role: myRole }
 *     = w` is caught and these two are NOT (both MEASURED green, both type-checking gates):
 *       `const { 'role': r } = w;`                          — string-literal binding property name
 *       `const KEY = 'role' as const; const { [KEY]: r } = w;`  — COMPUTED binding property name
 *     ⚠⚠ THE SECOND IS THE DESTRUCTURING TWIN OF THE ELEMENT-ACCESS CASE F-4 CLOSED, AND SAYING
 *     SO IS THE POINT: `w[ROLE_FIELD]` and `const { [KEY]: r } = w` are the same refactor
 *     ("hoist the field name to a constant") applied to the two read forms this suite watches.
 *     F-4 closed the ELEMENT-ACCESS half by asking the checker for the key's literal type; the
 *     DESTRUCTURING half was not closed and is not closed now. It is a symmetric pair with only
 *     one half covered — do not read F-4's presence as covering both.
 *   - DESTRUCTURING **ASSIGNMENT**, as opposed to a destructuring DECLARATION:
 *       `let role; ({ role } = w);`
 *     MEASURED green. This is an `ObjectLiteralExpression` holding a `ShorthandPropertyAssignment`
 *     — NOT an `ObjectBindingPattern` holding a `BindingElement` — so `receiverFor`'s third arm
 *     never fires on it at all. Different AST node kinds for what a reader sees as the same
 *     operation; the scan matches node kinds.
 *   - AN ELEMENT-ACCESS KEY WHOSE TYPE IS A **UNION** OF LITERALS:
 *       `declare const KEY: 'role' | 'name'; w[KEY] === 'owner'`
 *     MEASURED green. `elementAccessNamesRole` asks `argumentType.isStringLiteral()`, which is
 *     false for a union — the SINGLE-literal form it was built for IS caught. Widening to "any
 *     union constituent is `'role'`" was deliberately NOT done in this round: the remaining gaps
 *     are documented rather than chased, and more matcher surface is more false-positive risk.
 *   - A KEYOF-PARAMETERISED ACCESSOR:
 *       function get<K extends keyof MembershipCompanyWorkspace>(w: MembershipCompanyWorkspace, k: K) { return w[k]; }
 *       get(w, 'role') === 'owner';
 *     The only element access is `w[k]`, whose key is a TYPE PARAMETER, not a string-literal type
 *     — so the F-4 checker lookup correctly declines it — and the call site reads nothing off a
 *     workspace at all. Deliberate: nobody writes a generic property accessor by accident.
 * The first two bullets require the AUTHOR to deliberately re-type the value first — laundering,
 * not accidental drift. ⚠⚠ THE MAPPED-TYPE BULLET DOES NOT, AND IS THE ONE TO WATCH. Narrowing a
 * parameter with `Pick<T, …>` to just the fields it reads is this repo's OWN house style,
 * including in the authz layer: `hasPlatformCapability(user: Pick<SessionUser, 'platformRole'>)`
 * (`lib/authz/platform.ts`) and `isImpersonatedSession(actor: Pick<SessionUser, 'isImpersonating'>)`
 * (`lib/auth/impersonation.ts`). A component prop declared
 * `readonly workspace: Pick<MembershipCompanyWorkspace, 'name' | 'role'>`, then read, is
 * idiomatic, INNOCENT, and silently missed (measured). Treat it as a real fail-open hole, not a
 * merely theoretical one.
 *   ⚠ NOT a blind spot, also measured — do not over-read the bullet above. `Readonly<>` around a
 *   PROPS CONTAINER (the pervasive `Readonly<XxxProps>` idiom, ~830 sites here) is CAUGHT so long
 *   as the wrapped FIELD keeps its Workspace-family type:
 *   `({ workspace }: Readonly<{ workspace: MembershipCompanyWorkspace }>) => workspace.role` is a
 *   hit, as is `props.workspace.role`. Only a wrapper around the WORKSPACE TYPE ITSELF launders.
 *   (Re-MEASURED in the fix round: both forms still fail loudly.)
 *   ⚠ THE MAPPED-TYPE WRAPPER AS A **UNION ARM**: THE F-2 FIX KEEPS THE ARM'S *NAME*, AND THAT
 *   IS ALL IT DOES — an earlier wording of this bullet claimed the union-arm form was "no longer
 *   a blind spot" full stop, which OVERSTATES it. What is true: `export type Workspace = … |
 *   Readonly<AgencyOwnerArm>` used to lose the ARM ITSELF from the watched set, and
 *   `candidateSymbolsOf` now recurses `aliasTypeArguments` during DERIVATION (only), so
 *   `AgencyOwnerArm` IS derived and a receiver DECLARED as `AgencyOwnerArm` is caught.
 *   What is NOT true: that reads through such an arm are all caught. MEASURED this round, by
 *   temporarily making a real arm `Readonly<MembershipCompanyWorkspace>` in the shared module —
 *   a `Workspace`-typed receiver FLOW-NARROWED onto that arm
 *   (`if (w.type === 'company' && w.via === 'membership') return w.role === 'owner';`) resolves
 *   to the MAPPED TYPE, whose alias symbol is the `.d.ts` `Readonly` and is therefore unwatched,
 *   so the gate is MISSED. The derived NAME does not help, because the narrowed receiver never
 *   presents it. (One partial consolation, also measured: that mutation launders the ALLOWLISTED
 *   presentation read too, so the reality pin goes red and the coverage loss is at least
 *   visible — but it is visible as an unexplained pin failure, not as the gate it hides, and it
 *   would not be visible at all if no allowlisted read happened to exist.) The read-site bullet
 *   above stands unchanged.
 *
 * ⚠ CLOSED IN THE BAL-507 FIX ROUND, so nobody re-adds a workaround for them — each was
 * demonstrated first with a real type-checking gate that shipped green, then MUTATION-VERIFIED
 * (revert the fix, watch the same gate go green again):
 *   - an arm declared in a SIBLING FILE of the shared module and pulled into the exported union
 *     (F-1) — the receiver confirmation was a hardcoded `'/shared/src/workspaces/'` path
 *     substring and threw the arm away after the derivation had correctly found it;
 *   - a mapped-type UNION ARM (F-2, above);
 *   - a SUBTYPE of a watched arm reached through a HERITAGE CLAUSE — `interface
 *     ActiveWorkspaceRow extends MembershipCompanyWorkspace` or `class X implements
 *     MembershipCompanyWorkspace` — declared anywhere (F-3). ⚠ THE PRECISE SCOPE, because an
 *     earlier wording of this bullet said only "declared anywhere" and was FALSE: the clause may
 *     also WRAP the arm in a mapped type (`extends Readonly<Arm>`, `extends Pick<Arm, 'role'>`,
 *     `implements Readonly<Pick<Arm, 'role'>>`, and the same with a locally-declared
 *     `Frozen<T>`), all four of which shipped GREEN until the final round gave
 *     `heritageSymbolsOf` its `followAliasArguments` flag — MEASURED green before, red after,
 *     and pinned by the mapped-heritage probe. What is still NOT covered is the non-heritage
 *     spelling of the same idea, `type Row = Readonly<Arm> & {…}`: an alias intersection is not
 *     a heritage clause, it is read-site laundering, and it stays in KNOWN BLIND SPOTS
 *     (MEASURED green as this suite stands);
 *   - a CONST-TYPED element-access key, `const ROLE_FIELD = 'role' as const; w[ROLE_FIELD]` (F-4);
 *   - three PRODUCTION path shapes misclassified as test support (F-5), and a whole PACKAGE that
 *     imports the union but was never scanned (F-6);
 *   - a second `.role` read inside the ALLOWLISTED file, which the reality pin's
 *     `${file}:${kind}` dedupe silently swallowed (F-7).
 *
 * A GENERIC receiver (`<T extends MembershipCompanyWorkspace>(w: T) => w.role`) was closed in the
 * earlier review round — `collect` unwraps a type parameter to its constraint. Still open, and
 * still deliberate laundering: `(w as any).role`, and an unconstrained `<T>` (which the compiler
 * cannot know is a workspace at all).
 *
 * ⚠ A NOTE ON WHAT IS *NOT* A BLIND SPOT ANY MORE, so nobody re-adds a guard for it: an arm that
 * is present in the exported union but absent from a hand-written name list. There is no such
 * list. `WORKSPACE_TYPE_NAMES` is gone; the F-4 name-based walk survives only as an independent
 * cross-check asserting the DERIVED set covers every exported `*Workspace` name (see (a) above).
 *
 * ⚠ RUNTIME BUDGET — RE-MEASURED ON THIS FILE AS IT NOW STANDS (BAL-507 final round), and the
 * figures below SUPERSEDE every earlier one in this docblock. The earlier text recorded ~11.95s,
 * then ~9.9s, then ~12.1s CPU across successive rounds, quoted peak RSS as "~1.00 GB" in one
 * paragraph and "1.11–1.21 GB" two paragraphs later, and carried a "+60%" coverage multiplier
 * that was never re-measured after the mechanism changed. All of that is replaced here by ONE
 * internally consistent measurement of BOTH modes, taken back to back on the same machine.
 *
 * Method: `/usr/bin/time -l` around `npx vitest run [--coverage]` on this file alone, two runs
 * per mode, CPU read as user+sys (wall clock is meaningless on this machine — it is a loaded dev
 * box, load average ~6.5–9.9 on 10 cores at measurement time).
 *
 *   UNINSTRUMENTED   11.30u + 1.10s and 11.16u + 1.04s  ≈ **12.3s CPU**, peak RSS **~1.12 GB**
 *   `--coverage`     21.23u + 1.29s and 21.08u + 1.37s  ≈ **22.5s CPU**, peak RSS **~1.17 GB**
 *
 * So coverage instrumentation costs about **+83%** CPU here, not the ~+60% previously recorded,
 * and it moves peak RSS by only ~50 MB. `pnpm test:coverage` → `vitest run --coverage` is the
 * mode CI actually runs, so **22.5s CPU is the figure that matters** and the uninstrumented one
 * is quoted only so the two are never confused again. Both are well inside the 60s
 * stop-and-flag threshold, and the final round's additions (a fifth overlaid probe, the
 * alias-argument recursion in `heritageSymbolsOf`, the probe-shadowing guard) did not move the
 * uninstrumented figure outside the noise of the earlier ~12.1s reading.
 *
 * ⚠ A CI RUNNER IS NOT THIS MACHINE. The architect's plan measured ~10.5s CPU / ~6.4s wall
 * unloaded on a 10-core dev machine and expected ~15-30s WALL on a 2-vCPU runner; nothing here
 * contradicts that, because CPU-seconds and wall-seconds diverge sharply on a smaller box. The
 * threshold below is a CPU threshold.
 *
 * A lexical prefilter was measured and rejected — it saves nothing because the `.d.ts`
 * transitive closure dominates program construction, not the root file count. If a CI run ever
 * exceeds 60s CPU, STOP AND FLAG rather than softening this suite (narrowing coverage, `.skip`,
 * raising the timeout) — see `.implement/rulings-bal-507.md` Q2.
 */

const WEB_SRC = resolveRouteDir(['src', 'apps/web/src']);
const SHARED_SRC = resolveRouteDir(['packages/shared/src', '../../packages/shared/src']);
const ANALYTICS_SRC = resolveRouteDir(['packages/analytics/src', '../../packages/analytics/src']);
const WEB_ROOT = WEB_SRC === '' ? '' : path.dirname(WEB_SRC); // …/apps/web
const REPO_ROOT = WEB_ROOT === '' ? '' : path.dirname(path.dirname(WEB_ROOT));
const TSCONFIG = path.join(WEB_ROOT, 'tsconfig.json');

interface ScanTarget {
  readonly absolute: string;
  readonly rel: string;
}

/**
 * ⚠⚠ WHAT COUNTS AS A TEST FILE — A SUFFIX AND A ROOT-RELATIVE DIRECTORY, NEVER A SUBSTRING.
 *
 * The previous formulation excluded a directory named `test` AT ANY DEPTH and dropped any path
 * CONTAINING `.spec.` or `fixtures/`. All three were measured to silently unscan genuine
 * production source, each of which can carry a live ADR-1029 gate:
 *   `apps/web/src/app/(dashboard)/test/…`        — a route segment legitimately named `test`
 *   `apps/web/src/lib/workspaces/….spec.helpers.ts`
 *   `apps/web/src/lib/fixtures/….ts`
 * None of the three exists on disk TODAY (measured — `apps/web/src/test` and
 * `packages/shared/src/testing` are the only such directories in either tree, and there is no
 * `.spec.` file anywhere), so this tightening changes today's scanned set by ZERO files. It
 * removes a latent hole, and `isScannableProductionSource` is pinned directly by its own test
 * below so the three shapes above cannot silently drop out again.
 *
 * The rule: a file is TEST support iff its NAME ends in `.test.ts(x)` / `.spec.ts(x)`, or it sits
 * under one of the root's declared test-only directories (matched as a ROOT-RELATIVE prefix, not
 * a floating segment). Anything else is production and is scanned.
 *
 * ⚠ Real test files must stay OUT: `apps/web/src/test/fixtures/workspaces.ts` builds
 * `MembershipCompanyWorkspace` values on purpose, and scanning it would flood this suite with
 * hits that are not gates. That file is excluded by the `test/` root-relative prefix, not by the
 * word `fixtures` appearing somewhere in its path.
 *
 * ⚠ RESIDUAL, AND NOT PAPERED OVER: `scanRouteSources` (`_source-scan.ts`, shared with the other
 * invariants in this directory and deliberately untouched here) drops any filename CONTAINING
 * `.test.`, so a production file named `x.test.helpers.ts` would still be unscanned. No such file
 * exists; closing it means changing a helper four other invariants depend on.
 */
const TEST_FILE_SUFFIXES: readonly string[] = ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx'];

function isScannableProductionSource(rel: string, testOnlyDirs: readonly string[]): boolean {
  if (TEST_FILE_SUFFIXES.some((suffix) => rel.endsWith(suffix))) return false;
  return testOnlyDirs.every((dir) => !rel.startsWith(dir));
}

/** One tree the scan walks: where it lives, how its files are named in a `Hit`, and which
 *  ROOT-RELATIVE directories inside it are test support. */
interface ScanRoot {
  readonly dir: string;
  readonly relPrefix: string;
  readonly testOnlyDirs: readonly string[];
}

/**
 * ⚠⚠ EVERY TREE THAT CAN SEE A `Workspace`, NOT JUST THE TWO THAT DECLARE ONE.
 * `packages/analytics` ALREADY imports the union (`src/events/workspace.ts`, `src/events/nav.ts`),
 * so a role helper defined there and consumed by web was invisible to this scan. It is a root now.
 * `apps/api` does NOT import `@balo/shared/workspaces` today — measured, and PINNED by
 * "no unscanned package imports the workspace module" below, which turns red the day one does.
 */
const SCAN_ROOTS: readonly ScanRoot[] = [
  { dir: WEB_SRC, relPrefix: 'apps/web/src', testOnlyDirs: ['test/'] },
  { dir: SHARED_SRC, relPrefix: 'packages/shared/src', testOnlyDirs: ['testing/'] },
  { dir: ANALYTICS_SRC, relPrefix: 'packages/analytics/src', testOnlyDirs: [] },
];

function targetsUnder(root: ScanRoot): ScanTarget[] {
  return scanRouteSources(root.dir, '', [])
    .filter((f) => isScannableProductionSource(f.rel, root.testOnlyDirs))
    .map((f) => ({ absolute: path.join(root.dir, f.rel), rel: `${root.relPrefix}/${f.rel}` }));
}

const TARGETS: readonly ScanTarget[] = SCAN_ROOTS.flatMap(targetsUnder);

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

// A SECOND overlaid probe, for the GENERIC-receiver direction closed in the BAL-507 fix round.
// Kept as its own virtual file so its two hits are distinguishable by `file` alone — the `Hit`
// record carries no field that would separate them from the plain probe's hits otherwise.
const GENERIC_PROBE_REL = 'apps/web/src/__workspace_role_generic_probe__.ts';
const GENERIC_PROBE_ABS = path.join(WEB_SRC, '__workspace_role_generic_probe__.ts');
const GENERIC_PROBE_SOURCE = `
import type { MembershipCompanyWorkspace } from '@balo/shared/workspaces';
export function probeGenericAccess<T extends MembershipCompanyWorkspace>(w: T): unknown {
  return w.role;                               // generic-receiver property access
}
export function probeGenericDestructure<T extends MembershipCompanyWorkspace>(w: T): unknown {
  const { role } = w;                          // generic-receiver destructure
  return role;
}
`;

// A THIRD overlaid probe, for the SUBTYPE direction (F-3): a type declared in `apps/web` that
// inherits a watched arm. Both heritage forms are exercised — `interface … extends …` and
// `class … implements …` — because `checker.getBaseTypes` sees only the first and this suite
// resolves both through heritage clauses instead. Every member of the class is supplied so the
// probe body stays diagnostic-free (an error inside a probe risks degrading the receiver's
// resolved type, which would make the probe prove nothing).
const SUBTYPE_PROBE_REL = 'apps/web/src/__workspace_role_subtype_probe__.ts';
const SUBTYPE_PROBE_ABS = path.join(WEB_SRC, '__workspace_role_subtype_probe__.ts');
const SUBTYPE_PROBE_SOURCE = `
import type { MembershipCompanyWorkspace } from '@balo/shared/workspaces';
interface ActiveWorkspaceRow extends MembershipCompanyWorkspace {
  readonly isActive: boolean;
}
export function probeSubtypeAccess(row: ActiveWorkspaceRow): unknown {
  return row.role;                             // subtype via \`extends\`
}
export class WorkspaceRow implements MembershipCompanyWorkspace {
  readonly type = 'company' as const;
  readonly key = 'company:x';
  readonly companyId = 'x';
  readonly name = 'x';
  readonly isPersonal = false;
  readonly via = 'membership' as const;
  readonly role = 'member' as const;
}
export function probeImplementsAccess(row: WorkspaceRow): unknown {
  const { role } = row;                        // subtype via \`implements\`
  return role;
}
`;

// A FOURTH overlaid probe, for the CONST-TYPED ELEMENT-ACCESS KEY (F-4) — what a "hoist the field
// name to a constant" refactor produces. The literal forms are kept alongside it so a future
// change that closed one by breaking the other would be caught here.
const KEY_PROBE_REL = 'apps/web/src/__workspace_role_key_probe__.ts';
const KEY_PROBE_ABS = path.join(WEB_SRC, '__workspace_role_key_probe__.ts');
const KEY_PROBE_SOURCE = `
import type { MembershipCompanyWorkspace } from '@balo/shared/workspaces';
const ROLE_FIELD = 'role' as const;
export function probeConstKeyAccess(w: MembershipCompanyWorkspace): unknown {
  return w[ROLE_FIELD];                        // element access via a string-literal-TYPED key
}
export function probeStringLiteralKeyAccess(w: MembershipCompanyWorkspace): unknown {
  return w['role'];                            // element access via a plain string literal
}
export function probeTemplateKeyAccess(w: MembershipCompanyWorkspace): unknown {
  return w[\`role\`];                            // element access via a template literal
}
const NAME_FIELD = 'name' as const;
export function probeOtherConstKeyIsNotAHit(w: MembershipCompanyWorkspace): unknown {
  return w[NAME_FIELD];                        // const-typed key naming a DIFFERENT field
}
export function probeDynamicKeyIsNotAHit(w: MembershipCompanyWorkspace, k: string): unknown {
  return (w as unknown as Record<string, unknown>)[k];  // \`string\` key — must NOT be a hit
}
`;

// A FIFTH overlaid probe, for a MAPPED-TYPE WRAPPER IN A HERITAGE CLAUSE — the subtype form
// `heritageSymbolsOf` used to miss because it asked `candidateSymbolsOf` NOT to follow alias type
// arguments. `interface Row extends Readonly<MembershipCompanyWorkspace>` then `row.role ===
// 'owner'` is a subtype of a watched arm by any reading, needs no laundering, and shipped GREEN
// (MEASURED, BAL-507 final round) — which made this suite's own claim that F-3 closed subtypes
// "declared anywhere" false. Its own virtual file, for the same reason the generic probe has one:
// so its hits are distinguishable by `file` alone.
const MAPPED_HERITAGE_PROBE_REL = 'apps/web/src/__workspace_role_mapped_heritage_probe__.ts';
const MAPPED_HERITAGE_PROBE_ABS = path.join(WEB_SRC, '__workspace_role_mapped_heritage_probe__.ts');
const MAPPED_HERITAGE_PROBE_SOURCE = `
import type { MembershipCompanyWorkspace } from '@balo/shared/workspaces';
interface FrozenWorkspaceRow extends Readonly<MembershipCompanyWorkspace> {
  readonly isActive: boolean;
}
export function probeMappedHeritageAccess(row: FrozenWorkspaceRow): unknown {
  return row.role;                             // \`extends Readonly<Arm>\`
}
export class PickedWorkspaceRow implements Pick<MembershipCompanyWorkspace, 'role'> {
  readonly role = 'member' as const;
}
export function probePickHeritageDestructure(row: PickedWorkspaceRow): unknown {
  const { role } = row;                        // \`implements Pick<Arm, 'role'>\`
  return role;
}
`;

const PROBES: ReadonlyMap<string, string> = new Map([
  [PROBE_ABS, PROBE_SOURCE],
  [GENERIC_PROBE_ABS, GENERIC_PROBE_SOURCE],
  [SUBTYPE_PROBE_ABS, SUBTYPE_PROBE_SOURCE],
  [KEY_PROBE_ABS, KEY_PROBE_SOURCE],
  [MAPPED_HERITAGE_PROBE_ABS, MAPPED_HERITAGE_PROBE_SOURCE],
]);

/**
 * ⚠⚠ THE PROBE PATHS MUST NOT EXIST ON DISK, AND A SHADOWED ONE FAILS LOUDLY HERE.
 *
 * The probes are served from MEMORY by the CompilerHost above, but `TARGETS` is built by walking
 * the REAL tree — so a real file sitting at a probe path is picked up into `TARGETS` (and into
 * `realFileRelPaths`) while `host.getSourceFile` hands the compiler the PROBE text for it. The
 * scan then reports the probe's violations against a REAL file, at lines that do not exist in it.
 * MEASURED (BAL-507 final round): an innocent two-line module written to
 * `apps/web/src/__workspace_role_probe__.ts` produced two phantom violations, at lines 4 and 7 of
 * a file that has neither — and the reality pin went red naming a file that reads no `role` at
 * all. Phantom hits at impossible lines are the single most corrosive thing an invariant can
 * print: nobody can act on them, so the suite gets deleted.
 *
 * Asserting NON-EXISTENCE rather than filtering those paths out of `TARGETS` is deliberate: a
 * filter would silently unscan a real production file that happened to be named this way, which
 * is a fail-OPEN. This throws, taking every test in the file red with a message that says
 * exactly what to do. The names are `__`-fenced precisely so this can never fire by accident.
 */
const PROBE_SHADOWED = [
  "BAL-507 / ADR-1029 — a REAL FILE exists at one of this suite's in-memory PROBE paths.",
  'The probes are overlaid onto the program from memory, so the compiler would read the PROBE',
  'text while the scan reports hits against the REAL file — phantom violations at lines that do',
  'not exist in it. Rename the file (these paths are `__`-fenced so nothing should ever land',
  'here), or rename the probe. Never filter these paths out of TARGETS: that would silently',
  'unscan real production source.',
  'Shadowed:',
].join('\n');

function shadowedProbePaths(): string[] {
  return [...PROBES.keys()].filter((absolute) => existsSync(absolute));
}

function assertProbePathsAreVirtual(): void {
  const shadowed = shadowedProbePaths();
  if (shadowed.length > 0) throw new Error(`${PROBE_SHADOWED}\n${shadowed.join('\n')}`);
}

// ── Program construction ────────────────────────────────────────────────────────────────────

function buildProgram(): ts.Program {
  const configFile = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, WEB_ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };

  const host = ts.createCompilerHost(options, /* setParentNodes */ true);
  const origGetSourceFile = host.getSourceFile.bind(host);
  const origReadFile = host.readFile.bind(host);
  const origFileExists = host.fileExists.bind(host);
  host.fileExists = (f) => PROBES.has(path.normalize(f)) || origFileExists(f);
  host.readFile = (f) => PROBES.get(path.normalize(f)) ?? origReadFile(f);
  host.getSourceFile = (f, lv, oe, sh) => {
    const overlaid = PROBES.get(path.normalize(f));
    // Positive-form condition on purpose (`=== undefined`, not `!== undefined` with the branches
    // swapped): `unicorn/no-negated-condition` / SonarCloud S7735 is `error` in
    // `packages/eslint-config/sonar.js`, and this file is 100% new code on this PR, so a negated
    // ternary here lands on new-code maintainability. Behaviour is identical.
    return overlaid === undefined
      ? origGetSourceFile(f, lv, oe, sh)
      : ts.createSourceFile(f, overlaid, lv, true);
  };

  return ts.createProgram({
    rootNames: [...TARGETS.map((t) => t.absolute), ...PROBES.keys()],
    options,
    host,
  });
}

// ── The AST walk ────────────────────────────────────────────────────────────────────────────

type HitKind = 'access' | 'element' | 'destructure';

/**
 * Does `w[…]` name the `role` property?
 *
 * ⚠⚠ THE CHECKER IS ASKED, NOT JUST THE SYNTAX, AND THAT CLOSED A REAL HOLE. The syntactic form
 * (`w['role']`, `w[\`role\`]`) is still matched first and cheaply. But a "hoist the field name to
 * a constant" refactor — `const ROLE_FIELD = 'role' as const; w[ROLE_FIELD]` — produces an
 * IDENTIFIER argument, which the literal test rejects while the read is exactly as much of an
 * ADR-1029 gate as `w.role === 'owner'`. Nobody has to intend to launder to write that. So when
 * the argument is not a literal, its TYPE is resolved: a string-literal type of `'role'` is a hit.
 * A `string`-typed key (`w[someVar]`) yields no literal type and is correctly not a hit.
 *
 * The checker call is reached only for element accesses whose argument is not already a string
 * literal — a small minority of nodes — so the walk's cost is unchanged in practice (measured;
 * see the RUNTIME BUDGET note at the top of this file).
 */
function elementAccessNamesRole(
  node: ts.ElementAccessExpression,
  checker: ts.TypeChecker
): boolean {
  const argument: ts.Expression | undefined = node.argumentExpression;
  if (argument === undefined) return false;
  if (ts.isStringLiteralLike(argument)) return argument.text === 'role';
  const argumentType = checker.getTypeAtLocation(argument);
  return argumentType.isStringLiteral() && argumentType.value === 'role';
}

function receiverFor(
  node: ts.Node,
  checker: ts.TypeChecker
): { readonly receiver: ts.Node; readonly kind: HitKind } | null {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'role') {
    return { receiver: node.expression, kind: 'access' }; // w.role, w?.role
  }
  if (ts.isElementAccessExpression(node) && elementAccessNamesRole(node, checker)) {
    return { receiver: node.expression, kind: 'element' }; // w['role'], w[ROLE_FIELD]
  }
  if (ts.isBindingElement(node)) {
    // ⚠ THE RENAME IS HANDLED ONLY IN ITS IDENTIFIER SPELLING, and the `ts.isIdentifier` guard
    // below is where that stops. `const { role: myRole } = w` IS caught (`propertyName` is the
    // identifier `role`). `const { 'role': r } = w` (StringLiteral `propertyName`) and
    // `const { [KEY]: r } = w` (ComputedPropertyName) are NOT — both MEASURED green, and both
    // listed in KNOWN BLIND SPOTS at the top of this file. The computed form is the
    // DESTRUCTURING twin of the element-access key F-4 closed, and only that half is closed.
    const named = node.propertyName ?? node.name; // `{ role: myRole }` — identifier rename only
    if (ts.isIdentifier(named) && named.text === 'role') {
      return { receiver: node.parent, kind: 'destructure' }; // the ObjectBindingPattern
    }
  }
  return null;
}

const SHARED_INDEX_REL = 'packages/shared/src/workspaces/index.ts';

// ── THE WATCHED SET IS DERIVED, NOT HAND-MAINTAINED (BAL-507 mechanism change) ──────────────
//
// ⚠⚠ WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS A MECHANISM CHANGE RATHER THAN ANOTHER
// FORM PATCH. The scan used to consult a hand-written `WORKSPACE_TYPE_NAMES: ReadonlySet<string>`
// literal, cross-checked by a NAME-BASED walk of the shared module's exported `*Workspace`
// declarations (the "F-4" guard, still present below in a narrower role). Two adversarial rounds
// defeated that name-based ground truth, and the decisive case needed no laundering at all:
//
//     interface AgencyOwnerArm extends CompanyWorkspaceBase {
//       readonly via: 'agency'; readonly role: CompanyMemberRole;
//     }
//     export type Workspace = ExpertWorkspace | CompanyWorkspace | AgencyOwnerArm; // arm NOT exported
//
// The arm needs no `export` of its own — the UNION is exported, so the arm is fully public and
// fully usable, while no walk over EXPORT declarations ever sees its name. A real ADR-1029 gate
// `(w: Workspace) => w.via === 'agency' && w.role === 'owner'` in production web source then ran
// FULLY GREEN. Patching more syntactic forms cannot fix that: the fault was that the watched set
// was a NAME list a human had to keep in sync, not a fact about the type.
//
// The ground truth is SEMANTIC — **the set of types reachable from the exported `Workspace`
// union, resolved through the TypeChecker** — and that is what `deriveWatchedTypes` below
// computes, once, in `beforeAll`. A new arm added to the union is therefore watched
// AUTOMATICALLY, with no edit to this suite.
//
// TWO COLLECTION PATHS, BOTH REQUIRED — this is not belt-and-braces:
//   1. SEMANTIC (`candidateSymbolsOf`): the resolved type's alias symbol plus every
//      union/intersection constituent's symbol. Mirrors exactly what the scan's matcher can see,
//      because it IS the scan's matcher (one function, two callers).
//   2. SYNTACTIC SPINE (`aliasSpineSymbols` → `unionSpineTypeReferences`): the type REFERENCES
//      written on the union/intersection spine of a type-alias declaration. Needed because
//      TypeScript FLATTENS nested unions — `Workspace = ExpertWorkspace | CompanyWorkspace`
//      resolves to a three-constituent union in which the intermediate alias `CompanyWorkspace`
//      does not appear at all. But `collect()` pushes `t.aliasSymbol` BEFORE recursing, so a
//      receiver written `(w: CompanyWorkspace)` IS matchable by that name — it must therefore be
//      in the watched set. Path 2 recovers it. The spine walk deliberately descends ONLY through
//      union / intersection / parenthesized nodes: it must not wander into a member's type
//      (`readonly role: CompanyMemberRole`) and start watching unrelated names.
//
// The whole thing FAILS CLOSED — see `assertDerivedSetIsUsable`. A derived set that silently came
// back empty would make every assertion in this file vacuous, i.e. strictly worse than the
// hand-maintained list it replaces.

/** The single exported entry point the watched set is derived FROM. */
const WORKSPACE_UNION_EXPORT = 'Workspace';

/**
 * A FLOOR the derived set must clear — deliberately NOT a mirror of it (`⊇`, never `===`).
 *
 * ⚠ THIS IS NOT THE OLD HAND-MAINTAINED SET UNDER A NEW NAME, and the difference is the whole
 * point of this change. An `toEqual` cross-check would reinstate exactly the human step the
 * derivation removes: every new arm would turn this suite red until someone edited this file,
 * which is the maintenance burden that let `AgencyOwnerArm` through in the first place. A FLOOR
 * costs nothing when an arm is ADDED (the derivation just grows) and fails closed when the
 * derivation DEGRADES — resolution silently returning `undefined`, the union collapsing to one
 * arm, a rename that quietly empties the set.
 *
 * All five names are load-bearing at the SCAN, not just the three arms: `Workspace` and
 * `CompanyWorkspace` are alias names a receiver can be declared with (`(w: CompanyWorkspace) =>`),
 * and `collect()` hoists `aliasSymbol` before recursing precisely so those are matchable.
 * Removing or renaming one of these five is a deliberate act that SHOULD be reviewed here.
 */
const REQUIRED_DERIVED_NAMES: readonly string[] = [
  'Workspace',
  'CompanyWorkspace',
  'ExpertWorkspace',
  'MembershipCompanyWorkspace',
  'RepresentationCompanyWorkspace',
];

const DERIVATION_FAILURE = [
  'BAL-507 / ADR-1029 — the WATCHED TYPE SET could not be derived from the exported',
  `\`${WORKSPACE_UNION_EXPORT}\` union in ${SHARED_INDEX_REL}.`,
  'This suite FAILS CLOSED on purpose: the scan below consults the DERIVED set, so an empty or',
  'partial derivation would make every assertion in this file pass vacuously — strictly worse',
  'than no invariant at all. Fix the resolution (or the union). Never relax this check.',
].join('\n');

function derivationError(detail: string): Error {
  return new Error(`${DERIVATION_FAILURE}\n  ${detail}`);
}

/** The exported symbol named `name` on a module source file, via the checker's module symbol. */
function moduleExportSymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  name: string
): ts.Symbol | undefined {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) return undefined;
  return checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === name);
}

/** Follow an import/export alias to the thing it names. Guarded: `getAliasedSymbol` throws on a
 *  non-alias symbol. */
function unaliasSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
}

/**
 * The type REFERENCES on a type node's union/intersection SPINE — and nothing deeper. Descends
 * through `A | B`, `A & B`, and `(A)`; stops at anything else, so a member type inside a type
 * literal (`{ readonly role: CompanyMemberRole }`) is NOT collected. Over-collecting there would
 * pull `CompanyMemberRole` into the watched set: harmless today, but the watched set should mean
 * "a type a Workspace receiver can be declared as", not "any name mentioned nearby".
 */
function unionSpineTypeReferences(node: ts.TypeNode): ts.TypeReferenceNode[] {
  if (ts.isParenthesizedTypeNode(node)) return unionSpineTypeReferences(node.type);
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap(unionSpineTypeReferences);
  }
  return ts.isTypeReferenceNode(node) ? [node] : [];
}

/** Collection path 2 — the intermediate alias names TypeScript's union flattening loses. */
function aliasSpineSymbols(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol[] {
  const referenced: ts.Symbol[] = [];
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isTypeAliasDeclaration(declaration)) continue;
    for (const reference of unionSpineTypeReferences(declaration.type)) {
      const target = checker.getSymbolAtLocation(reference.typeName);
      if (target !== undefined) referenced.push(unaliasSymbol(checker, target));
    }
  }
  return referenced;
}

/**
 * WHAT THE DERIVATION PRODUCES — three views of the SAME walk, all consumed by the matcher.
 *
 * `names` is what the matcher compares `symbol.getName()` against. `symbols` is the identity set,
 * tried FIRST (see `workspaceTypeNameOf`). `origins` records where the arms were actually
 * DECLARED, and replaces the old hardcoded `'/shared/src/workspaces/'` path substring.
 */
interface WatchedTypes {
  readonly names: ReadonlySet<string>;
  readonly symbols: ReadonlySet<ts.Symbol>;
  readonly origins: ReadonlySet<string>;
}

const SOURCE_ROOT_SEGMENT = '/src/';

/**
 * A declaration file's PACKAGE-QUALIFIED origin — the directory that owns the `src/` root, plus
 * the path beneath it: `shared/src/workspaces/index.ts` for the shared module,
 * `shared/src/adv-far-arms.ts` for a sibling-file arm.
 *
 * ⚠⚠ THE PACKAGE SEGMENT IS LOAD-BEARING, AND ITS ABSENCE WAS A MEASURED FALSE POSITIVE. This
 * used to keep only the tail after the LAST `/src/` (`/src/workspaces/index.ts`), which names a
 * path INSIDE some package without saying WHICH — so any type named `Workspace` /
 * `CompanyWorkspace` / `ExpertWorkspace` / `MembershipCompanyWorkspace` /
 * `RepresentationCompanyWorkspace` declared at `<any package>/src/workspaces/index.ts` was
 * confirmed as OURS by path 2 below. MEASURED: an unrelated `export interface ExpertWorkspace`
 * with a plain DISPLAY read (`return \`Expert · \${w.role}\``) in a new
 * `packages/analytics/src/workspaces/index.ts` was reported as an ADR-1029 VIOLATION. A false
 * alarm is the worst thing this suite can do — a noisy invariant gets deleted — so the
 * fingerprint now carries the owning package's directory name and a same-named type in a
 * DIFFERENT package can no longer be confirmed (`analytics/src/workspaces/index.ts` ≠
 * `shared/src/workspaces/index.ts`).
 *
 * ⚠ WHY ONE SEGMENT AND NOT THE WHOLE REPO-RELATIVE PATH — this is the pnpm-symlink reasoning,
 * preserved. pnpm symlinks `node_modules/@balo/shared` → `packages/shared`. TypeScript realpaths
 * module resolution today (MEASURED: a receiver typed through `import … from
 * '@balo/shared/workspaces'` resolves to a symbol whose declaration file is the REAL
 * `packages/shared/src/workspaces/index.ts`, and that symbol is `===` the one the derivation
 * collected), but a full-path comparison would go silently VACUOUS the day that changed: the
 * derivation walks the real tree (`packages/shared/src/…`) while the read site would resolve
 * through the link (`node_modules/@balo/shared/src/…`). Those two spellings agree on exactly one
 * more segment than the bare tail — the package directory, `shared` in both — and that is the
 * longest common suffix available, so it is precisely as much precision as symlink tolerance
 * allows. Going one segment further (`packages/shared` vs `@balo/shared`) would break it.
 * `ts.SourceFile.fileName` is always forward-slashed, so no `path.sep` handling is needed.
 */
function originOf(fileName: string): string {
  const at = fileName.lastIndexOf(SOURCE_ROOT_SEGMENT);
  if (at === -1) return fileName;
  const packageStart = fileName.lastIndexOf('/', at - 1);
  return fileName.slice(packageStart + 1);
}

/**
 * Transitive symbol walk from the union root. `visited` is a genuine recursion guard here:
 * `Workspace → CompanyWorkspace → MembershipCompanyWorkspace` and back up through
 * `candidateSymbolsOf` revisits symbols freely, and a self-referential alias would otherwise not
 * terminate.
 *
 * Anonymous symbols (`__type`, `__object` — an inline `{ … }` arm in the union) are skipped by
 * name: the scan matches `symbol.getName()`, and no receiver can be DECLARED as `__type`, so
 * watching it would be noise, never coverage. An inline object arm is consequently unwatched —
 * documented in KNOWN BLIND SPOTS at the top of this file.
 *
 * ⚠⚠ A SYMBOL DECLARED IN A `.d.ts` IS SKIPPED ENTIRELY, AND THAT IS LOAD-BEARING RATHER THAN
 * TIDINESS. With `followAliasArguments` on, a `Readonly<Arm>` union arm makes the GLOBAL
 * `Readonly` (`lib.es5.d.ts`) a reachable symbol. Recording it would put the name `Readonly` and
 * the origin `…/lib.es5.d.ts` into the watched set, and every one of this repo's ~830
 * `Readonly<XxxProps>` read sites would then match — a false-positive flood, not coverage. Every
 * real arm is declared in first-party `.ts` source (MEASURED: all five of today's are), and the
 * ARM behind such a wrapper is collected independently by the alias-argument recursion, so
 * skipping the wrapper costs nothing. If the shared module were ever consumed as built `.d.ts`
 * instead of source, this walk would come back empty and `assertDerivedSetIsUsable` would throw —
 * fail CLOSED, loudly.
 */
function walkWorkspaceTypes(checker: ts.TypeChecker, root: ts.Symbol): WatchedTypes {
  const names = new Set<string>();
  const symbols = new Set<ts.Symbol>();
  const origins = new Set<string>();
  const visited = new Set<ts.Symbol>();
  const queue: ts.Symbol[] = [root];
  while (queue.length > 0) {
    const symbol = queue.pop();
    if (symbol === undefined || visited.has(symbol)) continue;
    visited.add(symbol);
    const sourceFile = symbol.declarations?.[0]?.getSourceFile();
    if (sourceFile === undefined || sourceFile.isDeclarationFile) continue;
    const name = symbol.getName();
    if (!name.startsWith('__')) {
      names.add(name);
      symbols.add(symbol);
      origins.add(originOf(sourceFile.fileName));
    }
    queue.push(
      ...candidateSymbolsOf(
        checker.getDeclaredTypeOfSymbol(symbol),
        /* followAliasArguments */ true
      ),
      ...aliasSpineSymbols(checker, symbol)
    );
  }
  return { names, symbols, origins };
}

/**
 * FAIL CLOSED. Two directions, both non-negotiable:
 *  - the derived set must clear `REQUIRED_DERIVED_NAMES` (which also rules out the empty set);
 *  - it must contain NO `*Pointer` type. `ExpertWorkspacePointer` / `CompanyWorkspacePointer` /
 *    `ActiveWorkspacePointer` are the serialized cookie projection: they carry NO `role` at all,
 *    are never part of the `Workspace` union, and must stay UNWATCHED. If one ever becomes
 *    reachable from the union, that is a union bug, not extra coverage.
 */
function assertDerivedSetIsUsable(names: ReadonlySet<string>): void {
  const rendered = [...names].sort().join(', ');
  const missing = REQUIRED_DERIVED_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw derivationError(`derived set is missing ${missing.join(', ')}. Derived: [${rendered}]`);
  }
  const pointers = [...names].filter((name) => name.endsWith('Pointer'));
  if (pointers.length > 0) {
    throw derivationError(
      `the cookie projection must stay UNWATCHED, but the union reaches ${pointers.join(', ')}. ` +
        `Derived: [${rendered}]`
    );
  }
}

/** THE watched set. Resolved through the program's checker — no hardcoded name list. */
function deriveWatchedTypes(checker: ts.TypeChecker, sourceFile: ts.SourceFile): WatchedTypes {
  const root = moduleExportSymbol(checker, sourceFile, WORKSPACE_UNION_EXPORT);
  if (root === undefined) {
    throw derivationError(`no exported \`${WORKSPACE_UNION_EXPORT}\` symbol in that module.`);
  }
  const rootType = checker.getDeclaredTypeOfSymbol(root);
  if (!rootType.isUnion()) {
    throw derivationError(
      `\`${WORKSPACE_UNION_EXPORT}\` resolved to a NON-UNION type ` +
        `(${checker.typeToString(rootType)}). The scan's arm-by-arm walk has nothing to walk.`
    );
  }
  const watched = walkWorkspaceTypes(checker, root);
  assertDerivedSetIsUsable(watched.names);
  return watched;
}

/**
 * F-4 — A SECOND, INDEPENDENT GROUND TRUTH, NOW DEMOTED AND REPOINTED.
 *
 * ⚠ READ THIS BEFORE TRUSTING ANYTHING BELOW. This name-based walk is NO LONGER what the scan
 * consults, and it is no longer what defines the watched set. The watched set is DERIVED
 * semantically from the exported `Workspace` union (see `deriveWatchedTypes` above), which is
 * what makes a NEW ARM watched with no human step. This walk survives in one narrower role: it
 * asserts that every EXPORTED `*Workspace` type in the shared module is REACHABLE FROM THE UNION.
 * That is a genuine, orthogonal check — union-reachability and name-family membership are
 * different facts, and a type that is in one but not the other is worth a human look:
 *   - exported `*Workspace` but NOT in the union → a workspace-SHAPED type the scan cannot see.
 *     A `.role` gate on it is invisible (see KNOWN BLIND SPOTS at the top of this file). The two
 *     legal remedies are to add it to the `Workspace` union, or to name it out of the family.
 *   - in the union but not exported under a `*Workspace` name → fine, and now fully covered: the
 *     derivation sees it, this walk does not, and this walk only asserts one direction (⊆).
 * As of this change the walk yields exactly the same five names the derivation does, so the two
 * ground truths agree today.
 *
 * The walk itself is unchanged. It reads the shared module's own AST (already in the program) for
 * every EXPORTED interface OR TYPE ALIAS whose name ends in `Workspace`. Type aliases are included
 * deliberately: interfaces are the convention, but an arm written as
 * `export type AgencyWorkspace = CompanyWorkspaceBase & {…}` is legal TypeScript and would
 * otherwise slip both this check and (before the `aliasSymbol` hoist in `collect()`) the scan.
 *
 * ⚠ THE HISTORY BELOW IS KEPT BECAUSE IT IS WHAT MOTIVATED THE MECHANISM CHANGE. Every "would be
 * absent from WORKSPACE_TYPE_NAMES" failure described in it is now a failure this walk can no
 * longer cause, because there is no hand-maintained set left to be missing an entry — but the
 * export-form subtleties are still exactly what this walk must handle to compare like with like.
 *
 * ⚠⚠ TWO PASSES, because an export is not always an inline modifier. The first version of this
 * guard read ONLY `ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export`, which sees
 * `export interface X {…}` and nothing else. A DEFERRED export —
 *     interface AgencyWorkspace extends CompanyWorkspaceBase { readonly role: CompanyMemberRole }
 *     export type { AgencyWorkspace };
 * — carries no modifier on the declaration, so the guard stayed GREEN while a real ADR-1029 gate
 * (`canManageBilling(w: AgencyWorkspace) => w.role === 'owner'`) shipped invisible: the arm was
 * absent from WORKSPACE_TYPE_NAMES, so the scan never resolved the receiver. MEASURED, not
 * reasoned about (BAL-507 review round). Pass 2 below reads `ExportDeclaration` statements so
 * `export type { X }`, `export { X }`, `export type { A, B }`, and the alias forms are all seen.
 *
 * ⚠ WHICH NAME IS COLLECTED, AND WHY IT MUST BE THE DECLARED ONE. The scan matches
 * `symbol.getName()` — the type's DECLARED name, never its public export alias. So for
 *     export type { Foo as AgencyWorkspace };
 * the scan sees `Foo`, and `Foo` is therefore what the DERIVED WATCHED SET must contain and what
 * this guard collects (`element.propertyName ?? element.name`). Collecting `AgencyWorkspace`
 * instead would make guard and scan demand DIFFERENT strings — a green guard over a set the scan
 * can never match, i.e. the same fail-open with extra steps. The `endsWith('Workspace')` filter,
 * conversely, accepts EITHER name: an arm published as `*Workspace` is in-family however its
 * local declaration happens to be spelled, and matching only the declared name would let the
 * alias form slip straight back out.
 *
 * ⚠ THE NAME FILTER IS STILL `endsWith('Workspace')`, DELIBERATELY, and the pointer types added
 * to that module by BAL-507 (`ExpertWorkspacePointer`, `CompanyWorkspacePointer`,
 * `ActiveWorkspacePointer` — the cookie projection, which carries NO `role`) end in `Pointer`,
 * so neither pass collects them and none is dragged into this walk's output. Pass 2's
 * either-name rule does not change that: they are exported inline and un-aliased, so both their
 * names end in `Pointer` too. (A hypothetical `export type { CompanyWorkspacePointer as
 * SomethingWorkspace }` WOULD be collected and would turn this test red until a human decided
 * — fail-CLOSED, which is the direction this guard is allowed to err in.)
 *
 * ⚠ A local declaration that is a VALUE, not a type, is skipped (`local.values`) so
 * `export { EXPERT_WORKSPACE }`-shaped statements can never inject a non-type name into the
 * required set. A named element with NO local declaration at all is a re-export of an import and
 * IS collected: the scan confirms a receiver by SYMBOL IDENTITY or by the origins the derivation
 * RECORDED (`workspaceTypeNameOf`), so a sibling file's arm is genuinely scannable under its own
 * declared name.
 *
 * ⚠⚠ F-4 BLIND SPOTS — real, not covered, and not papered over:
 *   - `export * from './arms'` (and `export * as ns from …`): the AST carries no element names
 *     at all, so a `*Workspace` arm re-exported by a star is invisible to this guard. Not
 *     currently used by that module.
 *   - `export type { X } from './elsewhere'` (a re-export WITH a module specifier): the name is
 *     collected, but this guard resolves nothing through the specifier. If `./elsewhere` itself
 *     aliases (`export type { Real as X }` there), the scan sees `Real` while this guard demands
 *     `X` — they disagree, and the disagreement fails CLOSED (red) rather than open. (The SCAN
 *     half of this note is gone: it used to add that a target module outside
 *     `packages/shared/src/workspaces/` would have its receiver rejected by a hardcoded path
 *     substring whatever the watched set said. That was the F-1 hole, and it is fixed — origins
 *     are derived now, so the scan follows the union wherever its arms are declared.)
 *   - Only `packages/shared/src/workspaces/index.ts` is walked. An arm declared in a sibling file
 *     and never named by an export declaration in index.ts is not ground truth here.
 */
type LocalTypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function isLocalTypeDeclaration(statement: ts.Statement): statement is LocalTypeDeclaration {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

interface LocalDeclaredNames {
  readonly types: ReadonlySet<string>;
  readonly values: ReadonlySet<string>;
}

/** The identifier a VALUE-declaring statement introduces, if any. Narrowed one predicate at a
 *  time because `ts.Statement` declares no `name`, and a function/class name is optional
 *  (`export default function () {}`). */
function localValueName(statement: ts.Statement): ts.Identifier | undefined {
  if (ts.isFunctionDeclaration(statement)) return statement.name;
  if (ts.isClassDeclaration(statement)) return statement.name;
  if (ts.isEnumDeclaration(statement)) return statement.name;
  return undefined;
}

function variableStatementNames(statement: ts.VariableStatement): string[] {
  return statement.declarationList.declarations
    .map((declaration) => declaration.name)
    .filter((name): name is ts.Identifier => ts.isIdentifier(name))
    .map((name) => name.text);
}

function localDeclaredNames(sourceFile: ts.SourceFile): LocalDeclaredNames {
  const types = new Set<string>();
  const values = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (isLocalTypeDeclaration(statement)) {
      types.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const name of variableStatementNames(statement)) values.add(name);
      continue;
    }
    const valueName = localValueName(statement);
    if (valueName !== undefined) values.add(valueName.text);
  }
  return { types, values };
}

/** Pass 1 — INLINE `export interface X {…}` / `export type X = …`. */
function inlineExportedWorkspaceTypeNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!isLocalTypeDeclaration(statement)) continue;
    const isExported = (ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export) !== 0;
    if (!isExported) continue;
    if (statement.name.text.endsWith('Workspace')) names.push(statement.name.text);
  }
  return names;
}

/**
 * The name ONE export specifier contributes, or `null`. Always the DECLARED name
 * (`propertyName ?? name`) — that is what `symbol.getName()` gives the scan — while the
 * in-family filter accepts EITHER name, so `export type { Foo as AgencyWorkspace }` is seen and
 * contributes `Foo`. See the F-4 docblock above for the full reasoning.
 */
function deferredExportedName(
  element: ts.ExportSpecifier,
  isReExport: boolean,
  local: LocalDeclaredNames
): string | null {
  const declaredName = (element.propertyName ?? element.name).text;
  const publicName = element.name.text;
  if (!declaredName.endsWith('Workspace') && !publicName.endsWith('Workspace')) return null;
  // A LOCAL value (`const shadowWorkspace = 1; export { shadowWorkspace };`) is not a type and
  // must never be injected into the required set. Only applied when the specifier names a LOCAL
  // binding: with a module specifier the name belongs to the other module, not to this scope.
  const isLocalValueOnly =
    !isReExport && local.values.has(declaredName) && !local.types.has(declaredName);
  return isLocalValueOnly ? null : declaredName;
}

/** Pass 2 — DEFERRED `export { X }` / `export type { X }` / `export type { Foo as X }`, with or
 *  without a module specifier. `export *` carries no element names — a documented blind spot. */
function deferredExportedWorkspaceTypeNames(sourceFile: ts.SourceFile): string[] {
  const local = localDeclaredNames(sourceFile);
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) continue;
    const isReExport = statement.moduleSpecifier !== undefined;
    for (const element of clause.elements) {
      const name = deferredExportedName(element, isReExport, local);
      if (name !== null) names.push(name);
    }
  }
  return names;
}

function exportedWorkspaceTypeNames(sourceFile: ts.SourceFile): string[] {
  return [
    ...new Set([
      ...inlineExportedWorkspaceTypeNames(sourceFile),
      ...deferredExportedWorkspaceTypeNames(sourceFile),
    ]),
  ];
}

function heritageBearing(
  declaration: ts.Declaration
): declaration is ts.InterfaceDeclaration | ts.ClassDeclaration {
  return ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration);
}

/**
 * The types one declaration NAMES IN ITS HERITAGE CLAUSES — `extends` and `implements` alike.
 *
 * ⚠⚠ WHY HERITAGE CLAUSES RATHER THAN `checker.getBaseTypes`. `getBaseTypes` answers only for a
 * class/interface type and reports only the EXTENDS chain; `class X implements
 * MembershipCompanyWorkspace` has no base type at all and would sail straight through. Reading
 * the clauses covers both forms with one walk, which is what the F-3 probes pin.
 *
 * ⚠⚠ `followAliasArguments` IS ON HERE, AND IT IS WHAT MAKES THE F-3 CLAIM TRUE. This called
 * `candidateSymbolsOf` WITHOUT the flag, so a heritage clause that WRAPPED the arm in a mapped
 * type lost it entirely: `interface Row extends Readonly<MembershipCompanyWorkspace>` then
 * `row.role === 'owner'` shipped GREEN, as did `extends Pick<W, 'role' | 'name'>`, `class C
 * implements Readonly<Pick<W, 'role'>>`, and the same forms with a LOCALLY-declared
 * `type Frozen<T> = { readonly [K in keyof T]: T[K] }` (so it was never merely the `.d.ts` skip).
 * All four MEASURED green before this flag, RED after — each is a subtype of a watched arm by
 * any reading, and each needs no laundering whatsoever.
 *
 * ⚠ WHY THIS DOES NOT FLOOD. The wrapper's own alias symbol (`Readonly`, `Pick`) is collected
 * too, but it is declared in `lib.es5.d.ts` and no `.d.ts` symbol can be in the derived watched
 * set (`walkWorkspaceTypes` skips declaration files — see its docblock), so the repo's ~830
 * `Readonly<XxxProps>` sites gain nothing. Only a heritage clause naming a REAL watched arm
 * through a wrapper newly matches. MEASURED after the change: the full three-root scan still
 * reports exactly ONE real hit, the allowlisted presentation consumer.
 *
 * ⚠ THIS IS THE HERITAGE POSITION ONLY. A mapped-type wrapper at the READ SITE
 * (`(w: Readonly<MembershipCompanyWorkspace>) => w.role`), or an alias intersection over one
 * (`type Row = Readonly<W> & {…}`), is a DIFFERENT position — the matcher's own top-level
 * `candidateSymbolsOf` call, which deliberately still passes `false` — and remains a documented
 * blind spot at the top of this file. Do not read this fix as closing it.
 */
function heritageSymbolsOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol[] {
  const bases: ts.Symbol[] = [];
  for (const declaration of symbol.declarations ?? []) {
    if (!heritageBearing(declaration)) continue;
    for (const clause of declaration.heritageClauses ?? []) {
      for (const typeNode of clause.types) {
        bases.push(
          ...candidateSymbolsOf(
            checker.getTypeAtLocation(typeNode),
            /* followAliasArguments */ true
          )
        );
      }
    }
  }
  return bases;
}

/**
 * Every symbol a receiver's type can be matched by — its own candidates (see
 * `candidateSymbolsOf`) plus, TRANSITIVELY, everything its declarations inherit from.
 *
 * ⚠⚠ THE SUBTYPE HOLE THIS CLOSES WAS THE HEADLINE ONE, AND IT NEEDED NO LAUNDERING:
 *     interface ActiveWorkspaceRow extends MembershipCompanyWorkspace { readonly isActive: boolean }
 *     const canManage = (row: ActiveWorkspaceRow): boolean => row.role !== 'member';
 * declared entirely inside `apps/web`, type-checking cleanly, and a textbook ADR-1029 gate. The
 * receiver resolves to `ActiveWorkspaceRow`, a name no derivation of the shared union can ever
 * contain, so the scan shipped GREEN. Nothing walked base types. Now something does.
 *
 * Termination: TypeScript rejects circular inheritance, and `visited` makes that independent of
 * the compiler's diagnostics anyway.
 */
function matchableSymbolsOf(checker: ts.TypeChecker, type: ts.Type): ts.Symbol[] {
  const matchable: ts.Symbol[] = [];
  const visited = new Set<ts.Symbol>();
  const queue = candidateSymbolsOf(type);
  while (queue.length > 0) {
    const symbol = queue.pop();
    if (symbol === undefined || visited.has(symbol)) continue;
    visited.add(symbol);
    matchable.push(symbol);
    queue.push(...heritageSymbolsOf(checker, symbol));
  }
  return matchable;
}

/**
 * IS THIS RECEIVER A WORKSPACE? Two accept paths, tried in order, and the ORDER is the point.
 *
 * 1. SYMBOL IDENTITY against the symbols the derivation actually collected. Sound by construction
 *    — a same-named type from anywhere else is a different symbol — and it is what makes an arm
 *    declared in a SIBLING FILE of the shared module (`packages/shared/src/adv-far-arms.ts`,
 *    pulled into the exported union) matchable. MEASURED to hold today: the symbol reached from a
 *    web read site through `import … from '@balo/shared/workspaces'` is `===` the symbol the
 *    derivation reached through `packages/shared/src/workspaces/index.ts`.
 *
 * 2. NAME + DECLARATION ORIGIN, as the fallback identity cannot be trusted to survive alone. pnpm
 *    symlinks `node_modules/@balo/shared` → `packages/shared`; if TypeScript ever stopped
 *    realpathing, the two walks would meet DIFFERENT symbols for the same declaration and path 1
 *    would silently match nothing — a vacuous pass, the worst failure mode for an invariant. Name
 *    matching cannot produce a false negative, and the origin check removes the false-alarm risk
 *    the name alone carries.
 *
 * ⚠⚠ THE ORIGIN CHECK IS DERIVED, NOT HARDCODED, AND THAT IS THE F-1 FIX. It used to be
 * `declaredIn.includes('/shared/src/workspaces/')` — a path substring that threw away any arm
 * declared OUTSIDE that one directory even when the derivation had correctly put it in the
 * watched set. A sibling-file arm on the exported union was therefore derived and then discarded,
 * and a real gate on it shipped green. The confirmation now compares against the origins the
 * derivation RECORDED (`originOf`), so it is exactly as wide as the union really is and no
 * wider. (Superseded ruling: `.implement/rulings-bal-507.md` Q4 told a future author to relax the
 * substring to `.includes('workspaces/index.ts')`; that would have made F-1 strictly worse.)
 */
function workspaceTypeNameOf(
  checker: ts.TypeChecker,
  type: ts.Type,
  watched: WatchedTypes
): string | null {
  for (const symbol of matchableSymbolsOf(checker, type)) {
    if (watched.symbols.has(symbol)) return symbol.getName();
    if (!watched.names.has(symbol.getName())) continue;
    const declaredIn = symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
    // Confirm it is OUR type, not a same-named type from somewhere else.
    if (watched.origins.has(originOf(declaredIn))) return symbol.getName();
  }
  return null;
}

/**
 * Every symbol whose NAME the matcher above could compare against the watched set — the alias
 * names, hoisted before the union/intersection recursion, plus each constituent's own symbol.
 *
 * ⚠ ONE FUNCTION, TWO CALLERS, AND THAT IS LOAD-BEARING. `deriveWatchedTypes` collects the
 * watched symbols and NAMES with this same function, so the set can never drift BELOW what the
 * matcher is able to see: whatever shape the union takes, the names produced here on the way IN
 * are the names compared here on the way OUT. Extracted (rather than a second copy) for that
 * reason first, and because `npx jscpd` would flag the duplicate second (SonarCloud's new-code
 * duplication gate is <3%).
 *
 * ⚠ THE ONE ASYMMETRY, AND IT IS DELIBERATE (do not "align" it away): the DERIVATION passes
 * `followAliasArguments: true`, the matcher does not. So the derived set is a SUPERSET of what
 * the matcher can produce — safe in the only direction that matters, because a watched name the
 * matcher can never emit is dead weight, whereas an unwatched arm is a fail-open. Turning the
 * flag on for the matcher would ALSO close the read-site mapped-type blind spot documented at the
 * top of this file; that is a separate, deliberately deferred change, not an oversight here.
 */
function candidateSymbolsOf(type: ts.Type, followAliasArguments = false): ts.Symbol[] {
  const seen: ts.Symbol[] = [];
  // `visited` guards the RECURSION; `seen` remains only a results accumulator. The guard arrived
  // with the alias-argument recursion below — a self-referential generic alias would otherwise
  // not terminate. It can never cause a MISS: a type reached a second time has already
  // contributed every symbol it can.
  const visited = new Set<ts.Type>();
  const collect = (t: ts.Type): void => {
    if (visited.has(t)) return;
    visited.add(t);
    // ⚠ The alias name is pushed BEFORE the union/intersection recursion, not after and not via
    // a `??` fallback. An arm declared as an INTERSECTION alias
    // (`export type AgencyWorkspace = CompanyWorkspaceBase & {…}`) has `aliasSymbol` set and
    // `isIntersection() === true`; recursing first dissolves it into constituents and loses the
    // name, so the scan missed such a receiver even with its name IN the watched set
    // (measured, BAL-507 fix round). Interfaces remain the convention; this makes the alias form
    // safe rather than silently fail-open.
    if (t.aliasSymbol !== undefined) seen.push(t.aliasSymbol);
    // MAPPED-TYPE UNION ARM - DERIVATION ONLY (`followAliasArguments`), and the asymmetry is
    // deliberate. `export type Workspace = ... | Readonly<AgencyOwnerArm>` used to lose the arm
    // ENTIRELY: that constituent's alias symbol is `Readonly`, its type ARGUMENTS were never
    // walked, and `AgencyOwnerArm` therefore never entered the watched set - one union edit
    // blinding the scan to that whole arm EVERYWHERE, which is materially worse than the
    // read-site mapped-type wrapper documented in KNOWN BLIND SPOTS. Recursing here closes the
    // union-arm form. The READ-SITE wrapper (`(w: Readonly<MembershipCompanyWorkspace>) => w.role`)
    // is deliberately left alone and stays documented as a blind spot: this flag is OFF for the
    // matcher's caller, so nothing about read-site resolution changes.
    if (followAliasArguments) {
      for (const argument of t.aliasTypeArguments ?? []) collect(argument);
    }
    if (t.isUnion() || t.isIntersection()) {
      t.types.forEach(collect);
      return;
    }
    // ⚠ THE SYMBOL IS READ HERE, ABOVE THE `isTypeParameter()` GUARD, ON PURPOSE — ORDER, NOT
    // STYLE. `ts.TypeParameter` declares no members beyond `ts.Type`, so `ts.Type` is assignable
    // to it and the FALSE branch of that `this is TypeParameter` predicate narrows `t` to
    // `never`; a `t.getSymbol()` placed after the guard is a hard TS2339 and fails
    // `pnpm --filter web check-types`. (`isUnion()` / `isIntersection()` above do not have this
    // problem — `UnionType` adds `types`, so `ts.Type` is not assignable to it.)
    const symbol = t.getSymbol();
    // A GENERIC receiver — `<T extends MembershipCompanyWorkspace>(w: T) => w.role` — resolves to
    // the type PARAMETER, not to the arm, so the name match below would miss it. Unlike the
    // spread / mapped-type blind spots documented at the top of this file, writing a generic
    // helper over workspaces is NOT laundering — someone can do it without ever intending to
    // launder — so this direction must not fail open. Walk to the constraint and match there, and
    // do NOT fall through to the symbol push: a type parameter's own symbol is `T`, never an arm.
    // Termination: an unconstrained `<T>` yields `undefined`, and so does a CIRCULAR constraint
    // (`<T extends T>`, `<P extends Q, Q extends R, R extends P>`) — TypeScript rejects those and
    // hands back no constraint. Both verified empirically (BAL-507 review round). `visited` above
    // makes termination unconditional; this walk never depended on it before and still does not.
    if (t.isTypeParameter()) {
      const constraint = t.getConstraint();
      if (constraint !== undefined) collect(constraint);
      return;
    }
    if (symbol !== undefined) seen.push(symbol);
  };
  collect(type);
  return seen;
}

interface Hit {
  readonly file: string;
  readonly kind: HitKind;
  readonly typeName: string;
  readonly line: number;
}

/** The checker plus THE DERIVED WATCHED SET — passed together so no call site can accidentally
 *  scan against a stale or hand-written set. */
interface ScanContext {
  readonly checker: ts.TypeChecker;
  readonly watched: WatchedTypes;
}

function walkSourceFile(
  sourceFile: ts.SourceFile,
  rel: string,
  context: ScanContext,
  hits: Hit[]
): void {
  const visit = (node: ts.Node): void => {
    const found = receiverFor(node, context.checker);
    if (found !== null) {
      const type = context.checker.getTypeAtLocation(found.receiver);
      const typeName = workspaceTypeNameOf(context.checker, type, context.watched);
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
 * hit today…") asserts the EXACT, UN-DEDUPED list of real hits, so a new legitimate read turns
 * THAT test red regardless of this allowlist. A new read must be added THERE too. Two edits, both
 * reviewed — deliberately.
 *
 * ⚠⚠ THAT CLAIM WAS FALSE UNTIL THE BAL-507 FIX ROUND, AND THIS IS THE CORRECTION. The pin used
 * to dedupe hits to `${file}:${kind}`, dropping the line — so a SECOND read of an
 * already-present kind inside an already-present file collapsed into the first and was invisible.
 * A real capability-shaped helper appended to `workspace-presentation.ts` (this list's only
 * entry) and called as a gate from a non-allowlisted file therefore passed BOTH tests: the read
 * lives in an allowlisted file, and the pin deduped it away. The pin no longer dedupes. What this
 * allowlist means is unchanged — a listed file may be read from freely only in the sense that
 * THIS suite's ADR-1029 banner will not fire; the pin still counts every read, and a helper
 * exported from a listed file and used as a gate elsewhere is still an ADR-1029 violation that a
 * human reviewer must catch. No compiler check can tell a subtitle from a gate.
 *
 * ⚠ `packages/shared/src/workspaces/index.ts` — the derive/build site — is deliberately NOT
 * listed, and re-adding it "for symmetry" is a mistake. That file CONSTRUCTS the role
 * (`role: entry.role`, off `MembershipCompanyInput`) and never READS one off a Workspace:
 * construction is an object-literal property assignment, which `receiverFor` does not match, so
 * the file scans CLEAN today — the reality pin's exact-set assertion is the proof.
 * `projectActiveWorkspace` is the one place that holds a value narrowed to
 * `MembershipCompanyWorkspace` and could read `active.role`; it deliberately routes through
 * `roleForCompany(active.companyId, roleByCompanyId)` instead. Pre-listing a file for a read
 * that does not exist would pre-authorize that future read unreviewed, and would downgrade its
 * failure from THE INVARIANT's ADR-1029 banner to the reality pin's bare set diff. If such a
 * read is ever genuinely wanted, add the entry THEN, in the PR that introduces it.
 */
const ALLOWLIST: readonly string[] = [
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
/** THE set the scan actually consults. Derived in `beforeAll`; a failed derivation THROWS there,
 *  taking every test in this file red rather than scanning with nothing. */
let watchedTypes: WatchedTypes;
let watchedTypeNames: ReadonlySet<string>;

beforeAll(() => {
  // Fail closed BEFORE anything is scanned: a real file at a probe path makes every hit below
  // untrustworthy (see `assertProbePathsAreVirtual`).
  assertProbePathsAreVirtual();
  program = buildProgram();
  const checker = program.getTypeChecker();
  watchedTypes = deriveWatchedTypes(checker, sharedWorkspacesSourceFile());
  watchedTypeNames = watchedTypes.names;
  const context: ScanContext = { checker, watched: watchedTypes };
  const relByAbsolute = new Map<string, string>([
    ...TARGETS.map((t): [string, string] => [t.absolute, t.rel]),
    [PROBE_ABS, PROBE_REL],
    [GENERIC_PROBE_ABS, GENERIC_PROBE_REL],
    [SUBTYPE_PROBE_ABS, SUBTYPE_PROBE_REL],
    [KEY_PROBE_ABS, KEY_PROBE_REL],
    [MAPPED_HERITAGE_PROBE_ABS, MAPPED_HERITAGE_PROBE_REL],
  ]);
  realFileRelPaths = new Set(TARGETS.map((t) => t.rel));

  const hits: Hit[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    const rel = relByAbsolute.get(path.normalize(sourceFile.fileName));
    if (rel === undefined) continue; // skip the ~3400 .d.ts files pulled into the closure
    walkSourceFile(sourceFile, rel, context, hits);
  }
  allHits = hits;
}, 180_000);

/**
 * Resolve `packages/shared/src/workspaces/index.ts` out of the already-built program — the ONE
 * ground-truth source both F-4 tests below read. Extracted rather than repeated: the two callers
 * were byte-identical for six lines, which `npx jscpd` flags as a clone (SonarCloud's new-code
 * duplication gate is <3%). Both `expect`s are retained here, so a missing target or a file that
 * never made it into the program still fails as an assertion, not just as a throw.
 */
function sharedWorkspacesSourceFile(): ts.SourceFile {
  const target = TARGETS.find((t) => t.rel === SHARED_INDEX_REL);
  expect(target, `scan target missing: ${SHARED_INDEX_REL}`).not.toBeUndefined();
  const sourceFile = target === undefined ? undefined : program.getSourceFile(target.absolute);
  expect(sourceFile, `not in the program: ${SHARED_INDEX_REL}`).not.toBeUndefined();
  if (sourceFile === undefined) throw new Error(`not in the program: ${SHARED_INDEX_REL}`);
  return sourceFile;
}

function violationsAmong(hits: readonly Hit[]): Hit[] {
  return hits.filter((h) => !ALLOWLIST.includes(h.file));
}

/**
 * Run the REAL `deriveWatchedTypes` over a synthetic in-memory module (plus optional siblings).
 *
 * ⚠ WHY A SECOND, TINY PROGRAM RATHER THAN AN OVERLAY ON THE MAIN ONE. The derivation must be
 * exercised against unions this repo does NOT have — a non-exported arm, a collapsed union, a
 * dragged-in `*Pointer` — and the main program's shared module is the real one. `noLib: true` plus
 * a single in-memory file makes each of these programs essentially free (no `.d.ts` closure), so
 * the fail-closed behaviour is proven on EVERY run rather than by a one-time manual mutation.
 * The function under test is the same one `beforeAll` uses — no parallel implementation.
 */
/** A `<package>/src/`-rooted home for the synthetic modules, so `originOf` yields realistic
 *  PACKAGE-QUALIFIED origins (`__synthetic__/src/__synthetic_workspace_union__.ts`) rather than a
 *  bare `apps/web/…` path. Nothing is written to disk — the CompilerHost below serves these
 *  files from memory only. */
const SYNTHETIC_SRC = path.join(WEB_ROOT, '__synthetic__', 'src');

function derivedTypesFromSyntheticModule(
  source: string,
  siblings: Readonly<Record<string, string>> = {}
): WatchedTypes {
  const fileName = path.join(SYNTHETIC_SRC, '__synthetic_workspace_union__.ts');
  const files = new Map<string, string>([
    [fileName, source],
    ...Object.entries(siblings).map(([name, text]): [string, string] => [
      path.join(SYNTHETIC_SRC, name),
      text,
    ]),
  ]);
  const parsedFiles = new Map<string, ts.SourceFile>(
    [...files].map(([name, text]): [string, ts.SourceFile] => [
      name,
      ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true),
    ])
  );
  const host: ts.CompilerHost = {
    getSourceFile: (f) => parsedFiles.get(f),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => WEB_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
  };
  const synthetic = ts.createProgram({
    rootNames: [...files.keys()],
    options: { noEmit: true, noLib: true },
    host,
  });
  const parsed = synthetic.getSourceFile(fileName);
  if (parsed === undefined) throw new Error('synthetic module did not enter its own program');
  return deriveWatchedTypes(synthetic.getTypeChecker(), parsed);
}

function derivedNamesFromSyntheticModule(
  source: string,
  siblings: Readonly<Record<string, string>> = {}
): ReadonlySet<string> {
  return derivedTypesFromSyntheticModule(source, siblings).names;
}

/** The five declarations every synthetic union below is built from. Kept as one string so each
 *  scenario differs ONLY in its `Workspace` line — the variable under test. */
const SYNTHETIC_ARMS = [
  "export type CompanyMemberRole = 'owner' | 'admin' | 'member';",
  "interface CompanyWorkspaceBase { readonly type: 'company'; readonly key: string }",
  "export interface ExpertWorkspace { readonly type: 'expert'; readonly key: 'expert' }",
  'export interface MembershipCompanyWorkspace extends CompanyWorkspaceBase {',
  "  readonly via: 'membership'; readonly role: CompanyMemberRole }",
  'export interface RepresentationCompanyWorkspace extends CompanyWorkspaceBase {',
  "  readonly via: 'representation' }",
  'export type CompanyWorkspace = MembershipCompanyWorkspace | RepresentationCompanyWorkspace;',
  "export interface ActiveWorkspacePointer { readonly type: 'expert'; readonly key: string }",
].join('\n');

function syntheticModule(...extra: readonly string[]): string {
  return [SYNTHETIC_ARMS, ...extra].join('\n');
}

const WORKSPACE_MODULE_SPECIFIER = '@balo/shared/workspaces';

/**
 * Every `<group>/<package>/src` directory in the monorepo that this suite does NOT scan.
 *
 * Used by the F-6 pin below: the scan roots are a LIST, and a list is only as good as the
 * assertion that nothing outside it can see a `Workspace`. Returns absolute paths; a package with
 * no `src` (or a group that does not exist) contributes nothing.
 */
function unscannedPackageSourceRoots(): string[] {
  const scanned = new Set(SCAN_ROOTS.map((root) => root.dir));
  const roots: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = REPO_ROOT === '' ? '' : path.join(REPO_ROOT, group);
    if (groupDir === '' || !existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const dir = path.join(groupDir, entry.name, 'src');
      if (!entry.isDirectory() || scanned.has(dir) || !existsSync(dir)) continue;
      roots.push(dir);
    }
  }
  return roots;
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

  it('guards the guard: the matcher sees through a GENERIC receiver (property access)', () => {
    expect(allHits).toContainEqual(
      expect.objectContaining({ file: GENERIC_PROBE_REL, kind: 'access' })
    );
  });

  it('guards the guard: the matcher sees through a GENERIC receiver (destructuring)', () => {
    expect(allHits).toContainEqual(
      expect.objectContaining({ file: GENERIC_PROBE_REL, kind: 'destructure' })
    );
  });

  it('guards the guard (F-3): the matcher sees a SUBTYPE declared with `extends`', () => {
    // `interface ActiveWorkspaceRow extends MembershipCompanyWorkspace { … }` declared inside
    // `apps/web`, then `row.role` used as a gate. No laundering, type-checks cleanly, and the
    // receiver's own name is one no derivation of the shared union can ever contain — so nothing
    // but a base-type walk can catch it.
    expect(allHits).toContainEqual(
      expect.objectContaining({ file: SUBTYPE_PROBE_REL, kind: 'access' })
    );
  });

  it('guards the guard (F-3): the matcher sees a class declared with `implements`', () => {
    // The variant `checker.getBaseTypes` cannot answer for — a class has no BASE TYPE here, only
    // an implements clause — which is why this suite reads heritage clauses instead.
    expect(allHits).toContainEqual(
      expect.objectContaining({ file: SUBTYPE_PROBE_REL, kind: 'destructure' })
    );
  });

  it('guards the guard (F-3): the matcher sees a subtype whose HERITAGE CLAUSE wraps the arm in a mapped type', () => {
    // `interface FrozenWorkspaceRow extends Readonly<MembershipCompanyWorkspace>`, then
    // `row.role`. A subtype of a watched arm by any reading, no laundering, and GREEN until
    // `heritageSymbolsOf` was given `followAliasArguments` (MEASURED both ways). Without this
    // pin the "CLOSED IN THE BAL-507 FIX ROUND" claim about F-3 subtypes is simply false.
    expect(allHits).toContainEqual(
      expect.objectContaining({ file: MAPPED_HERITAGE_PROBE_REL, kind: 'access' })
    );
  });

  it('guards the guard (F-3): the matcher sees a class that IMPLEMENTS a mapped-type wrapper', () => {
    // `class PickedWorkspaceRow implements Pick<MembershipCompanyWorkspace, 'role'>` — the
    // `Pick<>`-narrowed variant of the same hole, in the clause form `getBaseTypes` cannot see.
    // Both hits are pinned as an exact list so a future change cannot close one by breaking the
    // other, and so the wrapper cannot start matching MORE than these two reads.
    const heritageHits = allHits.filter((h) => h.file === MAPPED_HERITAGE_PROBE_REL);
    expect(heritageHits.map((h) => h.kind)).toEqual(['access', 'destructure']);
  });

  it('guards the guard (F-4): the matcher sees a CONST-TYPED element-access key', () => {
    // `const ROLE_FIELD = 'role' as const; w[ROLE_FIELD]` — what a "hoist the field name to a
    // constant" refactor produces. Three of the four reads in that probe are `role` reads
    // (const-typed key, plain literal, template literal); the other two — a const-typed key
    // naming a DIFFERENT field, and a `string`-typed key — must NOT be hits, which the exact
    // count below pins. Without that negative control, "ask the checker" could degenerate into
    // "every element access is a role read".
    const keyHits = allHits.filter((h) => h.file === KEY_PROBE_REL);
    expect(keyHits.map((h) => h.kind)).toEqual(['element', 'element', 'element']);
  });

  it('guards the guard: no probe path exists on disk — the overlays cannot shadow real source', () => {
    // A real file at a probe path is served to the compiler as PROBE text while the scan reports
    // its hits against the REAL file, at lines that do not exist there (MEASURED: an innocent
    // two-line module produced two phantom violations). `beforeAll` throws on it; this states the
    // property explicitly so the guard cannot be deleted as mysterious.
    expect(shadowedProbePaths()).toEqual([]);
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
    // ⚠⚠ NO DEDUPE, AND THE DEDUPE THAT USED TO BE HERE WAS A HOLE RATHER THAN A TIDY-UP. It
    // keyed hits by `${file}:${kind}` and DROPPED THE LINE, so a SECOND read of an
    // already-present kind in an already-present file collapsed into the first and vanished.
    // MEASURED: appending a real capability-shaped helper to the ALLOWLISTED
    // `workspace-presentation.ts` (`canManageBillingForWorkspace(w) { const { role } = w; … }`)
    // and calling it as a gate from a non-allowlisted file passed BOTH this pin and THE
    // INVARIANT. Asserting the RAW list closes it: that second read makes this list two entries
    // long.
    //
    // The LINE is deliberately not asserted — it would go red on any unrelated edit that shifted
    // `workspace-presentation.ts`, and the count is what carries the property. The list is sorted
    // so the assertion cannot depend on `program.getSourceFiles()` ordering.
    const realHits = allHits.filter((h) => realFileRelPaths.has(h.file));
    const rendered = [...realHits]
      .sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line)
      .map((h) => ({ file: h.file, kind: h.kind }));
    expect(rendered).toEqual([
      { file: 'apps/web/src/components/layout/workspace-presentation.ts', kind: 'destructure' },
    ]);
  });

  it('decoy pin: derive-workspaces.ts reads MembershipCompanyInput.role, not a Workspace — the scan is TYPED, not textual', () => {
    const realHits = allHits.filter((h) => realFileRelPaths.has(h.file));
    expect(realHits.some((h) => h.file.endsWith('lib/workspaces/derive-workspaces.ts'))).toBe(
      false
    );
  });

  it('the watched set is DERIVED from the exported `Workspace` union, not hand-maintained', () => {
    // The floor, asserted against the set the scan ACTUALLY consults. `Workspace` and
    // `CompanyWorkspace` are alias names a receiver can be declared with, so they are watched
    // names in their own right, not merely waypoints.
    // MEASURED as of this change, by printing `watchedTypeNames` from this test: the real module
    // derives EXACTLY these five and nothing else — no `CompanyWorkspaceBase`, no
    // `CompanyMemberRole`, no `*Pointer` — i.e. byte-for-byte the set the deleted hand-maintained
    // literal held, so this change alters the MECHANISM and not today's coverage. That exact set
    // is recorded here as a fact, NOT asserted as one: an `toEqual` here would go red the moment
    // an arm is added, which is precisely the human step this change removes.
    for (const name of REQUIRED_DERIVED_NAMES) {
      expect(watchedTypeNames.has(name), `derived watched set is missing '${name}'`).toBe(true);
    }
    // The cookie projection carries no `role` and must stay UNWATCHED.
    expect([...watchedTypeNames].filter((n) => n.endsWith('Pointer'))).toEqual([]);
  });

  it('THE MECHANISM: a NON-EXPORTED arm on the exported union IS watched, with no edit to this suite', () => {
    // The case two adversarial rounds defeated the old name-based walk with. `AgencyOwnerArm` is
    // never exported under its own name — the UNION is — so no walk over export declarations can
    // ever see it, while `(w: Workspace) => w.via === 'agency' && w.role === 'owner'` is a real,
    // fully-typed ADR-1029 gate. Union reachability sees it; nothing here is hand-maintained.
    const names = derivedNamesFromSyntheticModule(
      syntheticModule(
        'interface AgencyOwnerArm extends CompanyWorkspaceBase {',
        "  readonly via: 'agency'; readonly role: CompanyMemberRole }",
        'export type Workspace = ExpertWorkspace | CompanyWorkspace | AgencyOwnerArm;'
      )
    );
    expect(names.has('AgencyOwnerArm')).toBe(true);
    // …and the intermediate alias TypeScript's union flattening drops is still present.
    expect(names.has('CompanyWorkspace')).toBe(true);
  });

  it('THE MECHANISM: an arm written as a non-exported INTERSECTION ALIAS is watched too', () => {
    const names = derivedNamesFromSyntheticModule(
      syntheticModule(
        "type AgencyArm = CompanyWorkspaceBase & { readonly via: 'agency';",
        '  readonly role: CompanyMemberRole };',
        'export type Workspace = ExpertWorkspace | CompanyWorkspace | AgencyArm;'
      )
    );
    expect(names.has('AgencyArm')).toBe(true);
    // The spine walk must not wander into a member's type: `CompanyMemberRole` is a string union,
    // no receiver reads `.role` off it, and watching it would be noise, not coverage.
    expect(names.has('CompanyMemberRole')).toBe(false);
  });

  it('THE MECHANISM (F-1): an arm declared in a SIBLING FILE of the shared module is watched', () => {
    // The arm is fully public (the UNION is exported) and correctly lands in the derived set —
    // but the matcher used to confirm the receiver with a hardcoded `'/shared/src/workspaces/'`
    // path substring and threw it away again, so a real gate on it shipped GREEN. The origin
    // check is now derived from where the arms ACTUALLY live.
    const watched = derivedTypesFromSyntheticModule(
      syntheticModule(
        "import type { AgencyOwnerArm } from './adv-far-arms';",
        'export type Workspace = ExpertWorkspace | CompanyWorkspace | AgencyOwnerArm;'
      ),
      {
        'adv-far-arms.ts': [
          'export interface AgencyOwnerArm {',
          "  readonly type: 'company'; readonly key: string;",
          "  readonly via: 'agency'; readonly role: 'owner' | 'admin' | 'member' }",
        ].join('\n'),
      }
    );
    expect(watched.names.has('AgencyOwnerArm')).toBe(true);
    // …and — the half the old path substring destroyed — the SIBLING FILE is a recorded origin,
    // so the matcher will confirm a receiver declared there instead of discarding it.
    // The origins are PACKAGE-QUALIFIED (`<package>/src/…`), which is what stops a same-named
    // type in a DIFFERENT package being confirmed as ours — see `originOf`.
    expect([...watched.origins].sort()).toEqual([
      '__synthetic__/src/__synthetic_workspace_union__.ts',
      '__synthetic__/src/adv-far-arms.ts',
    ]);
  });

  it('THE MECHANISM (F-2): a MAPPED-TYPE union arm is watched — the wrapper does not blind the scan', () => {
    // `export type Workspace = … | Readonly<AgencyOwnerArm>` (spelled `Frozen<>` here because the
    // synthetic programs run `noLib`, so the global `Readonly` does not exist). The constituent's
    // alias symbol is the WRAPPER; without recursing its type ARGUMENTS the arm never enters the
    // set at all, and one union edit blinds the scan to that whole arm everywhere.
    const names = derivedNamesFromSyntheticModule(
      syntheticModule(
        'type Frozen<T> = { readonly [K in keyof T]: T[K] };',
        'interface AgencyOwnerArm extends CompanyWorkspaceBase {',
        "  readonly via: 'agency'; readonly role: CompanyMemberRole }",
        'export type Workspace = ExpertWorkspace | CompanyWorkspace | Frozen<AgencyOwnerArm>;'
      )
    );
    expect(names.has('AgencyOwnerArm')).toBe(true);
  });

  it('FAILS CLOSED: no exported `Workspace` symbol at all', () => {
    expect(() => derivedNamesFromSyntheticModule(syntheticModule())).toThrow(
      /no exported `Workspace` symbol/
    );
  });

  it('FAILS CLOSED: `Workspace` resolves to something that is not a union', () => {
    expect(() =>
      derivedNamesFromSyntheticModule(syntheticModule('export type Workspace = ExpertWorkspace;'))
    ).toThrow(/NON-UNION type/);
  });

  it('FAILS CLOSED: the derived set is missing a known arm', () => {
    // A union that no longer reaches `RepresentationCompanyWorkspace` — the shape a rename or a
    // half-finished refactor produces, and the shape that would otherwise quietly shrink coverage.
    expect(() =>
      derivedNamesFromSyntheticModule(
        syntheticModule('export type Workspace = ExpertWorkspace | MembershipCompanyWorkspace;')
      )
    ).toThrow(/missing CompanyWorkspace, RepresentationCompanyWorkspace/);
  });

  it('FAILS CLOSED: a `*Pointer` type dragged into the union', () => {
    expect(() =>
      derivedNamesFromSyntheticModule(
        syntheticModule(
          'export type Workspace = ExpertWorkspace | CompanyWorkspace | ActiveWorkspacePointer;'
        )
      )
    ).toThrow(/must stay UNWATCHED/);
  });

  it('guards the guard: the synthetic derivation harness is not vacuous', () => {
    // The positive control for the four FAILS CLOSED tests above: the SAME harness, on a union
    // shaped like the real one, derives cleanly and returns exactly the five expected names — so
    // those `toThrow`s are failing for the reason claimed, not because the harness throws on
    // everything.
    const names = derivedNamesFromSyntheticModule(
      syntheticModule('export type Workspace = ExpertWorkspace | CompanyWorkspace;')
    );
    expect([...names].sort()).toEqual([...REQUIRED_DERIVED_NAMES].sort());
  });

  it('guards the guard (F-4): the ground-truth walk sees DEFERRED exports, not just inline modifiers', () => {
    // Fixed in the BAL-507 review round. The pre-fix walk read ONLY the inline export modifier,
    // so every `export type { X }` form below returned NOTHING and a real arm could sit outside
    // the watched set with the F-4 pin still green. This synthetic module is parsed with the
    // same compiler API the real walk uses, so the forms are exercised on EVERY run rather than
    // by a one-time manual mutation.
    const synthetic = ts.createSourceFile(
      'synthetic-workspaces-index.ts',
      [
        'export interface InlineWorkspace { readonly a: 1 }',
        'interface DeferredWorkspace { readonly b: 2 }',
        'export type { DeferredWorkspace };', // deferred, `export type`
        'interface ValueFormWorkspace { readonly c: 3 }',
        'export { ValueFormWorkspace };', // deferred, no `type` keyword
        'type MultiOneWorkspace = { readonly d: 4 };',
        'type MultiTwoWorkspace = { readonly e: 5 };',
        'export type { MultiOneWorkspace, MultiTwoWorkspace };', // multiple specifiers
        'interface AliasSourceArm { readonly f: 6 }',
        'export type { AliasSourceArm as AliasedWorkspace };', // alias → DECLARED name wins
        'interface NeverExportedWorkspace { readonly g: 7 }', // declared, never exported
        'export interface SomeWorkspacePointer { readonly h: 8 }', // `Pointer`, not in-family
        'const shadowWorkspace = 1;',
        'export { shadowWorkspace };', // a VALUE, not a type — must not be collected
        // Module-specifier re-export: the NAME is collected (fail-closed), but nothing is
        // resolved through the specifier — see the F-4 blind-spots note above.
        "export type { SidecarWorkspace } from './sidecar';",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true
    );

    expect([...exportedWorkspaceTypeNames(synthetic)].sort()).toEqual([
      'AliasSourceArm', // NOT 'AliasedWorkspace' — the scan matches the declared name
      'DeferredWorkspace',
      'InlineWorkspace',
      'MultiOneWorkspace',
      'MultiTwoWorkspace',
      'SidecarWorkspace', // re-exported through a module specifier — name only, unresolved
      'ValueFormWorkspace',
    ]);
    // Explicit negatives, so a future loosening of the filter cannot pass silently.
    expect(exportedWorkspaceTypeNames(synthetic)).not.toContain('NeverExportedWorkspace');
    expect(exportedWorkspaceTypeNames(synthetic)).not.toContain('SomeWorkspacePointer');
    expect(exportedWorkspaceTypeNames(synthetic)).not.toContain('shadowWorkspace');
  });

  it('guards the guard (F-4): the pointer types in the real shared module are NOT in-family', () => {
    // Regression pin for the name filter. `ExpertWorkspacePointer` / `CompanyWorkspacePointer` /
    // `ActiveWorkspacePointer` are the cookie projection and carry no `role`; pulling them into
    // the derived watched set would be a regression, not extra coverage.
    const declaredNames = exportedWorkspaceTypeNames(sharedWorkspacesSourceFile());
    expect(declaredNames).toContain('MembershipCompanyWorkspace'); // not vacuous
    expect(declaredNames.filter((n) => n.endsWith('Pointer'))).toEqual([]);
    expect(watchedTypeNames.has('ActiveWorkspacePointer')).toBe(false);
  });

  it('F-4 cross-check: every exported *Workspace type in the shared module is REACHABLE from the `Workspace` union', () => {
    // Two independent ground truths — name-family membership (this walk) and union reachability
    // (the derived watched set) — asserted to agree in the ⊆ direction. A divergence means an
    // exported workspace-SHAPED type sits outside the union, where the scan cannot see a `.role`
    // gate on it. The two legal remedies are: add it to the `Workspace` union, or name it out of
    // the `*Workspace` family. Editing this suite is NOT one of them.
    const declaredNames = exportedWorkspaceTypeNames(sharedWorkspacesSourceFile());
    // guards the guard: the walk itself must find something, or this test would pass vacuously.
    expect(declaredNames.length).toBeGreaterThan(0);
    for (const name of declaredNames) {
      expect(
        watchedTypeNames.has(name),
        `exported \`${name}\` is not reachable from the \`${WORKSPACE_UNION_EXPORT}\` union`
      ).toBe(true);
    }
  });
});

describe('scan coverage — which files and which trees (ADR-1029 / BAL-507)', () => {
  it('F-5: a production path is NOT misclassified as test support', () => {
    // The three shapes the previous substring/any-depth predicate silently unscanned, each of
    // which can carry a live ADR-1029 gate. None exists on disk today; all three are pinned so
    // they cannot silently drop out again.
    expect(isScannableProductionSource('app/(dashboard)/test/page.tsx', ['test/'])).toBe(true);
    expect(isScannableProductionSource('lib/workspaces/seed.spec.helpers.ts', ['test/'])).toBe(
      true
    );
    expect(isScannableProductionSource('lib/fixtures/workspaces.ts', ['test/'])).toBe(true);
  });

  it('F-5: real test support is still excluded', () => {
    // The other direction, and it matters just as much: `src/test/fixtures/workspaces.ts` builds
    // `MembershipCompanyWorkspace` values on purpose, and scanning it would flood this suite with
    // hits that are not gates.
    expect(isScannableProductionSource('test/fixtures/workspaces.ts', ['test/'])).toBe(false);
    expect(isScannableProductionSource('test/utils.tsx', ['test/'])).toBe(false);
    expect(isScannableProductionSource('testing/strip-comments.ts', ['testing/'])).toBe(false);
    expect(isScannableProductionSource('lib/workspaces/derive.test.ts', ['test/'])).toBe(false);
    expect(isScannableProductionSource('components/workspace.spec.tsx', ['test/'])).toBe(false);
  });

  it('F-5: the exclusion is by ROOT-RELATIVE prefix, so nothing under it is scanned', () => {
    expect(TARGETS.filter((t) => t.rel.startsWith('apps/web/src/test/'))).toEqual([]);
    expect(TARGETS.filter((t) => t.rel.startsWith('packages/shared/src/testing/'))).toEqual([]);
    // …and the guard is not vacuous: those directories DO exist and DO hold source files.
    expect(existsSync(path.join(WEB_SRC, 'test', 'fixtures'))).toBe(true);
  });

  it('F-5: `targetsUnder` routes EVERY decision through the predicate', () => {
    // ⚠ THE WIRING, NOT THE RULE — the two pins above test `isScannableProductionSource` in
    // isolation, and a `targetsUnder` that stopped calling it would leave them green. There is no
    // file on disk today with any of the three misclassified SHAPES, so nothing about the real
    // TARGETS can discriminate. This can: with NO test-only directories declared, the walk must
    // admit everything under the root that is not NAMED like a test file — including
    // `test/fixtures/workspaces.ts`, which the previous substring / any-depth-directory predicate
    // dropped no matter what a root asked for. (MUTATION-VERIFIED: restoring that predicate in
    // `targetsUnder` turns this red and leaves the two rule pins green.)
    const admitted = targetsUnder({ dir: WEB_SRC, relPrefix: 'probe', testOnlyDirs: [] }).map(
      (t) => t.rel
    );
    expect(admitted).toContain('probe/test/fixtures/workspaces.ts');
    expect(admitted).not.toContain('probe/test/contains-email-address.test.ts');
  });

  it('F-6: `packages/analytics/src` is a scan root — it already imports the `Workspace` union', () => {
    expect(ANALYTICS_SRC).not.toBe('');
    const analyticsTargets = TARGETS.filter((t) => t.rel.startsWith('packages/analytics/src/'));
    expect(analyticsTargets.length).toBeGreaterThan(0);
    expect(analyticsTargets.map((t) => t.rel)).toContain(
      'packages/analytics/src/events/workspace.ts'
    );
  });

  it('F-6: no UNSCANNED package imports the workspace module', () => {
    // The scan roots are a LIST, and a list is only as good as the assertion that nothing outside
    // it can see a `Workspace`. `apps/api` does not import the module today; the day it does,
    // this goes red and the remedy is to ADD THE ROOT, never to edit this expectation.
    //
    // ⚠ Comment-stripped source, so a docblock that merely NAMES the module is not an alarm; and
    // it is a static-specifier text check, so a dynamically-assembled specifier would slip — that
    // is laundering, and it is listed in KNOWN BLIND SPOTS.
    //
    // ⚠⚠ THE NON-VACUITY GUARD IS `> 0`, NOT AN EXACT COUNT, AND THAT IS A FIX RATHER THAN A
    // LOOSENING. It read `toBe(3)`, which turned this ADR-1029 invariant RED for a reason with
    // nothing to do with ADR-1029: MEASURED — `mkdir -p packages/zz-temp-pkg/src` alone produced
    // `no unscanned package roots found — this pin would be vacuous: expected 4 to be 3`, a
    // message that actively misdirects (roots WERE found; there were simply four of them). The
    // property this pin carries is "no UNSCANNED package imports the workspace module". The
    // COUNT of unscanned packages is not that property, and adding a package is routine work
    // this suite must stay silent about. `> 0` is exactly the non-vacuity the exact count was
    // standing in for: it rules out the walk coming back EMPTY and the real assertion below
    // passing over nothing.
    const roots = unscannedPackageSourceRoots();
    expect(
      roots.length,
      'no unscanned package roots found — the import check below would be vacuous'
    ).toBeGreaterThan(0);
    const importers = roots.flatMap((dir) =>
      scanRouteSources(dir, '', [])
        .filter((f) => f.code.includes(WORKSPACE_MODULE_SPECIFIER))
        .map((f) => `${path.basename(path.dirname(dir))}/src/${f.rel}`)
    );
    expect(
      importers,
      `these packages import ${WORKSPACE_MODULE_SPECIFIER} but are NOT scanned by this ` +
        `invariant — add the package's \`src\` to SCAN_ROOTS:\n${importers.join('\n')}`
    ).toEqual([]);
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
