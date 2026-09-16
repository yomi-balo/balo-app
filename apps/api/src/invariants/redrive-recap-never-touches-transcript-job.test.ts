import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { readRaw, codeLines, markersInCode, collectSourceFiles, SRC_DIR } from './_source-scan.js';

/**
 * BAL-550 (D5) — the BELT to `packages/db/src/repositories/transcripts.ts`'s TYPE-LEVEL brace
 * (`_TranscriptsCarryNoTranscriptJobColumn` / `transcripts.redrive-type.test.ts`): the recap
 * re-drive's OWN modules must never even NAME `meetingRecordingsRepository` (the table the
 * `transcript_job_*` columns actually live on) or call any `markTranscriptJob*` member.
 *
 * ⚠ SCOPED TO THE RECAP-RESUME MODULES ONLY, NOT `services/admin/redrive.ts`. That orchestrator
 * legitimately imports `meetingRecordingsRepository` for the OTHER kind
 * (`recording-ingest`'s CAS) — scanning it here would be a false positive on a file that has
 * every reason to import it. The two files below are exactly the surface D5's resume path
 * reaches: the pipeline service (`runRecapStages` / `resumeTranscriptRecap`) and the job's
 * discriminated worker + resume enqueue.
 *
 * ⚠ USES THE SHARED `_source-scan.ts` PRIMITIVES (`readRaw` / `markersInCode`), not the
 * `repositoryMemberCallsOf` / `namedImportsFrom` helpers `apps/web`'s invariants use — those
 * live only in `apps/web/src/invariants/_source-scan.ts` today. A raw substring scan over
 * non-comment lines gives the same guarantee (the identifier cannot appear at all, so it can
 * be neither imported nor called) with no new helper surface.
 *
 * ⚠⚠ BAL-517 — THIS INVARIANT'S INTENT is that the recap re-drive can never WRITE or reset
 * batch-transcription state (which could re-submit and double-bill a Daily batch job). It says
 * nothing about READS. The party-hint derivation needs exactly one READ of `meeting_recordings`
 * — the segment's `started_at` +
 * meeting id, via `findByTranscriptJobId` — and that read lives in its OWN module,
 * `services/transcript/party-hint/resolve.ts`, NOT in `pipeline.ts` or
 * `jobs/transcript-pipeline.ts` (both of which still pass the scan above UNCHANGED — `resolve.ts`
 * is not on `RECAP_RESUME_MODULES`, and moving the read there is not a way around this
 * invariant; it is pinned separately, below, with its own tighter rule: this ONE read is
 * allowed, and named ONLY that way).
 */
const RECAP_RESUME_MODULES = [
  'services/transcript/pipeline.ts',
  'jobs/transcript-pipeline.ts',
] as const;

const FORBIDDEN_MARKERS = [
  'meetingRecordingsRepository',
  'markTranscriptJobSubmitted',
  'markTranscriptJobSubmitFailed',
  'markTranscriptJobFinished',
  'markTranscriptJobFailed',
] as const;

describe('the recap re-drive modules never touch transcript_job_* / meetingRecordingsRepository', () => {
  it.each(RECAP_RESUME_MODULES)('%s references no forbidden marker', (rel) => {
    const found = markersInCode(readRaw(rel), FORBIDDEN_MARKERS);
    expect(found).toEqual([]);
  });

  // Non-vacuity: prove the marker scan actually fires on a shape that IS forbidden, so an
  // accidentally-broken matcher does not make every case above pass for the wrong reason.
  it('guards the guard — the scan fires on a file that DOES reference the forbidden markers', () => {
    const found = markersInCode(readRaw('services/admin/redrive.ts'), FORBIDDEN_MARKERS);
    expect(found).toContain('meetingRecordingsRepository');
  });
});

/** No regex (S5852) — a plain `indexOf` walk, mirroring `_source-scan.ts`'s own house rule. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

describe('the party-hint resolver only READS meeting_recordings (findByTranscriptJobId) and marks nothing', () => {
  const raw = readRaw('services/transcript/party-hint/resolve.ts');
  const code = codeLines(raw);

  it('never names a markTranscriptJob* member', () => {
    const found = markersInCode(
      raw,
      FORBIDDEN_MARKERS.filter((marker) => marker !== 'meetingRecordingsRepository')
    );
    expect(found).toEqual([]);
  });

  it('calls findByTranscriptJobId exactly once (non-vacuity: the scan actually fires)', () => {
    expect(occurrences(code, 'meetingRecordingsRepository.findByTranscriptJobId(')).toBe(1);
  });

  it('names meetingRecordingsRepository exactly twice: the import, and that one call', () => {
    expect(occurrences(code, 'meetingRecordingsRepository')).toBe(2);
  });
});

/**
 * BAL-517 — the scan above names only `resolve.ts` by hand. Widen it to EVERY non-test file
 * under `services/transcript/party-hint/` via the shared `collectSourceFiles` walk, so a future
 * helper module added there is swept in automatically rather than opting out by not being
 * listed (the same `_source-scan.ts` house rule `sync-token-parity.test.ts` documents).
 * `__fixtures__/` is excluded — it is test data, not production code, and legitimately has no
 * reason to avoid naming a repository at all.
 */
const PARTY_HINT_DIR = 'services/transcript/party-hint';
const PARTY_HINT_FIXTURES_PREFIX = `${PARTY_HINT_DIR}/__fixtures__/`;
const partyHintFiles = collectSourceFiles(
  path.join(SRC_DIR, PARTY_HINT_DIR),
  PARTY_HINT_DIR
).filter((rel) => !rel.startsWith(PARTY_HINT_FIXTURES_PREFIX));

describe('every non-test file under services/transcript/party-hint/ is scanned', () => {
  // Non-vacuity: prove the directory walk actually found the two files this invariant cares
  // about, so a broken glob (or an accidental exclusion) does not make every case below pass
  // for the wrong reason.
  it('the directory walk finds at least derive.ts and resolve.ts', () => {
    expect(partyHintFiles.length).toBeGreaterThanOrEqual(2);
    expect(partyHintFiles).toContain(`${PARTY_HINT_DIR}/derive.ts`);
    expect(partyHintFiles).toContain(`${PARTY_HINT_DIR}/resolve.ts`);
  });

  it.each(partyHintFiles)('%s never names a markTranscriptJob* member', (rel) => {
    const found = markersInCode(
      readRaw(rel),
      FORBIDDEN_MARKERS.filter((marker) => marker !== 'meetingRecordingsRepository')
    );
    expect(found).toEqual([]);
  });

  it.each(partyHintFiles.filter((rel) => rel !== `${PARTY_HINT_DIR}/resolve.ts`))(
    '%s never names meetingRecordingsRepository (only resolve.ts may read it)',
    (rel) => {
      const found = markersInCode(readRaw(rel), ['meetingRecordingsRepository']);
      expect(found).toEqual([]);
    }
  );
});
