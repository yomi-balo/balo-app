import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `_source-scan` — the shared reading primitives behind the route-level SOURCE invariants
 * (`review-link-never-writes.test.ts`, `join-link-never-writes.test.ts`).
 *
 * ⚠ EXTRACTED, NOT INVENTED. BAL-390 shipped these functions inside its own invariant;
 * BAL-408 needs the identical scan for `/join/{token}`, and a second verbatim copy of ~70
 * lines in the SAME DIRECTORY is exactly the shape SonarCloud's >3% new-code duplication gate
 * exists to catch (memory `reference_sonar_duplication_not_caught_locally`). The behaviour is
 * unchanged from BAL-390's original, including the reasoning in its comments.
 *
 * ⚠ THIS FILE IS NOT A TEST and is deliberately not named like one — vitest only collects
 * `*.test.ts` / `*.spec.ts` under `src`, so a helper module here is imported, never run as a
 * suite.
 *
 * ⚠ SHARING THESE DOES NOT WEAKEN EITHER INVARIANT, because each caller carries its own
 * "guards the guard" test asserting the matcher finds a call that IS genuinely present in the
 * page under scan. A silently-broken helper would make every other assertion pass vacuously,
 * and those tests are what stop that — keep one when adding a third consumer.
 *
 * NO REGEX ANYWHERE IN HERE, deliberately: these functions read source text and a regex over
 * it is the SonarCloud S5852 / `regexp/no-super-linear-move` shape.
 */

/**
 * Drop whole comment lines. Line-oriented, so there is no regex anywhere and no
 * character-level state machine to get wrong.
 *
 * Comments MUST NOT count: a page docblock that NAMES a forbidden call while explaining that
 * it is never made must not trip the invariant it documents. A TRAILING `// …` after real code
 * is deliberately KEPT — the failure mode is then a false ALARM (someone writes a forbidden
 * name in an end-of-line comment and the test complains), never a false pass, which is the
 * correct direction for a security invariant to be wrong in.
 */
export function codeLinesOf(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      inBlock = !line.includes('*/');
      continue;
    }
    if (line.startsWith('/*')) {
      inBlock = !line.includes('*/');
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    kept.push(raw);
  }
  return kept.join('\n');
}

/**
 * Every `<object>.<member>` name used on `object`, in source order. An indexOf scan, never a
 * regex. A marker with no parseable member yields `<unparsed>` so a malformed reference FAILS
 * an allow-list loudly rather than vanishing from the results.
 */
export function memberNamesOf(source: string, object: string): string[] {
  const names: string[] = [];
  const marker = `${object}.`;
  let i = source.indexOf(marker);
  while (i !== -1) {
    let end = i + marker.length;
    while (end < source.length) {
      const ch = source.charAt(end);
      const word =
        (ch >= 'a' && ch <= 'z') ||
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_';
      if (!word) break;
      end += 1;
    }
    const name = source.slice(i + marker.length, end);
    names.push(name.length === 0 ? '<unparsed>' : name);
    i = source.indexOf(marker, i + marker.length);
  }
  return names;
}

/** One scanned source file: its path relative to the route root, plus two views of it. */
export interface ScannedFile {
  readonly rel: string;
  /** Comment lines stripped — what every name-keyed assertion reads. */
  readonly code: string;
  /** The file verbatim — needed to see directives like `'use client'`, which are string literals. */
  readonly raw: string;
}

/**
 * The first candidate path that exists on disk, or `''`.
 *
 * CI runs web vitest from the REPO ROOT (`pnpm test:coverage`) while a developer runs it from
 * `apps/web`, so a single cwd-relative path resolves to nothing in one of the two — and a walk
 * that finds nothing passes every assertion for the wrong reason. A candidate list covers both
 * (memory `reference_web_server_disk_asset_cwd`); the empty fallback is then caught loudly by
 * each caller's pinned-files test rather than silently.
 *
 * (`import.meta.url` is NOT usable here: under vitest's jsdom environment it is an `http://`
 * URL, so `fileURLToPath` throws "The URL must be of scheme file".)
 */
export function resolveRouteDir(candidates: readonly string[]): string {
  return (
    candidates
      .map((candidate) => path.resolve(process.cwd(), candidate))
      .find((candidate) => existsSync(candidate)) ?? ''
  );
}

/**
 * Every non-test source file under `dir`, recursively, minus the named directories.
 *
 * The exclusion list is how a route's POST path is kept out of a GET-path invariant: a Server
 * Action under `_actions/` legitimately writes, so scanning it would make the invariant
 * impossible to satisfy. Returns `[]` for a missing directory — which the caller's pinned-files
 * test turns into a loud failure rather than a vacuous pass.
 */
export function scanRouteSources(
  dir: string,
  prefix: string,
  excludedDirs: readonly string[]
): ScannedFile[] {
  const found: ScannedFile[] = [];
  if (dir === '' || !existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!excludedDirs.includes(entry.name)) {
        found.push(...scanRouteSources(`${dir}/${entry.name}`, rel, excludedDirs));
      }
      continue;
    }
    const isSource = entry.name.endsWith('.ts') || entry.name.endsWith('.tsx');
    if (!isSource || entry.name.includes('.test.')) continue;
    const raw = readFileSync(`${dir}/${entry.name}`, 'utf8');
    found.push({ rel, code: codeLinesOf(raw), raw });
  }
  return found;
}
