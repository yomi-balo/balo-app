import { describe, expect, it } from 'vitest';
import { occurrences, scanWorkspaceSources, type ScannedFile } from './_source-scan';

/**
 * BAL-668 — structural invariant: **an accepted proposal's frozen PDF has exactly one writer.**
 *
 * The frozen copy lives at `acceptedProposalPdfKey(proposalId)` and must be written once, by
 * `freezeAcceptedProposalPdf` (`ensure-client-pdf.ts`) — never by a caller that overwrites it, and
 * never by a path that re-renders it. Four properties pin that:
 *
 *  1. The literal `accepted.pdf` exists, as code, only inside the key builder.
 *  2. The set of files naming `acceptedProposalPdfKey` is exactly the builder and the freeze
 *     helper. No caller names the key: the helper RETURNS it (`{ key, bytes }`), so the share
 *     action reads the key from the helper's result and the download route reaches the frozen
 *     copy through the helper alone. A caller that could name the key could pass it to an
 *     overwriting writer and walk around this scan.
 *  3. Of those, only the freeze helper calls `putProposalPdfToR2(`.
 *  4. The helper makes that call exactly once on the accepted key, and that call is conditional
 *     (`{ ifAbsent: true }`, so storage refuses a second write). The helper has exactly two
 *     writes in total (that one plus `ensureClientProposalPdf`'s versioned write), so a
 *     second accepted-key write through a local variable is caught too. The other write is pinned
 *     to the versioned key.
 *
 * This scan is a regression tripwire on names, not the guarantee. A caller holding the key from
 * the helper's result could still hand it to some other writer. The guarantee lives in the one
 * write path: `putProposalPdfToR2` refuses any write to an `accepted.pdf` key without
 * `ifAbsent`, and the conditional write itself (`If-None-Match: *`) is refused by R2 when a copy
 * already exists. `proposal-pdf.test.ts` pins that refusal.
 *
 * The scan is the whole workspace, unfiltered, with the narrowing done in memory (see
 * `scanWorkspaceSources`), so a new caller dropped anywhere fails set equality loudly.
 */

const STORAGE_REL = 'apps/web/src/lib/storage/proposal-pdf.ts';
const HELPER_REL = 'apps/web/src/lib/project-request/proposal/pdf/ensure-client-pdf.ts';
const SHARE_REL =
  'apps/web/src/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share.ts';
const ROUTE_REL =
  'apps/web/src/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/pdf/route.ts';

const KEY_BUILDER = 'acceptedProposalPdfKey';
const KEY_LITERAL = 'accepted.pdf';
const PUT_CALL = 'putProposalPdfToR2(';
const FROZEN_WRITE = 'putProposalPdfToR2(acceptedProposalPdfKey(';
// The same call, carrying the conditional-put option (whitespace-tolerant: Prettier wraps it).
const CONDITIONAL_FROZEN_WRITE =
  /putProposalPdfToR2\(\s*acceptedProposalPdfKey\([^()]*\),\s*bytes,\s*\{\s*ifAbsent: true,?\s*\}\s*\)/g;

const KEY_NAMERS = [STORAGE_REL, HELPER_REL].sort();

function relsContaining(files: readonly ScannedFile[], needle: string): string[] {
  return files
    .filter((file) => file.code.includes(needle))
    .map((file) => file.rel)
    .sort();
}

describe('invariant: the accepted proposal PDF has exactly one writer (BAL-668)', () => {
  const all = scanWorkspaceSources();
  const byRel = new Map(all.map((file) => [file.rel, file]));

  it('scans the full workspace and every pinned path resolves (guards against a vacuous pass)', () => {
    expect(all.length).toBeGreaterThan(500);
    for (const rel of [...KEY_NAMERS, SHARE_REL, ROUTE_REL]) {
      expect(byRel.has(rel), `${rel} did not resolve to a scanned file`).toBe(true);
    }
  });

  it('the literal "accepted.pdf" appears as code only in the storage key builder', () => {
    expect(relsContaining(all, KEY_LITERAL)).toEqual([STORAGE_REL]);
  });

  it('only the builder and the freeze helper name acceptedProposalPdfKey', () => {
    expect(relsContaining(all, KEY_BUILDER)).toEqual(KEY_NAMERS);
    expect(byRel.get(SHARE_REL)?.code.includes(KEY_BUILDER)).toBe(false);
    expect(byRel.get(ROUTE_REL)?.code.includes(KEY_BUILDER)).toBe(false);
  });

  it('of the files naming the key, only the freeze helper calls putProposalPdfToR2(', () => {
    const writers = KEY_NAMERS.filter((rel) => rel !== STORAGE_REL).filter((rel) =>
      byRel.get(rel)?.code.includes(PUT_CALL)
    );
    expect(writers).toEqual([HELPER_REL]);
  });

  it('the freeze helper writes the accepted key exactly once, conditionally', () => {
    const helper = byRel.get(HELPER_REL);
    expect(helper).toBeDefined();
    expect(occurrences(helper?.code ?? '', FROZEN_WRITE)).toBe(1);
    expect(helper?.code.match(CONDITIONAL_FROZEN_WRITE)?.length).toBe(1);
    expect(occurrences(helper?.code ?? '', PUT_CALL)).toBe(2);
    expect(occurrences(helper?.code ?? '', 'putProposalPdfToR2(proposalPdfKey(')).toBe(1);
  });

  it('⚠ guards the guard: a stray writer or a second key reference would be caught', () => {
    const decoy: ScannedFile = {
      rel: 'apps/web/src/decoy.ts',
      code: `await putProposalPdfToR2(${KEY_BUILDER}(id), bytes); const k = '${KEY_LITERAL}';`,
      raw: '',
    };
    const withDecoy = [...all, decoy];
    expect(relsContaining(withDecoy, KEY_BUILDER)).not.toEqual(KEY_NAMERS);
    expect(relsContaining(withDecoy, KEY_LITERAL)).not.toEqual([STORAGE_REL]);
  });
});
