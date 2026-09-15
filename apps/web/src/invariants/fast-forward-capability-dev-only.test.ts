import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-275 §9.2 (N9) — structural invariant: the platform capability token
 * `FAST_FORWARD_REQUEST` (`packages/shared/src/authz/platform.ts`) is named by EXACTLY TWO
 * non-test files in the WHOLE MONOREPO — its own definition, and its ONE consumer, the dev
 * fast-forward's entry gate `apps/web/src/app/dev/_actions/fast-forward.ts` — and that consumer
 * carries all three of its load-bearing clauses (§4.2): the production refusal FIRST, an
 * authenticated+onboarded session, and the platform-capability check itself.
 *
 * WHY THIS MATTERS: `FAST_FORWARD_REQUEST` confers nothing in production only because no
 * reachable production call site resolves it (the token's own docblock in `platform.ts` states
 * this as its production-inertness argument). That argument is only TRUE while the token has
 * exactly one consumer and that consumer refuses before production ever reaches the capability
 * check. A second consumer anywhere — even a read-only one — would widen a dev-only act-on-behalf
 * mechanism (§16 point 8 of the BAL-275 plan) onto a surface this ticket never reviewed for it.
 *
 * ⚠⚠ THE WALK COVERS THE WHOLE WORKSPACE, NOT JUST `apps/web/src` (F8). It used to scan only
 * `apps/web/src`, while `platform.ts`'s docblock claimed the consumer was the sole one FULL STOP
 * — a scope mismatch in the dangerous direction, because `apps/api` is the one workspace that is
 * ALWAYS a production process: a Fastify route resolving this token would have no `NODE_ENV`
 * refusal in front of it and no `notFound()` page, and a web-only walk would have stayed green
 * straight through it. The token is defined in `packages/shared` and is importable by every app,
 * so the pin has to be as wide as the import graph. `apps/` and `packages/` together ARE the
 * workspace (`pnpm-workspace.yaml` lists exactly `apps/*` and `packages/*`), reached from the
 * root found by walking UP for that file — which lands in the same place whether vitest was
 * started from `apps/web` (a developer) or the repo root (CI).
 *
 * ⚠⚠ THE WALK IS UNFILTERED OVER FIRST-PARTY SOURCE, DELIBERATELY — the same discipline as
 * `action-cores-take-their-actor.test.ts` (N10) and its own citation of the BAL-404 fix-round F2
 * finding: a scan that is narrowed to an allow-list BEFORE the set-equality assertion can pass
 * vacuously on a file the allow-list happened not to name. Nothing here filters by path, package
 * or name; every non-test `.ts`/`.tsx` file in the workspace is collected, and ONLY THEN is the
 * `FAST_FORWARD_REQUEST` substring filter applied, in-memory, on the already-collected set. A
 * second consumer dropped in anywhere — a page, a component, another Server Action, a Fastify
 * route, a repository — is collected by the walk and fails the set-equality assertion loudly.
 * `GENERATED_DIRS` is the ONE exclusion and it names only build output and vendored dependencies
 * (`node_modules`, `.next`, `dist`, …): directories no first-party consumer can live in, and
 * whose presence differs between a developer's checkout and a clean CI one, which is what would
 * make this walk non-deterministic rather than strict. It is not — and must never become — a way
 * to excuse a real source file from the scan.
 *
 * If this test fails:
 *   - a THIRD file references `FAST_FORWARD_REQUEST` → either that reference is a mistake
 *     (route it through the existing gate instead of re-resolving the capability), or the
 *     widening is deliberate, in which case update `EXPECTED_CONSUMERS` here AND re-read
 *     `platform.ts`'s docblock, because its "confers nothing in production" argument now needs
 *     re-justifying against a second call site;
 *   - the definition or the consumer went MISSING from the set → the token was renamed or
 *     deleted out from under the gate, or the gate stopped resolving the capability at all;
 *   - `fast-forward.ts` lost one of its three gate clauses → the entry gate no longer refuses
 *     production / an unauthenticated session / a non-staff session the way §4.2 requires.
 */

/**
 * The monorepo root: the nearest ancestor of the cwd (itself included) carrying
 * `pnpm-workspace.yaml`. CI runs web vitest from the REPO ROOT while a developer runs it from
 * `apps/web` (memory `reference_web_server_disk_asset_cwd`) — walking UP for a marker file
 * resolves both to the same directory, where a `['..', '../..']` candidate list would have to
 * guess, and could silently pick a directory OUTSIDE the checkout. Returns `''` when not found,
 * which the non-vacuity test below turns into a loud failure rather than an empty walk.
 *
 * Bounded rather than `while (true)`: a path has finitely many ancestors and `path.dirname`
 * reaches a fixpoint at the filesystem root, so the depth cap only ever stops a pathological
 * mount — the `parent === dir` check is what normally terminates it.
 */
function findWorkspaceRoot(): string {
  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

const WORKSPACE_ROOT = findWorkspaceRoot();

/** Exactly the globs `pnpm-workspace.yaml` declares (`apps/*`, `packages/*`), as their roots. */
const WORKSPACE_TREES: readonly string[] = ['apps', 'packages'];

/**
 * Build output and vendored dependencies — never first-party source, and present or absent
 * depending on what the machine last built. See the ⚠⚠ note above: this list exists to keep the
 * walk deterministic, not to excuse any source file from it.
 */
const GENERATED_DIRS: readonly string[] = [
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
];

const TOKEN = 'FAST_FORWARD_REQUEST';

/** The token's own definition — a name necessarily appears where it is declared. */
const DEFINITION_FILE = 'packages/shared/src/authz/platform.ts';
/** The ONE consumer: the dev entry gate. */
const EXPECTED_CONSUMER = 'apps/web/src/app/dev/_actions/fast-forward.ts';
/**
 * The exact, complete set of non-test workspace files whose CODE names the token. Pinned in full
 * — not "the consumer plus whatever else" — so neither entry can vanish silently: the definition
 * disappearing would mean the token was renamed or deleted out from under the gate, and the
 * consumer disappearing would mean the gate stopped resolving the capability. Test files are
 * absent because `scanRouteSources` skips them by rule (`platform.test.ts` and this file both
 * name the token), not because an allow-list left them out.
 */
const EXPECTED_CONSUMERS: readonly string[] = [DEFINITION_FILE, EXPECTED_CONSUMER];

/**
 * §4.2's three gate clauses, verbatim, in the order they must run. Pinned as exact substrings
 * (memory `feedback_monitor_strings_need_verbatim_pin`) — not a looser "mentions the env check"
 * check, which would pass on a clause checking it the wrong way around.
 *
 * ⚠ S1 FIX-ROUND (security finding S1): the first clause used to be the deny-list
 * `process.env.NODE_ENV === 'production'`, which fails OPEN on an unset/misspelt/overridden
 * `NODE_ENV`. It was replaced with the allow-list form already used by
 * `apps/api/src/services/seed/truncate.ts`. Re-pinned to that new literal — the invariant must
 * track whichever form is actually live in `fast-forward.ts`, never the old one.
 *
 * The "contains all three gate clauses" test below destructures this array by NAME
 * (`envClause` / `identityClause` / `capabilityClause`), so its order assertions read as
 * "identity resolution must run after the environment refusal" rather than as bare array
 * indices.
 */
const GATE_CLAUSES: readonly string[] = [
  'FAST_FORWARD_ALLOWED_NODE_ENVS.includes(',
  'requireOnboardedUser(',
  'hasPlatformCapability(',
];

/** `export async function ...` — every Server Action this file exports. */
const EXPORTED_ACTION_TOKEN = 'export async function';
/** The ONE call site every exported action must route through before doing anything else. */
const GATE_CALL_TOKEN = 'await resolveFastForwardOperator()';
/**
 * Non-vacuity pin for the count assertion below — today there are exactly 3 exported actions
 * and exactly 3 gate calls. A fourth of either without a matching fourth of the other must fail.
 */
const EXPECTED_GATE_CALL_COUNT = 3;

/** Occurrences of `needle` in `haystack` — same pattern as `balo-panel-capability-gated.test.ts`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function scanFullTree(): ScannedFile[] {
  if (WORKSPACE_ROOT === '') return [];
  const found: ScannedFile[] = [];
  for (const tree of WORKSPACE_TREES) {
    // UNFILTERED over source — every non-test `.ts`/`.tsx` file in the tree, no allow-list; the
    // only exclusions are generated/vendored directories (see GENERATED_DIRS).
    found.push(...scanRouteSources(path.join(WORKSPACE_ROOT, tree), tree, GENERATED_DIRS));
  }
  return found;
}

describe('invariant: FAST_FORWARD_REQUEST has exactly one consumer, and it gates dev-only (BAL-275)', () => {
  const scanned = scanFullTree();
  const mentioningFiles = scanned
    .filter((file) => file.code.includes(TOKEN))
    .map((file) => file.rel);

  it('scans the full workspace — both trees, thousands of files (guards against a vacuous pass)', () => {
    expect(WORKSPACE_ROOT).not.toBe('');
    // The workspace is a couple of thousand source files; a walk that found nothing, or that
    // silently lost one of the two trees, would pass every assertion below for the wrong reason.
    expect(scanned.length).toBeGreaterThan(1500);
    for (const tree of WORKSPACE_TREES) {
      const inTree = scanned.filter((file) => file.rel.startsWith(`${tree}/`));
      expect(inTree.length, `the walk must reach ${tree}/`).toBeGreaterThan(50);
    }
    // …and specifically reaches `apps/api`, the always-production workspace this widening exists
    // for. A walk that covered `apps/web` and `packages` only would look just as green.
    const apiFiles = scanned.filter((file) => file.rel.startsWith('apps/api/src/'));
    expect(apiFiles.length, 'the walk must reach apps/api/src').toBeGreaterThan(50);
  });

  it('the set of files naming FAST_FORWARD_REQUEST is EXACTLY the definition + the entry gate (both directions + length)', () => {
    expect(mentioningFiles.sort()).toEqual([...EXPECTED_CONSUMERS].sort());
    expect(mentioningFiles).toHaveLength(2);
  });

  it('the entry-gate file contains all three gate clauses, IN ORDER, and every exported action reaches the gate (non-vacuity: each is asserted individually)', () => {
    const gateFile = scanned.find((file) => file.rel === EXPECTED_CONSUMER);
    expect(gateFile, `${EXPECTED_CONSUMER} must be in the scan set`).toBeDefined();
    if (gateFile === undefined) return;

    for (const clause of GATE_CLAUSES) {
      expect(gateFile.code, `${EXPECTED_CONSUMER} must contain: ${clause}`).toContain(clause);
    }

    // S2 (order): the three `toContain` checks above pass no matter WHERE each clause sits —
    // a gate that resolved identity/capability before the environment refusal would still pass
    // them. Assert the actual document order with `indexOf` instead.
    const [envClause, identityClause, capabilityClause] = GATE_CLAUSES;
    if (envClause === undefined || identityClause === undefined || capabilityClause === undefined) {
      throw new Error('GATE_CLAUSES must have exactly three entries');
    }
    const envIndex = gateFile.code.indexOf(envClause);
    const identityIndex = gateFile.code.indexOf(identityClause);
    const capabilityIndex = gateFile.code.indexOf(capabilityClause);
    expect(envIndex, `${envClause} must be present`).toBeGreaterThanOrEqual(0);
    expect(
      identityIndex,
      `"${identityClause}" must run AFTER "${envClause}" — the environment refusal must come first`
    ).toBeGreaterThan(envIndex);
    expect(
      capabilityIndex,
      `"${capabilityClause}" must run AFTER "${identityClause}" — identity must be resolved before the capability check`
    ).toBeGreaterThan(identityIndex);

    // S2 (coverage): the assertions above only prove the clauses exist SOMEWHERE in the file,
    // not that EVERY exported action reaches them — a fourth exported action added without the
    // `resolveFastForwardOperator()` call would leave everything above green. Pin both counts
    // to the literal 3 (non-vacuity — two counts merely equal to EACH OTHER would pass at
    // 0 === 0 just as readily as at the real 3 === 3), then require the two counts to match.
    const exportCount = countOccurrences(gateFile.code, EXPORTED_ACTION_TOKEN);
    const gateCallCount = countOccurrences(gateFile.code, GATE_CALL_TOKEN);
    expect(exportCount, `expected exactly ${EXPECTED_GATE_CALL_COUNT} exported actions`).toBe(
      EXPECTED_GATE_CALL_COUNT
    );
    expect(gateCallCount, `expected exactly ${EXPECTED_GATE_CALL_COUNT} gate calls`).toBe(
      EXPECTED_GATE_CALL_COUNT
    );
    expect(
      exportCount,
      'every exported action must reach the gate exactly once — no extra export, no extra call'
    ).toBe(gateCallCount);
  });

  it('⚠ guards the guard: three decoys, each missing exactly one clause, are each flagged', () => {
    const decoys: readonly { readonly label: string; readonly code: string }[] = [
      {
        label: 'missing the production check',
        code: [
          'async function resolveFastForwardOperator() {',
          '  const user = await requireOnboardedUser();',
          '  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST)) return null;',
          '  return user;',
          '}',
        ].join('\n'),
      },
      {
        label: 'missing requireOnboardedUser(',
        code: [
          'async function resolveFastForwardOperator() {',
          "  if (!FAST_FORWARD_ALLOWED_NODE_ENVS.includes(process.env.NODE_ENV ?? '')) return null;",
          '  const user = await getSession();',
          '  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.FAST_FORWARD_REQUEST)) return null;',
          '  return user;',
          '}',
        ].join('\n'),
      },
      {
        label: 'missing hasPlatformCapability(',
        code: [
          'async function resolveFastForwardOperator() {',
          "  if (!FAST_FORWARD_ALLOWED_NODE_ENVS.includes(process.env.NODE_ENV ?? '')) return null;",
          '  const user = await requireOnboardedUser();',
          '  return user;',
          '}',
        ].join('\n'),
      },
    ];

    for (const decoy of decoys) {
      const missing = GATE_CLAUSES.filter((clause) => !decoy.code.includes(clause));
      expect(missing.length, `decoy "${decoy.label}" not caught: ${decoy.code}`).toBeGreaterThan(0);
    }
  });

  it('⚠ guards the guard: a third file naming FAST_FORWARD_REQUEST would break set equality, in EITHER workspace tree', () => {
    for (const leak of [
      'apps/api/src/routes/leaked-capability.ts',
      'packages/db/src/repositories/leaked-capability.ts',
      'apps/web/src/app/somewhere-else/leaked-capability.ts',
    ]) {
      const decoyMentioning = [...mentioningFiles, leak].sort();
      expect(decoyMentioning, `a leak at ${leak} must break set equality`).not.toEqual(
        [...EXPECTED_CONSUMERS].sort()
      );
      expect(decoyMentioning).toHaveLength(3);
    }
  });
});
