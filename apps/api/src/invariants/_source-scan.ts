import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `_source-scan` — the shared reading primitives behind `apps/api`'s SOURCE invariants
 * (`sync-token-parity.test.ts`, `no-counterparty-address-on-calendar-writes.test.ts`,
 * `nodemailer-only-in-email-channel.test.ts`).
 *
 * ⚠ EXTRACTED, NOT INVENTED. BAL-447 shipped these functions inside `sync-token-parity.test.ts`;
 * BAL-433 needs the identical walk-and-classify for the counterparty-address ban, and a second
 * verbatim copy of ~60 lines in the SAME DIRECTORY is exactly the shape SonarCloud's >3%
 * new-code duplication gate exists to catch (memory `reference_sonar_duplication_not_caught_locally`).
 * The behaviour is unchanged from BAL-447's original, including the reasoning in its comments.
 * Mirrors `apps/web/src/invariants/_source-scan.ts`, which exists for the same reason.
 *
 * ⚠ THIS FILE IS NOT A TEST and is deliberately not named like one — vitest collects only
 * `*.test.ts` / `*.spec.ts` under `src`, so a helper module here is imported, never run as a
 * suite. It is nevertheless SCANNED by `sync-token-parity.test.ts`'s Scan E (whose exemption
 * list is `services/consultation-events/` only), so it must itself name no `events.list`,
 * `updatedAfter` or `expandRecurrences`.
 *
 * ⚠ SHARING THESE DOES NOT WEAKEN EITHER INVARIANT, because each caller carries its own
 * non-vacuity block (a subject-count floor plus named files that MUST appear) and its own
 * positive controls proving the matcher fires on a shape that is genuinely present. A silently
 * broken helper would make every absence assertion pass for the wrong reason, and those are the
 * tests that stop it — keep them when adding a third consumer.
 *
 * ⚠ NO REGEX ANYWHERE IN HERE, deliberately: these functions read source text, and a regex over
 * it is the SonarCloud S5852 / `regexp/no-super-linear-move` shape. `indexOf` / `includes` /
 * `split` only.
 *
 * ⚠ PATHS COME FROM `import.meta.url`, NOT `process.cwd()`. CI runs vitest from the REPO ROOT
 * while developers run it from `apps/api`, so a cwd-relative read resolves to nothing in one of
 * the two and ENOENTs in CI only (memory `reference_web_server_disk_asset_cwd`). `apps/api`'s
 * vitest environment is `node`, so `import.meta.url` is a real `file://` URL here. (It is NOT
 * usable in `apps/web`'s jsdom suites, which is why those use a candidate list instead.)
 */

/** `apps/api/src`. */
export const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/**
 * RAW source text of `apps/api/src/<rel>` — comments are NOT stripped.
 *
 * ⚠ THE RAW TEXT IS WHAT EVERY MARKER SCAN READS, AND THAT IS DELIBERATE. A stripper that
 * edits line CONTENTS mangles string literals; the classifier below drops whole comment LINES
 * instead, so a string literal containing `//` survives intact.
 */
export function readRaw(rel: string): string {
  return readFileSync(path.join(SRC_DIR, rel), 'utf8');
}

/**
 * Whether a line is a comment line. Conservative on purpose: `//` line comments, and the `*` /
 * `/*` opening forms of a block comment. Anything else — including a line whose comment starts
 * mid-line — counts as CODE, so a marker hidden after a trailing `//` still trips the scan.
 *
 * That errs toward FALSE ALARMS, and that is the correct direction for a fail-closed invariant
 * to be wrong in.
 *
 * ⚠ F10(d) (fix round 1, S5(d)) — AN OPEN-AND-CLOSED BLOCK COMMENT ON ONE LINE IS A COMMENT
 * ONLY WHEN NOTHING FOLLOWS ITS CLOSE MARKER. A line that opens and closes a block comment and
 * then continues with real code used to classify as a comment line IN FULL (any line starting
 * with the block-comment opener did), which let a marker sitting after the close evade every
 * scan in this directory — an adversarial-only bypass, but a real gap in a fail-closed
 * invariant's own classifier. A line that OPENS a block comment with no close marker at all (a
 * genuinely open block comment) still classifies as comment, unchanged.
 */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return true;
  if (trimmed.startsWith('/*')) {
    const closeIndex = trimmed.indexOf('*/');
    if (closeIndex === -1) return true;
    return trimmed.slice(closeIndex + 2).trim().length === 0;
  }
  return false;
}

/**
 * `raw` with its comment LINES removed, the remaining lines rejoined.
 *
 * This is the classifier, not a stripper: it never edits a line's contents, so a string literal
 * containing `//` survives intact.
 */
export function codeLines(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .join('\n');
}

/** Which of `markers` appear on at least one NON-comment line of `raw`. */
export function markersInCode(raw: string, markers: readonly string[]): string[] {
  const code = codeLines(raw);
  return markers.filter((marker) => code.includes(marker));
}

/**
 * BAL-475 — trimmed NON-comment lines of `raw` containing at least one of `markers`, in file
 * order. The line-level sibling of `markersInCode` (which answers only "which markers, at
 * all"): `no-counterparty-address-on-calendar-writes.test.ts`'s pinned exception needs the
 * exact LINES themselves, so it can assert they equal a fixed, verbatim list.
 */
export function markerLinesInCode(raw: string, markers: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of raw.split('\n')) {
    if (isCommentLine(line)) continue;
    const trimmed = line.trim();
    if (markers.some((marker) => trimmed.includes(marker))) {
      found.push(trimmed);
    }
  }
  return found;
}

/**
 * BAL-475 — trimmed lines strictly between the first line whose `trimStart()` starts with
 * `signaturePrefix` and the first later line that is EXACTLY `}` (a top-level function close).
 * `[]` if the prefix is absent. Comment lines are NOT excluded here — the pinned exception
 * matches on line CONTENT only ("must stay inside the function"), not on whether a line is a
 * comment.
 */
export function functionBodyLines(raw: string, signaturePrefix: string): string[] {
  const lines = raw.split('\n');
  const startIndex = lines.findIndex((line) => line.trimStart().startsWith(signaturePrefix));
  if (startIndex === -1) return [];

  const body: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? '';
    if (trimmed === '}') break;
    body.push(trimmed);
  }
  return body;
}

/**
 * Every non-test, non-`.d.ts` TypeScript file under `dir` — `.ts` AND `.tsx` (BAL-396 fix round
 * 2, Finding 3: a `.ts`-only filter left every `.tsx` file, all 51 of them under
 * `notifications/channels/templates/`, unscanned) — as paths relative to it.
 *
 * Test files are excluded because a test may legitimately NAME a forbidden construct while
 * proving it absent — every invariant in this directory being the obvious example.
 */
export function collectSourceFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectSourceFiles(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
    out.push(rel);
  }
  return out;
}

/**
 * The whole `apps/api/src` source surface, walked ONCE at module load.
 *
 * ⚠ EVERY SCAN DERIVES ITS SUBJECTS FROM THIS WALK, AND NONE PINS A FILE LIST. A pinned
 * subject list lets a NEW file opt out by simply not being listed — empirically reproduced
 * during BAL-447's review, where a fresh `services/calendar/<name>.ts` passed every assertion.
 * New files are precisely the risk these invariants exist for.
 */
export const ALL_SOURCE_FILES = collectSourceFiles(SRC_DIR, '');

/** True when `rel` equals, or falls under, one of `dirsOrFiles`. No regex (S5852). */
export function isUnderAny(rel: string, dirsOrFiles: readonly string[]): boolean {
  return dirsOrFiles.some((entry) => rel === entry || rel.startsWith(entry));
}
