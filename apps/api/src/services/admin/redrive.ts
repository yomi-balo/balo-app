import {
  auditEventsRepository,
  db,
  meetingRecordingsRepository,
  transcriptsRepository,
} from '@balo/db';
import type { RedriveKind } from '@balo/shared/capture-health';
import { createLogger } from '@balo/shared/logging';
import { enqueueRecordingIngest } from '../../jobs/recording-ingest.js';
import { enqueueTranscriptRecapResume } from '../../jobs/transcript-pipeline.js';

const log = createLogger('admin-redrive');

/**
 * `services/admin/redrive.ts` (BAL-550) — the ONE place that performs a capture-health
 * re-drive: the kind's CAS, the audit row, and the post-commit enqueue, in that order.
 *
 * ⚠⚠ THE AUDIT ROW PRECEDES THE ENQUEUE, AND THE ENQUEUE IS POST-COMMIT. Enqueueing INSIDE the
 * transaction would be strictly worse: a rollback after a successful `queue.add` would leave a
 * job pointing at a row that never moved. The residual this accepts instead — a committed CAS
 * + audit row with NO job, on an enqueue throw — is documented below and answered with a
 * `502` the caller can act on (the `auditEventId` is in the response and the log line).
 *
 * ⚠ DOUBLE-CLICK PRODUCES ONE JOB — BY THE CAS, NOT BY THE JOBID. The second request finds the
 * row no longer in the CAS's prior state, matches zero rows, and this returns `not_redrivable`
 * with NO audit row and NO job written. Two genuinely concurrent requests serialise on the
 * row's UPDATE lock; the loser matches zero rows for the same reason. The disjoint jobId (D2)
 * solves a DIFFERENT problem — a RETAINED failed job under the stable id silently swallowing a
 * same-id re-add — not this one.
 */

/**
 * Exported, STABLE, GREPPABLE — an Axiom monitor can point at it without re-deriving the
 * wording. Asserted VERBATIM (never `stringContaining`) and MUTATION-TESTED (memory
 * `feedback_monitor_strings_need_verbatim_pin`).
 */
export const REDRIVE_ENQUEUE_FAILED_MSG = 'Re-drive committed but the job could not be enqueued';

export type RedriveOutcome =
  | { ok: true; kind: RedriveKind; entityId: string; auditEventId: string; jobId: string }
  | { ok: false; code: 'not_redrivable' }
  | { ok: false; code: 'enqueue_failed'; auditEventId: string };

interface ClaimedRedrive {
  auditEventId: string;
  meetingId: string;
}

/**
 * Perform one capture-health re-drive. Callers (the route) have ALREADY verified the actor
 * holds `REDRIVE_JOB` against the LIVE row — this function performs the write and enqueue and
 * trusts that check.
 */
export async function performRedrive(input: {
  kind: RedriveKind;
  entityId: string;
  actorUserId: string;
}): Promise<RedriveOutcome> {
  const { kind, entityId, actorUserId } = input;

  const claimed = await db.transaction(async (tx): Promise<ClaimedRedrive | null> => {
    // ── 1. The kind's CAS ──────────────────────────────────────────────────────
    let meetingId: string;
    let priorFailedStage: string | null = null;
    let priorFailureReason: string | null = null;
    let clearedMuxAssetId: string | null = null;

    if (kind === 'recording-ingest') {
      // Pre-read for the audit trail's "what did we clear" record — the CAS below is the
      // actual decider; this pre-read never gates anything.
      const before = await meetingRecordingsRepository.findById(entityId, tx);
      const updated = await meetingRecordingsRepository.reopenForIngestRedrive(
        { id: entityId },
        tx
      );
      if (updated === undefined) {
        return null; // rolls back — no audit row, no job.
      }
      meetingId = updated.meetingId;
      priorFailedStage = before?.failedStage ?? null;
      priorFailureReason = before?.failureReason ?? null;
      clearedMuxAssetId = before?.muxAssetId ?? null;
    } else {
      // Pre-read for the audit trail's "what had failed" record. It MUST precede the CAS and
      // MUST share the transaction: `claimRecapResume` NULLs `failed_stage`/`failure_reason`
      // and its `RETURNING` hands back the POST-update row, so the prior values exist nowhere
      // else once it runs. Like the recording arm's pre-read, this gates nothing — the CAS
      // below is the decider.
      const before = await transcriptsRepository.findById(entityId, tx);
      const updated = await transcriptsRepository.claimRecapResume(entityId, tx);
      if (updated === undefined) {
        return null; // rolls back — no audit row, no job.
      }
      meetingId = updated.meetingId;
      priorFailedStage = before?.failedStage ?? null;
      priorFailureReason = before?.failureReason ?? null;
    }

    // ── 2. SAME transaction — the audit row PRECEDES the enqueue ────────────────
    const audit = await auditEventsRepository.record(
      {
        actorUserId,
        action: `admin.redrive.${kind}`,
        entityType: kind === 'recording-ingest' ? 'recording' : 'transcript',
        entityId,
        metadata: {
          meeting_id: meetingId,
          prior_status: 'failed',
          prior_failed_stage: priorFailedStage,
          prior_failure_reason: priorFailureReason,
          ...(kind === 'recording-ingest' ? { cleared_mux_asset_id: clearedMuxAssetId } : {}),
        },
      },
      tx
    );

    return { auditEventId: audit.id, meetingId };
  });

  if (claimed === null) {
    log.warn({ kind, entityId }, 'Re-drive refused — the row is no longer in a re-drivable state');
    return { ok: false, code: 'not_redrivable' };
  }

  // Named `enqueuedJobId`, not `jobId`: this holds an id the enqueue ALREADY minted, and the
  // BAL-531 `colon-free-job-ids` scan reads a bare `jobId =` line as a construction site (it
  // cannot see the `buildJobId` call, which happens inside the enqueue function). The name says
  // what the value is — an id read back — and keeps that scan's assignment marker meaningful.
  let enqueuedJobId: string;
  try {
    // ⚠ THE JOBID IS READ OFF THE ENQUEUE'S OWN RETURN VALUE, NEVER RECONSTRUCTED HERE — a
    // hand-rolled template literal is exactly what `buildJobId`'s contract (and the
    // `colon-free-job-ids` invariant) exists to ban. Both enqueue functions build via
    // `buildJobId` internally and hand the id back.
    enqueuedJobId =
      kind === 'recording-ingest'
        ? await enqueueRecordingIngest({
            recordingId: entityId,
            jobIdSuffix: `redrive-${claimed.auditEventId}`,
          })
        : await enqueueTranscriptRecapResume({
            transcriptId: entityId,
            auditEventId: claimed.auditEventId,
          });
  } catch (error) {
    log.error(
      {
        kind,
        entityId,
        auditEventId: claimed.auditEventId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      REDRIVE_ENQUEUE_FAILED_MSG
    );
    return { ok: false, code: 'enqueue_failed', auditEventId: claimed.auditEventId };
  }

  log.info(
    { kind, entityId, auditEventId: claimed.auditEventId, jobId: enqueuedJobId },
    'Re-drive queued'
  );

  return { ok: true, kind, entityId, auditEventId: claimed.auditEventId, jobId: enqueuedJobId };
}
