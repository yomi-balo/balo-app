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
 * Drop comment lines. Line-oriented, so there is no regex anywhere and no character-level state
 * machine to get wrong.
 *
 * Comments MUST NOT count: a page docblock that NAMES a forbidden call while explaining that
 * it is never made must not trip the invariant it documents. A TRAILING `// …` after real code
 * is deliberately KEPT — the failure mode is then a false ALARM (someone writes a forbidden
 * name in an end-of-line comment and the test complains), never a false pass, which is the
 * correct direction for a security invariant to be wrong in.
 *
 * ⚠⚠ **THE CLOSING LINE'S REMAINDER IS KEPT, AND THAT CLOSED A FALSE-PASS HOLE.** This used to
 * `continue` on any line that OPENED or CLOSED a block comment, dropping the whole line —
 * including real code after the CLOSE DELIMITER. So a line that closed a block comment and then
 * carried on with `if (role === 'admin') …` was invisible to every invariant built on this
 * helper, which is precisely the direction a security scan must never be wrong in. The tail
 * after the FIRST close delimiter is now kept.
 *
 * ⚠ A LINE IS ONLY TREATED AS OPENING A COMMENT WHEN IT **STARTS** WITH `/*` (after trimming),
 * deliberately: a string literal containing `/*` mid-line would otherwise blank out the rest of
 * the file — a far bigger false pass than the one being fixed.
 */
/**
 * Keep whatever follows a block-comment close on the same line.
 *
 * ⚠ THE TAIL AFTER THE CLOSE IS REAL CODE. Keeping a trailing comment fragment with it is a
 * false ALARM at worst; dropping it was a false PASS — the hole the docblock above describes.
 *
 * ⚠ EXTRACTED ONLY TO SHED COGNITIVE COMPLEXITY (SonarCloud caps `codeLinesOf` at 15; the two
 * inlined copies of this put it at 19). The behaviour is byte-for-byte what both branches did.
 */
export function pushRemainderAfterClose(kept: string[], line: string, close: number): void {
  const remainder = line.slice(close + 2);
  if (remainder.trim().length > 0) kept.push(remainder);
}

export function codeLinesOf(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      inBlock = false;
      pushRemainderAfterClose(kept, line, close);
      continue;
    }
    if (line.startsWith('/*')) {
      const close = line.indexOf('*/', 2);
      if (close === -1) {
        inBlock = true;
        continue;
      }
      pushRemainderAfterClose(kept, line, close);
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

/**
 * Every `<identifier>Repository.<member>` call in `source`, for WHATEVER repository object is
 * referenced — unlike {@link memberNamesOf}, the caller does not name the object in advance.
 *
 * ⚠⚠ EXTRACTED FOR BAL-445's `GUEST_READ_ALLOWLIST` GUARD, WHICH NEEDS THIS GENERALITY. That
 * guard asserts a Server Action touches no WRITE member on ANY repository it reaches — and a
 * future guest read might reasonably call a different repository than today's two
 * (`meetingFilesRepository`, `conversationsRepository`). Pinning the object name the way
 * `memberNamesOf` does would silently stop covering a new repository the moment one was added,
 * which is the exact class of miss `_read-only-actions.ts`'s docblock warns about.
 *
 * Every repository export in `packages/db/src/repositories/*.ts` is named `xxxRepository` — a
 * fixed, load-bearing convention this scan relies on rather than re-derives. `Repository.` is
 * searched for literally; the identifier is walked backward through word characters from there,
 * and the member forward, using the SAME indexOf-driven algorithm as `memberNamesOf` — so this
 * inherits its "no regex" property and its single caveat: the object and its member must be
 * joined by a bare `.` with no intervening whitespace or line break (a multi-line method chain
 * is not matched). None of today's callers chain across a line break.
 */
export function repositoryMemberCallsOf(
  source: string
): { readonly object: string; readonly member: string }[] {
  const calls: { object: string; member: string }[] = [];
  const marker = 'Repository.';
  let i = source.indexOf(marker);
  while (i !== -1) {
    let start = i;
    while (start > 0) {
      const ch = source.charAt(start - 1);
      const word =
        (ch >= 'a' && ch <= 'z') ||
        (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') ||
        ch === '_';
      if (!word) break;
      start -= 1;
    }
    const object = source.slice(start, i + 'Repository'.length);
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
    const member = source.slice(i + marker.length, end);
    calls.push({ object, member: member.length === 0 ? '<unparsed>' : member });
    i = source.indexOf(marker, end);
  }
  return calls;
}

/**
 * Every named import binding pulled from `import { ... } from '<moduleSpecifier>'` in `source`
 * — the LOCAL name (after `as`, when aliased), with a leading `type` keyword stripped so a
 * type-only member reads the same as a value one.
 *
 * ⚠⚠ EXTRACTED FOR BAL-445 fix-round-4's PER-MODULE `@balo/db` IMPORT PIN. `repositoryMemberCallsOf`
 * only sees calls shaped `xxxRepository.member` — a bare export like `resolveMeetingContextOwner`
 * has no `Repository.` in its name and is invisible to it, nor is anything else shaped like it.
 * Pinning the whole named-import set per module closes that blind spot: a new bare export can
 * only arrive by first widening the import statement, and that is what this function watches.
 *
 * Handles the multi-line brace form every `@balo/db` import in this codebase uses (opening
 * brace on the `import {` line, closing brace on its own line before ` } from '...'`). Does not
 * handle a default or namespace import (`import db from ...` / `import * as db from ...`) —
 * `@balo/db` has neither today, so no caller needs it; a caller that DOES should extend this
 * rather than special-case around it.
 *
 * NO REGEX, same convention as the rest of this file (SonarCloud S5852): both quote styles are
 * checked literally (Prettier normalises to single quotes, but nothing type-checks a
 * hand-written import), and the import body is found by nearest brace, then split on `,`.
 */
export function namedImportsFrom(source: string, moduleSpecifier: string): string[] {
  const names: string[] = [];
  for (const quote of ["'", '"']) {
    const marker = `from ${quote}${moduleSpecifier}${quote}`;
    let fromIdx = source.indexOf(marker);
    while (fromIdx !== -1) {
      const open = source.lastIndexOf('{', fromIdx);
      const close = open === -1 ? -1 : source.indexOf('}', open);
      if (open !== -1 && close !== -1 && close < fromIdx) {
        for (const rawSpecifier of source.slice(open + 1, close).split(',')) {
          const specifier = rawSpecifier.trim();
          if (specifier.length === 0) continue;
          const withoutType = specifier.startsWith('type ')
            ? specifier.slice('type '.length).trim()
            : specifier;
          const asIdx = withoutType.indexOf(' as ');
          names.push(asIdx === -1 ? withoutType : withoutType.slice(asIdx + ' as '.length).trim());
        }
      }
      fromIdx = source.indexOf(marker, fromIdx + marker.length);
    }
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
