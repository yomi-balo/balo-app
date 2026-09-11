import { describe, it, expect } from 'vitest';
import { readRaw, markersInCode } from './_source-scan.js';

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
