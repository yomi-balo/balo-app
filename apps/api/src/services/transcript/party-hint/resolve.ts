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
 * Wraps a REPOSITORY lookup rejection so `resolvePartyHint`'s catch can tell it apart from a
 * throw inside the pure derivation code below (a bug, not an infra failure). Carries the
 * ORIGINAL error's message so the "lookup failed" log line stays accurate without re-deriving
 * anything from the wrapper.
 */
class PartyHintLookupError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'PartyHintLookupError';
    this.cause = cause;
  }
}

/** Awaits a repository call, rewrapping any rejection as `PartyHintLookupError` — kept generic
 *  so neither call site needs its own try/catch or a repeated type annotation (the latter would
 *  add a spurious extra text occurrence of the repository's own name, which
 *  `redrive-recap-never-touches-transcript-job.test.ts` counts). */
async function readForLookup<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    throw new PartyHintLookupError(error);
  }
}

/**
 * BAL-517 — the ONLY reads this module performs are
 * `meetingRecordingsRepository.findByTranscriptJobId` and `meetingPresenceRepository.listByMeeting`.
 * Pinned by `invariants/redrive-recap-never-touches-transcript-job.test.ts`: the recap re-drive
 * may READ `meeting_recordings` for the segment's `started_at` / meeting id, but must never
 * write or reset `transcript_job_*` state. This function names no `markTranscriptJob*` member.
 *
 * Both repository calls are wrapped in `PartyHintLookupError` so a rejection here is
 * distinguishable, in `resolvePartyHint`'s catch, from a throw in the pure `precheckPartyHint` /
 * `derivePartyHint` calls, which propagate UNWRAPPED.
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

  const recording = await readForLookup(
    meetingRecordingsRepository.findByTranscriptJobId(batchJobId)
  );
  if (recording === undefined) {
    return { kind: 'none', reason: 'recording_not_found' };
  }

  const presence = await readForLookup(
    meetingPresenceRepository.listByMeeting(input.transcript.meetingId)
  );

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

/** Logs a repository lookup rejection at `error`, using the ORIGINAL repository/driver error's
 *  message + stack (`error.cause`), never the wrapper's own — the wrapper exists purely for
 *  classification, and its own stack is just `readForLookup` → `resolvePartyHint`, which tells
 *  an operator nothing about the actual failure. Split out of `resolvePartyHint` to keep its
 *  cognitive complexity low. */
function logLookupFailure(
  transcript: Pick<Transcript, 'id' | 'meetingId'>,
  error: PartyHintLookupError
): void {
  const { cause } = error;
  log.error(
    {
      transcriptId: transcript.id,
      meetingId: transcript.meetingId,
      error: cause instanceof Error ? cause.message : String(cause),
      stack: cause instanceof Error ? cause.stack : undefined,
    },
    'Transcript party hint lookup failed — continuing without a hint'
  );
}

/** Logs any NON-lookup throw at `error`: a bug in `precheckPartyHint` / `derivePartyHint`, or a
 *  throw from `logDerivation` itself (e.g. a logger mixin/serializer/transport failure). Split
 *  out of `resolvePartyHint` to keep its cognitive complexity low. */
function logDerivationThrew(
  transcript: Pick<Transcript, 'id' | 'meetingId'>,
  error: unknown
): void {
  log.error(
    {
      transcriptId: transcript.id,
      meetingId: transcript.meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    'Transcript party hint derivation threw — continuing without a hint'
  );
}

/**
 * BAL-517 — fetch-and-call over the pure `derivePartyHint`. NEVER REJECTS: every absence,
 * ambiguity, repository failure, or bug in the derivation itself degrades to `null` (a hint is
 * an optional prior; the recap must never fail for want of one). Never carries a participant
 * identity, ref, talk time or text in its logs — only ids already logged by the pipeline, and
 * the `basis` / `reason` label.
 *
 * A repository failure and a derivation bug are logged at `error`, with DIFFERENT messages, so
 * an operator can tell "infra is down" apart from "this code has a bug" in Axiom. `log.warn` is
 * never used here. `logDerivation` and the return mapping run INSIDE this try (not after it), so
 * the "never rejects" guarantee is structural: even a throw from logging itself is caught here
 * and falls to the non-lookup ("derivation threw") branch below, exactly like a bug in
 * `derivePartyHint` would.
 */
export async function resolvePartyHint(
  input: ResolvePartyHintInput
): Promise<SpeakerPartyHint | null> {
  try {
    const derivation = await deriveFromRows(input);
    logDerivation(input.transcript, derivation);
    return derivation.kind === 'hint' ? derivation.hint : null;
  } catch (error) {
    if (error instanceof PartyHintLookupError) {
      logLookupFailure(input.transcript, error);
    } else {
      logDerivationThrew(input.transcript, error);
    }
    return null;
  }
}
