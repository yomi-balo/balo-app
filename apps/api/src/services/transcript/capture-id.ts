/**
 * BAL-517 — the `daily-batch:` capture-id convention, factored out of
 * `jobs/transcript-capture.ts` into a shared helper so `transcripts.capture_id` and
 * `meeting_recordings.transcript_job_id` — the ONLY link between the two tables, since there is
 * no FK — cannot drift into two independently-edited copies of the same string. If they drift,
 * `resolvePartyHint` (`party-hint/resolve.ts`) returns `capture_id_unrecognised` forever: the
 * party hint disappears silently with every gate green.
 *
 * ⚠ NO BEHAVIOUR CHANGE. `dailyBatchCaptureId` produces the exact template-literal string
 * `jobs/transcript-capture.ts` wrote inline before this PR (still pinned independently by
 * `transcript-capture.test.ts`'s own literal-based assertions).
 */

export const DAILY_BATCH_CAPTURE_ID_PREFIX = 'daily-batch:' as const;

/** The `transcripts.capture_id` written for a Daily Batch Processor job. */
export function dailyBatchCaptureId(batchJobId: string): string {
  return `${DAILY_BATCH_CAPTURE_ID_PREFIX}${batchJobId}`;
}

/**
 * The inverse: recover the batch job id from a `transcripts.capture_id`. `null` when the
 * capture id does not follow the convention (a different vendor, or a malformed/empty
 * remainder) — never a throw, since an unrecognised capture id is a normal "no hint" input,
 * not an error.
 */
export function dailyBatchJobIdFromCaptureId(captureId: string): string | null {
  if (!captureId.startsWith(DAILY_BATCH_CAPTURE_ID_PREFIX)) {
    return null;
  }
  // Named `batchJobId`, not `jobId` — this is a Daily Batch Processor job id, never a BullMQ
  // jobId, and the `colon-free-job-ids` invariant (BAL-531) keys on the literal name `jobId`
  // for its "must go through buildJobId()" scan. Same naming precedent as
  // `services/daily/batch-processor.ts`'s `getBatchJobTranscriptLink`.
  const batchJobId = captureId.slice(DAILY_BATCH_CAPTURE_ID_PREFIX.length);
  return batchJobId.length === 0 ? null : batchJobId;
}
