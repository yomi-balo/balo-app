import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listSourceFiles, stripComments, toDisplayPath } from '@balo/shared/testing';

/**
 * ⚠⚠ INVARIANT (BAL-632, ADR-1046 §2) — `engagements.delivering_agency_id` IS A CREATION STAMP:
 * WRITTEN ONCE, BY `insertEngagementRowTx`, AND NEVER UPDATED.
 *
 * The column records which agency delivered an engagement. Agency-scoped rights read it instead of
 * the expert profile's live `agency_id`, so an expert whose profile later links a different agency
 * neither takes the engagement with them nor hands it to the new agency. That only holds while the
 * value cannot be rewritten: one `.set({ deliveringAgencyId })` would turn the stamp back into a
 * live derivation.
 *
 * WHAT IS SCANNED. Production repository source only — every non-test `.ts` file under
 * `packages/db/src/repositories/`. Test factories and fixtures seed the column directly and sit
 * outside this rule.
 *
 *   1. Every inline write payload — `.set({ … })`, `.values({ … })` and an `onConflictDoUpdate`
 *      `set: { … }` — is collected. The ONLY one that may name `deliveringAgencyId` is the
 *      `.values({ … })` in `_shared/engagement-supertype.ts` (`insertEngagementRowTx`), and it
 *      must still be there.
 *   2. No source contains the raw column name `delivering_agency_id`, which is how a raw-SQL write
 *      would have to spell it.
 *   3. The only `.insert(engagements)` is the one in `insertEngagementRowTx`, and no source inserts
 *      into `engagements` in raw SQL. Rules 1 and 2 bound the writers of the pin; this rule makes
 *      every new engagement pass through the one writer, so none is created with its pin unset.
 *
 * ⚠ COVERAGE BOUNDARY. The matcher sees INLINE object literals only. A payload built in a
 * variable (`.values(row)`, `.set(patch)`, `.values([{ … }])`, `{ ...patch }`) escapes it. No such
 * payload targets `engagements` today; the positive control below proves the matcher reaches real
 * payloads, so an empty offender list is a real result rather than a scan that matched nothing.
 *
 * ⚠ COMMENTS ARE STRIPPED FIRST (`@balo/shared/testing`'s `stripComments`): docblocks name the
 * column in prose to explain it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPOSITORIES_ROOT = 'packages/db/src/repositories';
const STAMP_FILE = `${REPOSITORIES_ROOT}/_shared/engagement-supertype.ts`;

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
  throw new Error(`Unbalanced braces from index ${openIndex} while brace-matching a payload.`);
}

type PayloadKind = 'set' | 'values' | 'conflict-set';

interface RepositorySource {
  file: string;
  raw: string;
  stripped: string;
}

interface PayloadBlock {
  kind: PayloadKind;
  source: RepositorySource;
  /** Offset of the payload opener in `source.stripped`. */
  strippedIndex: number;
  block: string;
}

/**
 * The 1-based line, in the RAW file, of the character at `strippedIndex` in its comment-stripped
 * text. `stripComments` drops block comments whole (newlines included), so a line counted on the
 * stripped text drifts. The stripped length of a raw prefix never decreases as the prefix grows,
 * so a binary search finds the raw offset. Run only for a failure message.
 */
function rawLineOf(source: RepositorySource, strippedIndex: number): number {
  let low = 0;
  let high = source.raw.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (stripComments(source.raw.slice(0, mid + 1)).length > strippedIndex) high = mid;
    else low = mid + 1;
  }
  return source.raw.slice(0, low).split('\n').length;
}

function locate(b: PayloadBlock): string {
  return `${b.kind} ${b.source.file}:${rawLineOf(b.source, b.strippedIndex)}`;
}

/** Every non-test source file under the repositories tree, comment-stripped. */
function readRepositorySources(): RepositorySource[] {
  return listSourceFiles({ repoRoot: REPO_ROOT, rootNames: [REPOSITORIES_ROOT] }).map((abs) => {
    const raw = readFileSync(abs, 'utf8');
    return { file: toDisplayPath(REPO_ROOT, abs), raw, stripped: stripComments(raw) };
  });
}

function kindOf(opener: string): PayloadKind {
  if (opener === '.set(') return 'set';
  if (opener === '.values(') return 'values';
  return 'conflict-set';
}

/**
 * Every inline write payload in the given sources. The regex is a linear match on one of three
 * literal openers followed by optional whitespace and `{` — no nested quantifiers, no super-linear
 * backtracking (SonarCloud S5852). A matched block is skipped over whole, so a `set: {` nested
 * inside an already-collected payload is not collected twice.
 */
function findAllPayloadBlocks(sources: RepositorySource[]): PayloadBlock[] {
  const blocks: PayloadBlock[] = [];

  for (const source of sources) {
    const { stripped } = source;
    const pattern = /(\.set\(|\.values\(|\bset:)\s*\{/g;
    let match = pattern.exec(stripped);
    while (match !== null) {
      const openBraceIndex = stripped.indexOf('{', match.index);
      const block = braceMatch(stripped, openBraceIndex);
      blocks.push({ kind: kindOf(match[1] ?? ''), source, strippedIndex: match.index, block });
      pattern.lastIndex = openBraceIndex + block.length;
      match = pattern.exec(stripped);
    }
  }

  return blocks;
}

describe('INVARIANT: engagements.delivering_agency_id is write-once — only insertEngagementRowTx writes it (BAL-632)', () => {
  const sources = readRepositorySources();
  const blocks = findAllPayloadBlocks(sources);

  it('⚠ POSITIVE CONTROL — the matcher really reaches write payloads (non-vacuity)', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.kind === 'set' && b.block.includes('status:'))).toBe(true);
    expect(blocks.some((b) => b.kind === 'values')).toBe(true);
    expect(blocks.some((b) => b.kind === 'conflict-set')).toBe(true);
  });

  it('the only payload naming deliveringAgencyId is the insertEngagementRowTx .values({...})', () => {
    const writers = blocks.filter((b) => b.block.includes('deliveringAgencyId'));
    const kindAndFile = writers.map((b) => `${b.kind} ${b.source.file}`);
    const expected = [`values ${STAMP_FILE}`];
    const message =
      kindAndFile.join('|') === expected.join('|')
        ? ''
        : `payloads naming deliveringAgencyId: ${writers.map(locate).join(', ') || 'none'}`;
    expect(kindAndFile, message).toEqual(expected);
  });

  it('every engagement insert goes through insertEngagementRowTx, so every new row is stamped', () => {
    const inserts = sources.flatMap((s) =>
      [...s.stripped.matchAll(/\.insert\(\s*(?:\w+\.)?engagements\s*\)/g)].map(
        (m) => `${s.file}:${rawLineOf(s, m.index ?? 0)}`
      )
    );
    expect(
      inserts.map((at) => at.slice(0, at.lastIndexOf(':'))),
      inserts.join(', ')
    ).toEqual([STAMP_FILE]);

    const rawInserts = sources
      .filter((s) => /insert\s+into\s+"?engagements"?[\s(]/i.test(s.stripped))
      .map((s) => s.file);
    expect(rawInserts).toEqual([]);
  });

  it('no repository source spells the raw column name delivering_agency_id', () => {
    const offenders = sources
      .filter((s) => s.stripped.includes('delivering_agency_id'))
      .map((s) => `${s.file}:${rawLineOf(s, s.stripped.indexOf('delivering_agency_id'))}`);
    expect(offenders).toEqual([]);
  });
});
