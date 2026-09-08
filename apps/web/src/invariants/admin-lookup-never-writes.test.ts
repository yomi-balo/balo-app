import { describe, expect, it } from 'vitest';
import {
  hasUseServerDirective,
  namedImportsFrom,
  repositoryMemberCallsOf,
  resolveRouteDir,
  scanRouteSources,
} from './_source-scan';

/**
 * BAL-551 — "the Lookup page and its drill-in perform no writes" (scope ruling item 7).
 *
 * Built on the `guest-read-allowlist.test.ts:339-359` object-agnostic idiom
 * (`repositoryMemberCallsOf` — every `xxxRepository.member` call, for WHATEVER repository is
 * referenced — is what an exact-pair allow-list needs to catch a write under a name nobody
 * anticipated), NOT `READ_ONLY_ALLOWLIST` (`_read-only-actions.ts`): that list is the register
 * of Server Actions permitted to skip the ONBOARDING gate, a completely different axis. Every
 * action on it can still write (several do); putting Lookup's read-only Server Action there
 * would assert nothing about writes at all — a vacuous AC (BAL-551 pre-flight O7). It is also
 * not the single-repository `review-link-never-writes.test.ts` idiom (`memberNamesOf` names
 * ONE repository in advance) — Lookup's invariant is "no repository write, by ANY name", so it
 * needs the object-agnostic scan.
 *
 * ⚠ `EXCLUDED_DIRS` IS EMPTY, DELIBERATELY. Every other route-level invariant in this file
 * excludes `_actions/` (that is where the POST-only mutation is SUPPOSED to live). Lookup has
 * no such carve-out: `_actions/fetch-lookup-money-block.ts` is itself a READ (an HTTP GET
 * forward), so it is scanned like everything else. If a future builder adds a genuinely
 * mutating Server Action under `_actions/`, this invariant must catch it, not wave it through
 * because the directory name usually means "writes happen here".
 *
 * ⚠ THE RECENT HOOK WRITES TO localStorage, NOT TO A REPOSITORY OR `audit_events`. That is not
 * a write in this invariant's sense (`use-recent-lookups.ts`'s own docblock says so too) — do
 * not "fix" this by trying to make the scan see `globalThis.localStorage.setItem`.
 *
 * ⚠ ACCEPTED BLIND SPOT (BAL-551 fix round F15, SEC-L3) — this scan sees repository calls and
 * `@balo/db` imports only. A write issued as an HTTP hop instead — `callSessionApi(..., 'POST')`
 * or an equivalent `fetch` — would pass every assertion here undetected. Deliberately NOT
 * widened in this ticket (the fix round's scope ruling); a route that ever adds one needs a
 * wider scan or a different invariant, not a false sense of coverage from this one.
 *
 * If this test fails: you added a write to the Lookup route. Lookup is a read-only support
 * surface by design — a write here needs its own ticket and its own review, not a passing
 * mention in this one.
 */

const LOOKUP_DIR = resolveRouteDir([
  'src/app/(dashboard)/admin/lookup',
  'apps/web/src/app/(dashboard)/admin/lookup',
]);

/** NOTHING is excluded — even `_actions/` must not write here. */
const EXCLUDED_DIRS: readonly string[] = [];

/**
 * The route's files, pinned. Relative to `admin/lookup`, POSIX separators. Pinning is the
 * non-vacuity guard: a directory walk that silently finds nothing (a typo'd `LOOKUP_DIR`)
 * would pass every assertion below for the wrong reason.
 */
const PINNED_FILES: readonly string[] = [
  'page.tsx',
  'loading.tsx',
  '_lib/load-lookup.ts',
  '_lib/lookup-view.ts',
  '_actions/fetch-lookup-money-block.ts',
  '_components/lookup-shell.tsx',
  '_components/lookup-drill-in.tsx',
  '_components/lookup-money-section.tsx',
];

/**
 * THE GATE — the exact `(object, member)` pairs the ENTIRE route may call, on any repository.
 * `platformLookupRepository.search` is the one legitimate read; the money figures come over
 * HTTP (`callSessionApi`), never a repository. Anything else fails, with the offending pair
 * named in the message.
 */
const ALLOWED_REPOSITORY_CALLS: readonly { readonly object: string; readonly member: string }[] = [
  { object: 'platformLookupRepository', member: 'search' },
];

function isAllowedCall(call: { readonly object: string; readonly member: string }): boolean {
  return ALLOWED_REPOSITORY_CALLS.some(
    (allowed) => allowed.object === call.object && allowed.member === call.member
  );
}

/**
 * The `@balo/db` named-import set, per module, EXACTLY. `repositoryMemberCallsOf` only sees
 * calls shaped `xxxRepository.member` — a bare export with no `Repository.` in its name is
 * invisible to it (the blind spot `_source-scan.ts:244-248` documents). Checked BOTH ways
 * below (unexpected AND stale), so the pin cannot rot into decoration.
 */
const ALLOWED_DB_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  '_lib/load-lookup.ts': ['platformLookupRepository'],
};

const scanned = scanRouteSources(LOOKUP_DIR, '', EXCLUDED_DIRS);
const scannedPaths = scanned.map((file) => file.rel);

describe('invariant: the Lookup page and its drill-in perform no writes (BAL-551)', () => {
  it('guards the guard: resolves the route directory and finds every pinned file', () => {
    expect(LOOKUP_DIR).not.toBe('');
    expect(scanned.length).toBeGreaterThan(0);
    for (const pinned of PINNED_FILES) {
      expect(scannedPaths, `expected ${pinned} in the scanned Lookup route files`).toContain(
        pinned
      );
    }
  });

  it('guards the guard: the repository-call scan finds the one real allowed call (dead-matcher guard)', () => {
    const loader = scanned.find((file) => file.rel === '_lib/load-lookup.ts');
    expect(loader).toBeDefined();
    const calls = repositoryMemberCallsOf(loader?.code ?? '');
    expect(calls).toContainEqual({ object: 'platformLookupRepository', member: 'search' });
  });

  it.each(scannedPaths)(
    '%s calls no repository member outside the exact-pair allow-list',
    (rel) => {
      const file = scanned.find((f) => f.rel === rel);
      expect(file).toBeDefined();
      const calls = repositoryMemberCallsOf(file?.code ?? '');
      const disallowed = calls.filter((call) => !isAllowedCall(call));
      expect(
        disallowed,
        `${rel} calls a repository member outside ALLOWED_REPOSITORY_CALLS: ` +
          disallowed.map((c) => `${c.object}.${c.member}`).join(', ') +
          `. Lookup is a read-only support surface — a write here needs its own ticket.`
      ).toEqual([]);
    }
  );

  it.each(Object.entries(ALLOWED_DB_IMPORTS))(
    '%s imports from @balo/db only its pinned names (both ways)',
    (rel, allowed) => {
      const file = scanned.find((f) => f.rel === rel);
      expect(file, `${rel} did not resolve under ${LOOKUP_DIR}`).toBeDefined();
      const used = namedImportsFrom(file?.code ?? '', '@balo/db');
      const unexpected = [...new Set(used.filter((name) => !allowed.includes(name)))].sort();
      const stale = [...allowed].filter((name) => !used.includes(name)).sort();
      expect(
        unexpected,
        `${rel} now imports ${unexpected.join(', ')} from @balo/db, not on its pinned import ` +
          `set. A bare export has no "Repository." in its name, so the call-scan above cannot ` +
          `see it — this pin is what catches a new one arriving unnoticed.`
      ).toEqual([]);
      expect(
        stale,
        `${rel}'s pinned @balo/db import set lists ${stale.join(', ')}, which it no longer ` +
          `imports. Prune the pin.`
      ).toEqual([]);
    }
  );

  it('no OTHER scanned module imports anything from @balo/db', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      if (file.rel in ALLOWED_DB_IMPORTS) continue;
      if (namedImportsFrom(file.code, '@balo/db').length > 0) offenders.push(file.rel);
    }
    expect(
      offenders,
      `These Lookup route files import from @balo/db but are not in ALLOWED_DB_IMPORTS: ` +
        offenders.join(', ')
    ).toEqual([]);
  });

  it('_actions/ is NOT excluded, and it holds exactly one read-only Server Action', () => {
    const actionFiles = scanned.filter((file) => file.rel.startsWith('_actions/'));
    expect(actionFiles.length).toBeGreaterThan(0); // proves the directory was actually scanned
    const serverActions = actionFiles.filter((file) => hasUseServerDirective(file.raw));
    expect(serverActions).toHaveLength(1);
    const [action] = serverActions;
    expect(action?.rel).toBe('_actions/fetch-lookup-money-block.ts');
    // The money block travels over HTTP (callSessionApi), never a repository member.
    expect(repositoryMemberCallsOf(action?.code ?? '')).toEqual([]);
  });
});
