import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { meetingRecordings, transcripts } from '../schema';

/**
 * BAL-550 (D5) — "the recap re-drive cannot touch `transcript_job_*`", the RUNTIME half.
 *
 * ⚠⚠ THE TYPE-LEVEL HALF IS **NOT** HERE, AND THAT IS DELIBERATE. `@balo/db` has no
 * `typecheck` script (memory `reference_db_shared_no_typecheck_lint_scripts`) and vitest's
 * esbuild strips types WITHOUT checking them, so a `const x: [K] extends [never] ? true :
 * false = true` in THIS file would be vacuously green twice over. The real brace lives in
 * `repositories/transcripts.ts` — `_TranscriptsCarryNoTranscriptJobColumn` and the
 * `@ts-expect-error`'d `_TranscriptJobWriteIsUnrepresentable` — which `apps/api`'s
 * `tsc --noEmit` compiles because `apps/api/src` imports `transcriptsRepository`. That pin was
 * falsified: adding a `transcript_job_finished_at` column to `schema/transcripts.ts` makes
 * `pnpm --filter api typecheck` fail with BOTH TS2344 and TS2578.
 *
 * What THIS file holds is the SCHEMA FACT that brace rests on, asserted at runtime against the
 * real Drizzle table objects: `transcripts` carries no `transcript_job_*` column, and
 * `meeting_recordings` — the table that genuinely owns the BAL-483 batch state — carries
 * exactly four. No database required.
 */

const JOB_COLUMN_PREFIX = 'transcript_job_';

/** Every DB column name on a table whose name begins with the batch-job prefix. */
function jobColumnNames(table: typeof transcripts | typeof meetingRecordings): string[] {
  return Object.values(getTableColumns(table))
    .map((column) => column.name)
    .filter((name) => name.startsWith(JOB_COLUMN_PREFIX))
    .sort((a, b) => a.localeCompare(b));
}

describe('BAL-550 — the recap re-drive cannot address a transcript_job_* column', () => {
  it('`transcripts` declares NO `transcript_job_*` column, so `claimRecapResume` cannot name one', () => {
    expect(jobColumnNames(transcripts)).toEqual([]);
  });

  it('GUARDS THE GUARD: `meeting_recordings` declares exactly the four that DO exist', () => {
    // Without this case the assertion above would also pass if `jobColumnNames` were broken
    // (a wrong accessor, an empty column map), which is precisely how an invariant test dies
    // quietly. These four are BAL-483's batch-transcription state, and they are the columns
    // the recap re-drive must remain unable to reach.
    expect(jobColumnNames(meetingRecordings)).toEqual([
      'transcript_job_failure_reason',
      'transcript_job_finished_at',
      'transcript_job_id',
      'transcript_job_submitted_at',
    ]);
  });
});
