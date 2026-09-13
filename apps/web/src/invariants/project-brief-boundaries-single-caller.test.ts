import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRouteSources, type ScannedFile } from './_source-scan';

/**
 * BAL-254 fix round F12 — the plan's §17.4 invariants #2 and #3, which were specified and then
 * never written. Both hold today; both are one careless import away from not holding, and
 * neither failure mode shows up in a type check or a test.
 *
 * **#2 — `markdownToProjectHtml` has exactly ONE caller.** The converter is explicitly NOT a
 * security boundary (its own docblock says so): it emits `<a href>` and `<strong>` from model
 * output and relies ENTIRELY on `sanitizeProjectHtml` running after it. There is exactly one
 * call site today, and it sanitises. A second caller that forgets to is model-authored HTML
 * reaching a browser — so a second caller has to be a decision, taken here, in the open.
 *
 * **#3 — `isSessionOwnedProjectDocumentKey` has exactly THREE callers.** This is Ruling A's whole
 * boundary (plan §12.2): a draft's uploads have NO DB row until submit and BAL-431's
 * audience/grant model deliberately excludes them, so there is nothing to "read through" — this
 * prefix check IS the authorization. A fourth caller means someone re-derived the prefix, which
 * is a cross-tenant R2 read waiting to happen.
 *
 * ⚠ WIDENED FROM TWO TO THREE BY BAL-254 W9, AND THAT WAS A NARROWING OF THE REAL BLAST RADIUS,
 * not a loosening. The predicate moved from `apps/web/src/lib/storage/` into `@balo/shared` and
 * the worker's Gate 3 — which had been the very "third definition" this pin warns about, a
 * hand-rolled prefix + `startsWith` with NO shape check, in a workspace that cannot import from
 * `apps/web` — now calls the same function. Because this scan already walks `apps/api/src` and
 * `packages/`, the API side is covered by the pin for the first time.
 *
 * ⚠⚠ THE PINNED FILES ARE ASSERTED AGAINST THE **UNFILTERED** WALK. An invariant that checks its
 * pinned set against the same filtered list it later scans proves nothing — the filter can
 * remove a file and the set-equality still passes (BAL-404's fix round found exactly that). Here
 * `SCANNED` is the raw walk of three workspace roots, and every pinned path is asserted present
 * in it before anything else is claimed.
 *
 * ⚠ NO REGEX (SonarCloud S5852) — `includes` over comment-stripped source, via `_source-scan.ts`.
 *
 * Matching is by IDENTIFIER, not by import path, deliberately: `'@/lib/...'` and a relative
 * `'./...'` specifier are the same reach, and a re-export barrel is too.
 */

const SKIPPED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  '__snapshots__',
];

/**
 * CI runs web vitest from the REPO ROOT while a developer runs it from `apps/web` — the
 * two-cwd reality `_source-scan.ts`'s `resolveRouteDir` guards against. This scan walks OUTSIDE
 * `apps/web`, so it resolves the repo root, verified by the presence of two directories rather
 * than one (either alone could coincidentally exist under the wrong candidate).
 */
const REPO_ROOT =
  ['.', '../..']
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find(
      (candidate) =>
        existsSync(path.join(candidate, 'apps/web')) &&
        existsSync(path.join(candidate, 'packages/db'))
    ) ?? '';

/** Every workspace a module could reach these two symbols from. */
const SCAN_ROOTS: readonly string[] = ['apps/web/src', 'apps/api/src', 'packages']
  .map((rel) => path.join(REPO_ROOT, rel))
  .filter((dir) => existsSync(dir));

/** ⚠ THE RAW WALK. Nothing is filtered out of this — the pinned paths are checked against it. */
const SCANNED: readonly ScannedFile[] = SCAN_ROOTS.flatMap((root) =>
  scanRouteSources(root, path.relative(REPO_ROOT, root), SKIPPED_DIRECTORIES)
);

interface SingleCallerRule {
  /** The symbol whose reach is being pinned. */
  readonly symbol: string;
  /** Where it is DEFINED (naturally contains the symbol; never an offender). */
  readonly definedIn: string;
  /** Every module allowed to name it. A new entry is a reviewed decision. */
  readonly allowedCallers: readonly string[];
  /** Named in the failure message so the next person knows what they are widening. */
  readonly why: string;
}

const RULES: readonly SingleCallerRule[] = [
  {
    symbol: 'markdownToProjectHtml',
    definedIn: 'apps/web/src/lib/project-request/markdown-to-project-html.ts',
    allowedCallers: ['apps/web/src/lib/project-request/actions/get-project-brief-parse.ts'],
    why:
      'The converter is NOT a security boundary — it emits <a href> and <strong> from MODEL ' +
      'output and depends on sanitizeProjectHtml running after it. Before adding a caller, ' +
      'confirm that caller pipes the result through sanitizeProjectHtml, then list it here.',
  },
  {
    symbol: 'isSessionOwnedProjectDocumentKey',
    definedIn: 'packages/shared/src/project-requests/document-key.ts',
    allowedCallers: [
      'apps/web/src/lib/project-request/actions/confirm-project-document-upload.ts',
      'apps/web/src/lib/project-request/actions/start-project-brief-parse.ts',
      'apps/api/src/services/project-brief/parse.ts',
    ],
    why:
      'This prefix check IS Ruling A — a draft document has no DB row and no audience/grant to ' +
      'read through, so nothing else authorizes the R2 key. A fourth caller means the prefix ' +
      'was re-derived somewhere; make sure the owner ids come from the SESSION (web) or from ' +
      'the PERSISTED ROW (the worker), never from client input.',
  },
];

/** Every scanned module, other than its definition, whose CODE names `symbol`. */
function callersOf(symbol: string, definedIn: string): string[] {
  return SCANNED.filter((file) => file.rel !== definedIn && file.code.includes(symbol)).map(
    (file) => file.rel
  );
}

describe('invariant: the BAL-254 boundary helpers keep their pinned caller sets (F12)', () => {
  it('guards the guard: the repo root resolved and the walk found a non-trivial tree', () => {
    expect(REPO_ROOT).not.toBe('');
    expect(SCAN_ROOTS.length).toBe(3);
    expect(SCANNED.length).toBeGreaterThan(100);
  });

  it('guards the guard: every pinned path exists in the UNFILTERED walk', () => {
    const scannedPaths = SCANNED.map((file) => file.rel);
    for (const rule of RULES) {
      expect(scannedPaths, `${rule.definedIn} was not walked`).toContain(rule.definedIn);
      for (const caller of rule.allowedCallers) {
        expect(scannedPaths, `${caller} was not walked`).toContain(caller);
      }
    }
  });

  it('guards the guard: each symbol is genuinely present in its definition AND in every allowed caller', () => {
    // A rename that made the matcher stop matching would otherwise turn every assertion below
    // into a vacuous pass.
    for (const rule of RULES) {
      const definition = SCANNED.find((file) => file.rel === rule.definedIn);
      expect(
        definition?.code.includes(rule.symbol),
        `${rule.symbol} missing from its own file`
      ).toBe(true);
      for (const caller of rule.allowedCallers) {
        const file = SCANNED.find((entry) => entry.rel === caller);
        expect(file?.code.includes(rule.symbol), `${rule.symbol} missing from ${caller}`).toBe(
          true
        );
      }
    }
  });

  it('markdownToProjectHtml is reached from exactly one module, and it is the sanitising one', () => {
    const [rule] = RULES;
    if (rule === undefined) throw new Error('RULES[0] missing');
    expect(callersOf(rule.symbol, rule.definedIn).sort()).toEqual([...rule.allowedCallers].sort());
  });

  it('the one converter caller ALSO calls sanitizeProjectHtml (the property the pin exists for)', () => {
    const [rule] = RULES;
    const [caller] = rule?.allowedCallers ?? [];
    const file = SCANNED.find((entry) => entry.rel === caller);
    expect(file?.code.includes('sanitizeProjectHtml')).toBe(true);
  });

  it('isSessionOwnedProjectDocumentKey is reached from exactly three modules — both apps', () => {
    const rule = RULES[1];
    if (rule === undefined) throw new Error('RULES[1] missing');
    expect(callersOf(rule.symbol, rule.definedIn).sort()).toEqual([...rule.allowedCallers].sort());
  });

  it('no module outside the pinned sets names either symbol', () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      for (const caller of callersOf(rule.symbol, rule.definedIn)) {
        if (!rule.allowedCallers.includes(caller)) {
          offenders.push(`${caller} → ${rule.symbol}: ${rule.why}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
