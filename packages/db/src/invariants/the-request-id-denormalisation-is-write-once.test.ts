import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT (BAL-546, orchestrator D8) — THE DENORMALISED `project_request_id` COLUMN ON
 * `proposals` AND `request_expert_relationships` IS WRITE-ONCE: SET AT INSERT, NEVER UPDATED.
 *
 * `_shared/request-lock.ts`'s `acquireRequestLockViaRelationshipTx` / `acquireRequestLockViaProposalTx`
 * resolve the per-request advisory lock's key from a PLAIN, UNLOCKED pre-read of this column.
 * That read is racy IN PRINCIPLE — nothing stops a concurrent writer from mutating the row
 * between the read and the lock — and it is safe to leave unlocked ONLY because the column this
 * package writes is write-once: if it were ever updated in place, the unlocked read could resolve
 * to a request the caller no longer belongs to, and the "lock" would serialise against the WRONG
 * request. This file is the mechanical pin for that premise.
 *
 * ⚠ WHY A SOURCE SCAN, NOT A BEHAVIOURAL TEST. There is no runtime signal that distinguishes "no
 * writer happens to update this column today" from "no writer CAN update this column" — both look
 * identical to an integration suite. A source scan is the only way to make a future `.set({
 * projectRequestId: … })` fail LOUDLY, at the point it is written, rather than silently
 * reintroducing the exact race the pre-lock read is not supposed to have.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST (`@balo/shared/testing`'s `stripComments`) — this docblock and
 * others legitimately NAME `projectRequestId` in prose to explain the rule; a naive scan would
 * trip on its own documentation.
 */

const REPO_DISPLAY_ROOT = 'packages/db/src/repositories/';

/** Every `.ts` file under `dir`, recursively — an UNFILTERED walk (includes `*.test.ts`). */
function listTsFilesRecursive(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFilesRecursive(abs);
    return entry.isFile() && abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Brace-match a `{ ... }` object literal starting at the `{` found at `openIndex`. */
function braceMatch(src: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const char = src.charAt(i);
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(openIndex, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces from index ${openIndex} while brace-matching a .set({...}).`);
}

interface SetBlock {
  file: string;
  line: number;
  block: string;
}

/**
 * Every `.set({ ... })` object-literal body found across the (comment-stripped) repository
 * walk, with its source file and 1-based line number. The regex is a simple, non-overlapping,
 * linear match on `.set(` followed by optional whitespace and `{` — no nested quantifiers, no
 * super-linear backtracking (SonarCloud S5852).
 *
 * ⚠ fix round F8 — COVERAGE BOUNDARY, NAMED RATHER THAN IMPLIED COVERED. The regex only sees
 * INLINE object literals opened directly inside `.set(`; a `.set(payload)` or
 * `.set({ ...patch })` built from a variable would escape this scan entirely and write
 * `projectRequestId` invisibly to the invariant above. That form does not exist anywhere in
 * this repository today, and the positive control below (which does match a real inline
 * `.set({ status: … })`) is what makes that a real coverage boundary rather than a scan that
 * happens to match nothing.
 */
function findAllSetBlocks(): SetBlock[] {
  const repoDir = fileURLToPath(new URL('../repositories/', import.meta.url));
  const files = listTsFilesRecursive(repoDir);
  const blocks: SetBlock[] = [];

  for (const abs of files) {
    const stripped = stripComments(readFileSync(abs, 'utf8'));
    const pattern = /\.set\(\s*\{/g;
    let match = pattern.exec(stripped);
    while (match !== null) {
      const openBraceIndex = stripped.indexOf('{', match.index);
      const block = braceMatch(stripped, openBraceIndex);
      const line = stripped.slice(0, match.index).split('\n').length;
      blocks.push({
        file: REPO_DISPLAY_ROOT + abs.slice(repoDir.length),
        line,
        block,
      });
      pattern.lastIndex = openBraceIndex + block.length;
      match = pattern.exec(stripped);
    }
  }

  return blocks;
}

describe('INVARIANT: projectRequestId is write-once — no repository .set({...}) ever names it (BAL-546, D8)', () => {
  const blocks = findAllSetBlocks();

  it('⚠ POSITIVE CONTROL — the matcher really reaches update payloads (non-vacuity)', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.block.includes('status:'))).toBe(true);
  });

  it('no repository .set({...}) writes projectRequestId — the offender list is empty', () => {
    const offenders = blocks
      .filter((b) => b.block.includes('projectRequestId'))
      .map((b) => `${b.file}:${b.line}`);
    expect(offenders).toEqual([]);
  });
});
