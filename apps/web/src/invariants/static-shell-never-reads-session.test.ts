import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeLinesOf, occurrences, resolveRouteDir, scanRouteSources } from './_source-scan';

/**
 * The root layout never reads the session, so it must never regain a session or request-context
 * import. Left unguarded, a future edit could reintroduce `getCurrentUser()`/`cookies()` at the
 * root and silently de-static the whole app again.
 *
 * The static anonymous home and its shared body carry the same "no session read" contract as the
 * root layout, for the same reason: they are prerendered/ISR'd and cannot be per-visitor. The
 * `(marketing-anon)` group is walked with `scanRouteSources` rather than listed by hand, so a
 * later file added to that group (a `loading.tsx`, a new component) is covered automatically
 * instead of silently escaping this scan.
 *
 * NO REGEX ANYWHERE, per this directory's convention (SonarCloud S5852) — `occurrences` is an
 * `indexOf` loop.
 */

const FORBIDDEN_MODULES: readonly string[] = [
  '@/lib/auth/session',
  'next/headers',
  '@/lib/auth/middleware-session',
  '@/lib/auth/impersonation',
];

/** Files outside `(marketing-anon)` that carry the same "no session read" contract. */
const EXPLICIT_FILES: readonly string[] = [
  'app/layout.tsx',
  'app/(marketing)/_home/marketing-home.tsx',
];

/**
 * CI runs web vitest from the REPO ROOT while a developer runs it from `apps/web` (memory
 * `reference_web_server_disk_asset_cwd`) — the same two-cwd reality `_source-scan.ts`'s
 * `resolveRouteDir` guards against for a directory. This is the single-file equivalent.
 */
function resolveSrcFile(relPath: string): string {
  return (
    ['apps/web/src', 'src']
      .map((candidate) => path.resolve(process.cwd(), candidate, relPath))
      .find((candidate) => existsSync(candidate)) ?? ''
  );
}

const ANON_GROUP_DIR = resolveRouteDir([
  'apps/web/src/app/(marketing-anon)',
  'src/app/(marketing-anon)',
]);
const ANON_GROUP_FILES = scanRouteSources(ANON_GROUP_DIR, 'app/(marketing-anon)', []);

/** One scanned file: its path relative to `apps/web/src`, and its comment-stripped source. */
interface ScannedFile {
  readonly rel: string;
  readonly code: string;
}

const SCANNED_FILES: readonly ScannedFile[] = [
  ...EXPLICIT_FILES.map((rel): ScannedFile => {
    const resolved = resolveSrcFile(rel);
    return { rel, code: resolved === '' ? '' : codeLinesOf(readFileSync(resolved, 'utf8')) };
  }),
  ...ANON_GROUP_FILES.map((file): ScannedFile => ({ rel: file.rel, code: file.code })),
];

/** Whether `source` pulls in `specifier` via a static `from '…'` clause, either quote style. */
function importsFrom(source: string, specifier: string): boolean {
  for (const quote of ["'", '"']) {
    if (occurrences(source, `from ${quote}${specifier}${quote}`) > 0) return true;
  }
  return false;
}

describe('invariant: the static shell never reads the session (BAL-504)', () => {
  it('guards the guard: every explicit file resolves and is non-empty (non-vacuity)', () => {
    expect(EXPLICIT_FILES.length).toBeGreaterThan(0);
    for (const rel of EXPLICIT_FILES) {
      const resolved = resolveSrcFile(rel);
      expect(resolved, `${rel} did not resolve to a file on disk`).not.toBe('');
      expect(readFileSync(resolved, 'utf8').trim().length).toBeGreaterThan(0);
    }
  });

  it('guards the guard: the (marketing-anon) group walk finds at least 4 files (non-vacuity)', () => {
    expect(ANON_GROUP_DIR).not.toBe('');
    expect(ANON_GROUP_FILES.length).toBeGreaterThanOrEqual(4);
  });

  it('guards the guard: the matcher catches a real import, both quote styles', () => {
    expect(
      importsFrom(`import { getCurrentUser } from '@/lib/auth/session';`, '@/lib/auth/session')
    ).toBe(true);
    expect(importsFrom(`import { cookies } from "next/headers";`, 'next/headers')).toBe(true);
    expect(importsFrom(`import { x } from '@/lib/other';`, '@/lib/auth/session')).toBe(false);
  });

  it('guards the guard: codeLinesOf strips a comment that merely NAMES a forbidden import', () => {
    // A docblock explaining that this file never reads the session must not trip the invariant
    // it documents — the same reasoning `_source-scan.ts`'s own docblock states for
    // `codeLinesOf`.
    const source = `// e.g. import { getCurrentUser } from '@/lib/auth/session'`;
    expect(importsFrom(source, '@/lib/auth/session')).toBe(true); // unstripped: a false alarm
    expect(importsFrom(codeLinesOf(source), '@/lib/auth/session')).toBe(false); // stripped: clean
  });

  it.each(SCANNED_FILES)('$rel imports nothing from the forbidden modules', ({ rel, code }) => {
    const offenders = FORBIDDEN_MODULES.filter((mod) => importsFrom(code, mod));
    expect(
      offenders,
      `${rel} imports from ${offenders.join(', ')}, which reads the session or request ` +
        `context. The static shell must resolve the session only where a caller already has ` +
        `\`user\` in hand (see \`analyticsIdentifyPropsFor\` in @/lib/auth/impersonation).`
    ).toEqual([]);
  });
});
