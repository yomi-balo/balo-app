import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * BUILD INVARIANT — a `'use server'` module may export ONLY async functions.
 *
 * Next enforces this at bundle time: *"Only async functions are allowed to be exported in
 * a 'use server' file."* A plain `export const SOME_STRING = '…'` in a Server Action file
 * therefore fails `next build`.
 *
 * ⚠ WHY THIS TEST HAS TO EXIST — nothing else in the pipeline can catch it.
 * It is a BUNDLER rule, not a type or lint rule, so `tsc --noEmit`, `eslint` and the whole
 * vitest suite all pass on code that cannot build. On PR #191 (BAL-390) every gate was
 * green and CI's Build job still failed.
 *
 * ⚠ AND IT FAILS CONDITIONALLY, WHICH IS WORSE. Next only checks a `'use server'` module
 * once it is pulled into the client graph. BAL-390 shipped the identical violation in TWO
 * files: `app/review/_actions/submit-token-review.ts` (imported by the landing form →
 * broke the build) and `(dashboard)/engagements/[id]/_actions/submit-engagement-review.ts`
 * (zero callers until BAL-389 mounts it → built green, a landmine). A grep-based invariant
 * finds both regardless of reachability, which is exactly the property the build lacks.
 *
 * WHAT IS STILL ALLOWED, deliberately:
 *   - `export type` / `export interface` — erased at compile time; the rule is about VALUE
 *     exports. Most action files in this repo export their input/result types this way.
 *   - `export const fooAction = withAuth(async (…) => …)` and friends — the initializer
 *     resolves to an async function, which is what the rule asks for. Dozens of shipped
 *     actions do this.
 *
 * WHAT THIS TEST FLAGS: a value export whose initializer is a plain LITERAL — string,
 * template literal, number, boolean, array or object. Those are provably not async
 * functions, and they are precisely the class that broke the build. Narrow on purpose:
 * a rule that also flagged wrapper calls would fail on ~40 pre-existing, correct files.
 *
 * If this test fails: move the constant into a plain module that does NOT carry the
 * `'use server'` directive, and import it. For review copy that module is
 * `@/lib/reviews/messages`.
 */

/**
 * CI runs web vitest from the REPO ROOT while a developer runs it from `apps/web`, so a
 * single cwd-relative path resolves to nothing in one of the two — and a walk that finds
 * nothing passes every assertion for the wrong reason. A candidate list covers both
 * (`reference_web_server_disk_asset_cwd`); the non-vacuity test below catches an empty
 * result loudly rather than silently.
 */
const SRC_DIR =
  ['src', 'apps/web/src']
    .map((candidate) => path.resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate)) ?? '';

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx'];
const SKIPPED_DIRECTORIES: readonly string[] = ['node_modules', '.next', '__snapshots__'];

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.includes(entry.name)) found.push(...walk(full));
      continue;
    }
    if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name))) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    found.push(full);
  }
  return found;
}

/** A file is a Server Action module only if the directive is the first real statement. */
function hasUseServerDirective(source: string): boolean {
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
      continue;
    }
    return line === `'use server';` || line === `"use server";`;
  }
  return false;
}

/**
 * Drop whole comment lines so a docblock that MENTIONS `export const` cannot trip the
 * check. Line-oriented, so there is no regex (the SonarCloud S5852 ReDoS gate) and no
 * character-level state machine to get wrong.
 */
function stripCommentLines(source: string): string[] {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    kept.push(raw);
  }
  return kept;
}

/** Initializer characters that begin a literal — provably never an async function. */
const LITERAL_OPENERS: readonly string[] = [`'`, `"`, '`', '[', '{'];

function isLiteralValueExport(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('export const ') && !trimmed.startsWith('export let ')) return false;

  const equals = trimmed.indexOf('=');
  if (equals === -1) return false;

  const initializer = trimmed.slice(equals + 1).trim();
  if (initializer === '') return false; // value is on the next line — see the multiline note

  if (LITERAL_OPENERS.some((opener) => initializer.startsWith(opener))) return true;
  return (
    /^-?\d/.test(initializer) || initializer.startsWith('true') || initializer.startsWith('false')
  );
}

/**
 * `export const NAME =` with the value on the FOLLOWING line — the exact shape that broke
 * PR #191 (prettier wraps long strings this way). Checked as a pair so the wrap does not
 * hide it.
 */
function isWrappedLiteralValueExport(line: string, next: string | undefined): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('export const ') && !trimmed.startsWith('export let ')) return false;
  if (!trimmed.endsWith('=')) return false;
  if (next === undefined) return false;

  const initializer = next.trim();
  return (
    LITERAL_OPENERS.some((opener) => initializer.startsWith(opener)) || /^-?\d/.test(initializer)
  );
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    if (!hasUseServerDirective(source)) continue;

    const lines = stripCommentLines(source);
    lines.forEach((line, index) => {
      if (isLiteralValueExport(line) || isWrappedLiteralValueExport(line, lines[index + 1])) {
        violations.push({
          file: path.relative(SRC_DIR, file),
          line: index + 1,
          text: line.trim(),
        });
      }
    });
  }
  return violations;
}

describe("'use server' modules export only async functions", () => {
  it('finds Server Action modules to check (non-vacuity)', () => {
    expect(SRC_DIR).not.toBe('');
    const serverActionFiles = walk(SRC_DIR).filter((file) =>
      hasUseServerDirective(readFileSync(file, 'utf8'))
    );
    // ~90 action modules ship today; a walk that found nothing would pass every
    // assertion below for the wrong reason.
    expect(serverActionFiles.length).toBeGreaterThan(50);
  });

  it('no `use server` module exports a literal value', () => {
    const violations = findViolations();
    const rendered = violations.map((v) => `${v.file}:${v.line} → ${v.text}`).join('\n');
    expect(rendered, `\`'use server'\` files may export only async functions:\n${rendered}`).toBe(
      ''
    );
  });

  it('detects the PR #191 shape, both inline and prettier-wrapped (non-vacuity)', () => {
    expect(isLiteralValueExport(`export const REVIEW_SUBMIT_FAILED = "We couldn't save…";`)).toBe(
      true
    );
    expect(
      isWrappedLiteralValueExport('export const REVIEW_SUBMIT_FAILED =', '  "We couldn\'t…";')
    ).toBe(true);
    expect(isLiteralValueExport('export const MAX = 5;')).toBe(true);

    // …and does NOT flag the shapes that legitimately ship today.
    expect(isLiteralValueExport('export const saveDraftAction = withAuth(')).toBe(false);
    expect(isLiteralValueExport('export const doThing = async (input: X): Promise<Y> => {')).toBe(
      false
    );
    expect(isLiteralValueExport('export type SaveResult = { ok: true };')).toBe(false);
    expect(isLiteralValueExport('export interface SaveInput {')).toBe(false);
  });
});
