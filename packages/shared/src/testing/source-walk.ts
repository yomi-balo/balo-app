import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A cwd-independent recursive source-file walker, shared by the STRUCTURAL-INVARIANT suites
 * (`packages/db/src/invariants/*.test.ts` and siblings elsewhere) that each source-scan
 * `apps/*`/`packages/*` for a property that must hold across trees.
 *
 * ⚠ WHY THIS EXISTS. `admin-alert-kinds-have-exactly-one-writer.test.ts` documented its own
 * walker as copying `audit-trail-ordering.test.ts`'s "rather than inventing a fourth scanner"
 * — an explicit acceptance of duplication. A THIRD copy (for A-F7's facts-concealment
 * invariant) pushed that duplication over SonarCloud's new-code gate. This module is the fix:
 * ONE implementation, the same `stripComments` precedent from this same directory ("a second
 * copy is both a Sonar new-code duplication finding and a copy that keeps passing after the
 * original's scanner is fixed").
 *
 * Existing callers that copied the walker inline are left as-is (not this ticket's scope to
 * touch); new invariants should use this module instead of adding a fourth copy.
 */

const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', '.next']);

function isSkippedDir(name: string): boolean {
  return SKIPPED_DIR_NAMES.has(name) || name.startsWith('coverage');
}

function isTestFileName(name: string): boolean {
  return (
    name.endsWith('.test.ts') ||
    name.endsWith('.test.tsx') ||
    name.endsWith('.spec.ts') ||
    name.endsWith('.spec.tsx')
  );
}

function listRecursive(dir: string, selfPath: string | undefined): string[] {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return isSkippedDir(entry.name) ? [] : listRecursive(abs, selfPath);
    }
    if (!entry.isFile()) return [];
    if (!(abs.endsWith('.ts') || abs.endsWith('.tsx'))) return [];
    if (selfPath !== undefined && abs === selfPath) return [];
    // A test may legitimately NAME the construct under test while proving something about
    // it — excluded from the walk entirely, the house rule every existing walker states.
    if (isTestFileName(entry.name)) return [];
    return [abs];
  });
}

export interface WalkSourceTreesInput {
  /** Absolute path of the repo root every entry in `rootNames` — and every `displayPath` this
   *  module returns — is relative to. Callers compute it as
   *  `fileURLToPath(new URL('<../.. to repo root>', import.meta.url))`. */
  readonly repoRoot: string;
  /** Repo-root-relative directories to walk, e.g. `['packages/db/src', 'apps/api/src']`. */
  readonly rootNames: readonly string[];
  /** Absolute path of the CALLING test file (`fileURLToPath(import.meta.url)`) — excluded
   *  from its own walk. */
  readonly selfPath?: string;
}

/** Every non-test `.ts`/`.tsx` file under each of `rootNames`, as absolute paths. */
export function listSourceFiles(input: WalkSourceTreesInput): string[] {
  return input.rootNames.flatMap((root) =>
    listRecursive(path.join(input.repoRoot, root), input.selfPath)
  );
}

/** Display path relative to `repoRoot`, POSIX-separated regardless of platform. */
export function toDisplayPath(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

export interface ScannedFile {
  readonly displayPath: string;
  readonly source: string;
}

/**
 * `listSourceFiles(input)`, pre-filtered to files whose RAW source contains `mentionSubstring`
 * (case-insensitive on the raw text), each then read once more and passed through
 * `stripCommentsFn`. The two-pass shape — cheap raw substring check before the more expensive
 * strip — mirrors every existing invariant walker in this repo.
 */
export function scanMentioningFiles(
  input: WalkSourceTreesInput,
  mentionSubstring: string,
  stripCommentsFn: (source: string) => string
): ScannedFile[] {
  const needle = mentionSubstring.toLowerCase();
  return listSourceFiles(input)
    .filter((abs) => readFileSync(abs, 'utf8').toLowerCase().includes(needle))
    .map((abs) => ({
      displayPath: toDisplayPath(input.repoRoot, abs),
      source: stripCommentsFn(readFileSync(abs, 'utf8')),
    }));
}
