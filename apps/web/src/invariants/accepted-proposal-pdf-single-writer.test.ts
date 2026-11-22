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
 *  2. The set of files naming `acceptedProposalPdfKey` is exactly the builder, the freeze helper
 *     and the share action (which only reads the key to attach it). In particular the download
 *     route never names the key: it reaches the frozen copy through the helper alone.
 *  3. Of those, only the freeze helper calls `putProposalPdfToR2(`.
 *  4. The helper makes that call exactly once on the accepted key, and has exactly two
 *     writes in total (that one plus `ensureClientProposalPdf`'s versioned write), so a
 *     second accepted-key write through a local variable is caught too.
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

const KEY_NAMERS = [STORAGE_REL, HELPER_REL, SHARE_REL].sort();

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
    for (const rel of [...KEY_NAMERS, ROUTE_REL]) {
      expect(byRel.has(rel), `${rel} did not resolve to a scanned file`).toBe(true);
    }
  });

  it('the literal "accepted.pdf" appears as code only in the storage key builder', () => {
    expect(relsContaining(all, KEY_LITERAL)).toEqual([STORAGE_REL]);
  });

  it('only the builder, the freeze helper and the share action name acceptedProposalPdfKey', () => {
    expect(relsContaining(all, KEY_BUILDER)).toEqual(KEY_NAMERS);
    expect(byRel.get(ROUTE_REL)?.code.includes(KEY_BUILDER)).toBe(false);
  });

  it('of the files naming the key, only the freeze helper calls putProposalPdfToR2(', () => {
    const writers = KEY_NAMERS.filter((rel) => rel !== STORAGE_REL).filter((rel) =>
      byRel.get(rel)?.code.includes(PUT_CALL)
    );
    expect(writers).toEqual([HELPER_REL]);
  });

  it('the freeze helper writes the accepted key exactly once', () => {
    const helper = byRel.get(HELPER_REL);
    expect(helper).toBeDefined();
    expect(occurrences(helper?.code ?? '', FROZEN_WRITE)).toBe(1);
    expect(occurrences(helper?.code ?? '', PUT_CALL)).toBe(2);
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
