import { describe, it, expect } from 'vitest';
import { ALL_SOURCE_FILES, readRaw, codeLines } from './_source-scan.js';

/**
 * INVARIANT — no bare `require(` anywhere in `apps/api/src`.
 *
 * ⚠⚠ THIS BANS A SHAPE THAT PASSES EVERY OTHER GATE. `apps/api` is `"type": "module"`, and the
 * three ways its code runs disagree about whether `require` exists:
 *
 *   - `pnpm dev` → `tsx watch src/index.ts`: `require` is UNDEFINED. A call throws
 *     `ReferenceError: require is not defined` at runtime.
 *   - `pnpm build` → tsup: `tsup.config.ts` injects a `createRequire` banner, so the bundle
 *     Railway runs DOES define `require`. Production works.
 *   - `pnpm test` → vitest: supplies its own CJS interop. Tests pass.
 *
 * So typecheck, lint, CI and production all stay green while local dev is broken. That is
 * exactly what happened: `require-auth.ts` called `require('@balo/db')` AFTER `jwtVerify`
 * succeeded, its catch turned the ReferenceError into "JWT verification failed", and every
 * `requireAuth`-gated route 401'd in local dev — surfacing only as a `project_brief_parses`
 * row stuck at `failure_reason: 'enqueue_failed'`.
 *
 * A static `import` is the fix and the rule. A module that genuinely needs CJS resolution
 * builds its own `createRequire(import.meta.url)` (as `lib/apiroc/logging.ts` does, to reach
 * into a vendor package's own directory) — so the rule is by CONSTRUCT, not by file:
 * `createRequire` and any NAMED requirer are fine, the ambient `require` is not.
 */

/**
 * Whether `line` calls the AMBIENT `require`. A named requirer — `createRequire(`,
 * `__cjsRequire(`, `localRequire(`, `sdkRequire(`, `foo.require(` — is not one: the character
 * immediately before the match is part of an identifier or a member access.
 *
 * ⚠ NO REGEX over source text (SonarCloud S5852), matching `_source-scan`'s own rule. The
 * one character-class test below runs over a SINGLE character, never over input.
 */
function isBareRequireCall(line: string): boolean {
  const idx = line.indexOf('require(');
  if (idx === -1) return false;
  if (idx === 0) return true;
  const prev = line.charAt(idx - 1);
  const isIdentChar =
    (prev >= 'a' && prev <= 'z') ||
    (prev >= 'A' && prev <= 'Z') ||
    (prev >= '0' && prev <= '9') ||
    prev === '_' ||
    prev === '$' ||
    prev === '.';
  return !isIdentChar;
}

function bareRequireLines(rel: string): string[] {
  return codeLines(readRaw(rel))
    .split('\n')
    .filter((line) => isBareRequireCall(line));
}

describe('apps/api uses no bare require()', () => {
  it('has no bare require( on a non-comment line of any source file', () => {
    const offenders = ALL_SOURCE_FILES.flatMap((rel) =>
      bareRequireLines(rel).map((line) => `${rel}: ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  // ── non-vacuity ──────────────────────────────────────────────────────────────
  // An absence assertion is worthless if the walk is empty or the matcher never fires.

  it('scans a real, non-trivial source surface that includes the file this came from', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(100);
    expect(ALL_SOURCE_FILES).toContain('lib/require-auth.ts');
  });

  it('positive control — the matcher fires on the exact shape that broke dev', () => {
    const DB = '@balo/db';
    expect(
      isBareRequireCall('    const { usersRepository } = require(' + JSON.stringify(DB) + ');')
    ).toBe(true);
    expect(isBareRequireCall('const x = require("y");')).toBe(true);
    expect(isBareRequireCall('require("side-effect");')).toBe(true);
  });

  it('negative control — a named requirer is NOT flagged', () => {
    expect(isBareRequireCall('const localRequire = createRequire(import.meta.url);')).toBe(false);
    expect(isBareRequireCall('const require = __cjsRequire(import.meta.url);')).toBe(false);
    expect(isBareRequireCall('const mod = sdkRequire(entry);')).toBe(false);
    expect(isBareRequireCall('const m = deps.require(name);')).toBe(false);
  });

  it('negative control — a line with no require at all is NOT flagged', () => {
    expect(isBareRequireCall("import { usersRepository } from '@balo/db';")).toBe(false);
  });
});
