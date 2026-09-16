import {
  meetingRecordingsRepository,
  meetingPresenceRepository,
  type CanonicalTranscript,
  type Transcript,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { SpeakerPartyHint } from '../llm/types.js';
import { dailyBatchJobIdFromCaptureId } from '../capture-id.js';
import { derivePartyHint, precheckPartyHint, type PartyHintDerivation } from './derive.js';

const log = createLogger('transcript-party-hint');

export interface ResolvePartyHintInput {
  readonly transcript: Pick<Transcript, 'id' | 'meetingId' | 'vendor'>;
  readonly canonical: CanonicalTranscript;
  readonly cleanedText: string;
  readonly captureId: string;
}

/**
 * BAL-517 — the ONLY read this module performs is
 * `meetingRecordingsRepository.findByTranscriptJobId`, pinned by
 * `invariants/redrive-recap-never-touches-transcript-job.test.ts`: the recap re-drive
 * may READ `meeting_recordings` for the segment's `started_at` / meeting id, but must never
 * write or reset `transcript_job_*` state. This function names no `markTranscriptJob*` member.
 */
async function deriveFromRows(input: ResolvePartyHintInput): Promise<PartyHintDerivation> {
  const precheck = precheckPartyHint({
    vendor: input.transcript.vendor,
    canonical: input.canonical,
    cleanedText: input.cleanedText,
  });
  if (precheck.kind === 'none') {
    return precheck;
  }

  // Named `batchJobId`, not `jobId` — a Daily Batch Processor job id, never a BullMQ jobId (see
  // `capture-id.ts`'s note on the `colon-free-job-ids` / BAL-531 invariant).
  const batchJobId = dailyBatchJobIdFromCaptureId(input.captureId);
  if (batchJobId === null) {
    return { kind: 'none', reason: 'capture_id_unrecognised' };
  }

  const recording = await meetingRecordingsRepository.findByTranscriptJobId(batchJobId);
  if (recording === undefined) {
    return { kind: 'none', reason: 'recording_not_found' };
  }

  const presence = await meetingPresenceRepository.listByMeeting(input.transcript.meetingId);

  return derivePartyHint({
    vendor: input.transcript.vendor,
    meetingId: input.transcript.meetingId,
    canonical: input.canonical,
    cleanedText: input.cleanedText,
    recording,
    presence,
  });
}

function logDerivation(
  transcript: Pick<Transcript, 'id' | 'meetingId'>,
  derivation: PartyHintDerivation
): void {
  if (derivation.kind === 'hint') {
    log.info(
      {
        transcriptId: transcript.id,
        meetingId: transcript.meetingId,
        emitted: true,
        basis: derivation.hint.basis,
      },
      'Transcript party hint resolved'
    );
    return;
  }
  log.info(
    {
      transcriptId: transcript.id,
      meetingId: transcript.meetingId,
      emitted: false,
      reason: derivation.reason,
    },
    'Transcript party hint resolved'
  );
}

/**
 * BAL-517 — fetch-and-call over the pure `derivePartyHint`. NEVER REJECTS: every absence,
 * ambiguity or lookup error degrades to `null` (a hint is an optional prior; the recap must
 * never fail for want of one). Never carries a participant identity, ref, talk time or text in
 * its logs — only ids already logged by the pipeline, and the `basis` / `reason` label.
 */
export async function resolvePartyHint(
  input: ResolvePartyHintInput
): Promise<SpeakerPartyHint | null> {
  try {
    const derivation = await deriveFromRows(input);
    logDerivation(input.transcript, derivation);
    return derivation.kind === 'hint' ? derivation.hint : null;
  } catch (error) {
    log.warn(
      {
        transcriptId: input.transcript.id,
        meetingId: input.transcript.meetingId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Transcript party hint lookup failed — continuing without a hint'
    );
    return null;
  }
}
