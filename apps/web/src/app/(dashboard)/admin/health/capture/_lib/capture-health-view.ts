import {
  deriveRecordingLadder,
  deriveTranscriptionLadder,
  deriveRecapLadder,
  deriveCaptureHealthCategory,
  type CaptureHealthCategory,
  type CaptureHealthFacts,
  type RecordingLadderState,
  type TranscriptionLadderState,
  type RecapLadderState,
} from '@balo/shared/capture-health';
import { joinNameParts } from '@balo/shared/parties';

/**
 * BAL-550 (§7.4) — the pure view-model builder behind `/admin/health/capture`. Takes ONE
 * repository row (`CaptureHealthMeetingRow`, reduced to the fields this module actually reads
 * so it never VALUE-imports `@balo/db`, the client-bundle footgun) plus its detail rows, and
 * folds them into the shape `HealthRow`/`LadderChip` render.
 *
 * ⚠ THE FACTS TYPE IS THE CANONICAL ONE. `CaptureHealthFacts` lives in
 * `@balo/shared/capture-health` — a pure package this module ALREADY value-imports for the
 * four derivations — so there is no bundle argument for a local copy of it, and a copy could
 * only drift from the repository projection that fills it. Only the DETAIL shapes below stay
 * structural, because their canonical declarations sit in `@balo/db`.
 *
 * ⚠⚠ NO MONEY. This module has no `$`, `A$`, `fee`, `margin` or `markup` producible from any
 * input, and `CaptureHealthRowView` has no money-shaped field — pinned by this module's own
 * `capture-health-view.test.ts`, whose "money-less" describe holds BOTH halves: it serialises a
 * spread of built rows and asserts no money-shaped TEXT, and it walks `Object.keys` of a built
 * row and asserts no money-shaped FIELD. There is deliberately no
 * `apps/web/src/invariants/` file for this — the property is per-row and per-field, which a
 * source-text scan cannot see, and the two cases above are what actually hold it.
 */

// ── Structural input shapes (never a `@balo/db` value import) ──────────────────

export interface CaptureHealthRowInput {
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  facts: CaptureHealthFacts;
}

export interface CaptureHealthRecordingDetailInput {
  id: string;
  /** The raw `meeting_recordings.status` enum value — a wider string than
   *  `RecordingLadderState`, since the ladder is a DERIVED rank, not a column mirror. */
  status: string;
  failedStage: string | null;
  failureReason: string | null;
  dailyRecordingId: string | null;
  sourceDeletedAt: Date | null;
  transcriptJobSubmittedAt: Date | null;
  transcriptJobFinishedAt: Date | null;
  transcriptJobFailureReason: string | null;
  createdAt: Date;
}

export interface CaptureHealthRecapDetailInput {
  id: string;
  status: string;
  failedStage: string | null;
}

export interface CaptureHealthExpertDetailInput {
  firstName: string | null;
  lastName: string | null;
  agencyName: string | null;
}

export interface CaptureHealthPartyDetailInput {
  contextType: string;
  companyName: string | null;
}

export interface CaptureHealthRowDetails {
  recordings: readonly CaptureHealthRecordingDetailInput[]; // oldest first
  /** Newest live transcript of ANY status — what the recap CHIP narrates. */
  recap: CaptureHealthRecapDetailInput | undefined;
  /**
   * Newest live transcript that is actually `failed` with a recorded stage — the ONLY row
   * `transcriptsRepository.claimRecapResume`'s CAS can match, and therefore the only legal
   * target for the "Re-run recap" button.
   *
   * ⚠ IT IS A SEPARATE FIELD BECAUSE THE TWO ANSWERS GENUINELY DIVERGE. The recap chip is
   * derived from the meeting's AGGREGATE facts (`anyFailed` over every live transcript), so a
   * meeting carrying an older `failed` row and a newer `ready` one renders `failed` while
   * {@link CaptureHealthRowDetails.recap} names the `ready` row. Targeting that one guarantees
   * a `409 not_redrivable` on every click.
   */
  recapFailed: CaptureHealthRecapDetailInput | undefined;
  expert: CaptureHealthExpertDetailInput | undefined;
  party: CaptureHealthPartyDetailInput | undefined;
}

// ── Output shapes ────────────────────────────────────────────────────────────

export interface CaptureHealthLadderView<State extends string> {
  state: State;
  stage?: string;
  note?: string;
}

export type CaptureHealthActionView =
  | { kind: 'recording-ingest'; recordingId: string; segmentLabel: string }
  | { kind: 'transcript-pipeline'; transcriptId: string }
  | { kind: 'note'; note: string }
  | { kind: 'none' };

export interface CaptureHealthRowView {
  meetingId: string;
  title: string;
  parties: string;
  when: string;
  durationLabel: string;
  contextLabel: string;
  recording: CaptureHealthLadderView<RecordingLadderState>;
  transcription: CaptureHealthLadderView<TranscriptionLadderState>;
  recap: CaptureHealthLadderView<RecapLadderState>;
  category: CaptureHealthCategory;
  action: CaptureHealthActionView;
}

// ── Copy (D8 unrecoverable / waiting-daily notes, verbatim from the design reference) ────

export const REDRIVE_NOTE = {
  'waiting-daily':
    'Waiting on Daily — if the batch job never answers, delete it by hand and the source releases on the next tick',
  unrecoverable: 'Not recoverable — Daily never produced a source. The recap is files-only.',
  /**
   * The recap ladder says `failed`, but no live transcript is currently sitting in the state
   * the resume CAS can claim — the usual cause is a re-run already under way, since the two
   * answers are read a moment apart. Honest and specific: neither existing note fits (one is
   * about Daily never producing a source, the other about a Daily batch job), and a BLANK
   * action cell beside a Failed chip explains nothing.
   */
  'recap-unclaimable':
    'No transcript to resume right now — a re-run may already be in flight. Reload to re-check.',
} as const;

// ── Formatting ───────────────────────────────────────────────────────────────

/** `"Consultation {d MMM yyyy}"` — reuses the finders' `Consultation {date}` derivation
 *  (`apps/api/src/jobs/admin-alert-finders.ts:50-57`'s `formatDateShort`, `en-GB`, UTC). The
 *  finder does not export it, so this is a PINNED, test-verified equivalent (plan §6.7's
 *  escape hatch) rather than a hoist. */
function formatConsultationDate(date: Date): string {
  const formatted = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `Consultation ${formatted}`;
}

/** `"28 Aug"` — day + short month only, no year (the row's compact "when" line). */
function formatShortDayMonth(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function wholeMinutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

function durationLabel(row: CaptureHealthRowInput): string {
  const minutes =
    row.startedAt !== null && row.endedAt !== null
      ? wholeMinutesBetween(row.startedAt, row.endedAt)
      : wholeMinutesBetween(row.scheduledStart, row.scheduledEnd);
  return `${minutes} min`;
}

function ageLabel(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.max(1, Math.floor(ms / (60 * 60 * 1000)));
  return `${hours}h`;
}

// ── Party line ───────────────────────────────────────────────────────────────

function partiesLabel(details: CaptureHealthRowDetails): string {
  const companyName = details.party?.companyName ?? null;
  const clientLabel = companyName ?? 'no client company';

  const expert = details.expert;
  if (expert === undefined) {
    return `${clientLabel} × expert unavailable`;
  }
  const name = joinNameParts(expert.firstName, expert.lastName) ?? 'expert unavailable';
  const expertLabel =
    expert.agencyName !== null && expert.agencyName.trim().length > 0
      ? `${name} @ ${expert.agencyName}`
      : name;
  return `${clientLabel} × ${expertLabel}`;
}

// ── Ladder notes ─────────────────────────────────────────────────────────────

function recordingLadderView(
  state: RecordingLadderState,
  recordings: readonly CaptureHealthRecordingDetailInput[]
): CaptureHealthLadderView<RecordingLadderState> {
  if (state !== 'failed') return { state };
  const failedSegment = recordings.find((r) => r.status === 'failed');
  return failedSegment?.failureReason === null || failedSegment?.failureReason === undefined
    ? { state }
    : { state, note: failedSegment.failureReason };
}

/** The open (submitted, never finished) segment with the EARLIEST submission. */
function oldestOpenTranscriptJob(
  recordings: readonly CaptureHealthRecordingDetailInput[]
): CaptureHealthRecordingDetailInput | undefined {
  let oldest: CaptureHealthRecordingDetailInput | undefined;
  for (const recording of recordings) {
    const submittedAt = recording.transcriptJobSubmittedAt;
    if (submittedAt === null || recording.transcriptJobFinishedAt !== null) continue;
    const incumbent = oldest?.transcriptJobSubmittedAt;
    if (
      incumbent === undefined ||
      incumbent === null ||
      submittedAt.getTime() < incumbent.getTime()
    ) {
      oldest = recording;
    }
  }
  return oldest;
}

function transcriptionLadderView(
  state: TranscriptionLadderState,
  recordings: readonly CaptureHealthRecordingDetailInput[],
  now: Date
): CaptureHealthLadderView<TranscriptionLadderState> {
  if (state === 'withheld') {
    // ⚠ THE OLDEST OPEN SEGMENT, NOT THE FIRST ONE IN `created_at` ORDER. `withheld` means
    // "some open segment was submitted at or before the caller's single `withheldBefore`
    // instant"; the open segment with the SMALLEST `transcript_job_submitted_at` therefore
    // satisfies that whenever any does, so it is provably a withheld one. `recordings` is
    // ordered by `created_at`, which need not agree with submission order, so a plain `find`
    // could name a segment submitted minutes ago and under-report the age.
    const withheldSegment = oldestOpenTranscriptJob(recordings);
    if (withheldSegment?.transcriptJobSubmittedAt != null) {
      return {
        state,
        note: `Submitted ${ageLabel(withheldSegment.transcriptJobSubmittedAt, now)} ago · no webhook yet`,
      };
    }
    return { state };
  }
  if (state === 'failed') {
    const failedSegment = recordings.find((r) => r.transcriptJobFailureReason !== null);
    return failedSegment?.transcriptJobFailureReason == null
      ? { state }
      : { state, note: failedSegment.transcriptJobFailureReason };
  }
  return { state };
}

/**
 * ⚠ THE TWO STATES READ THEIR STAGE OFF DIFFERENT ROWS, AND THAT IS THE POINT. On a meeting with
 * more than one transcript, `recap` (the newest live row) and `recapFailed` (the newest live
 * FAILED row) are different rows. A `failed` chip must narrate the FAILED transcript's stage —
 * reading it off the newest row would let a `partial` (`ready` + `failed_stage`) transcript lend
 * its stage to a chip describing an older, unrelated failure, so the row would name a stage that
 * did not fail the thing the chip is about. `partial` is the newest row by construction, so it
 * keeps reading `recap`.
 */
function recapLadderView(
  state: RecapLadderState,
  recap: CaptureHealthRecapDetailInput | undefined,
  recapFailed: CaptureHealthRecapDetailInput | undefined
): CaptureHealthLadderView<RecapLadderState> {
  if (state === 'failed') {
    return recapFailed?.failedStage == null ? { state } : { state, stage: recapFailed.failedStage };
  }
  if (state === 'partial' && recap?.failedStage != null) {
    return { state, stage: recap.failedStage };
  }
  return { state };
}

// ── Action resolution (D8: row meeting-grain, action segment-grain) ──────────

function resolveAction(
  category: CaptureHealthCategory,
  transcription: TranscriptionLadderState,
  recap: RecapLadderState,
  facts: CaptureHealthFacts,
  recordings: readonly CaptureHealthRecordingDetailInput[],
  recapFailedDetail: CaptureHealthRecapDetailInput | undefined
): CaptureHealthActionView {
  if (category === 'recording') {
    if (!facts.recording.anyRedrivableFailure) {
      return { kind: 'note', note: REDRIVE_NOTE.unrecoverable };
    }
    const target = recordings.find(
      (r) => r.status === 'failed' && r.sourceDeletedAt === null && r.dailyRecordingId !== null
    );
    if (target === undefined) {
      return { kind: 'note', note: REDRIVE_NOTE.unrecoverable };
    }
    const index = recordings.findIndex((r) => r.id === target.id);
    return {
      kind: 'recording-ingest',
      recordingId: target.id,
      segmentLabel: `Segment ${index + 1} of ${recordings.length}`,
    };
  }

  if (transcription === 'withheld') {
    return { kind: 'note', note: REDRIVE_NOTE['waiting-daily'] };
  }

  if (recap === 'failed') {
    // ⚠ `recapFailed`, NOT the newest-of-any-status detail — see the field's own docblock.
    return recapFailedDetail === undefined
      ? { kind: 'note', note: REDRIVE_NOTE['recap-unclaimable'] }
      : { kind: 'transcript-pipeline', transcriptId: recapFailedDetail.id };
  }

  // `recap === 'partial'` ⇒ never re-drivable, never shown as failed (D8).
  return { kind: 'none' };
}

// ── The builder ──────────────────────────────────────────────────────────────

export function buildCaptureHealthRow(
  row: CaptureHealthRowInput,
  details: CaptureHealthRowDetails,
  opts: { now: Date }
): CaptureHealthRowView {
  const facts = row.facts;
  const recordingState = deriveRecordingLadder(facts);
  const transcriptionState = deriveTranscriptionLadder(facts);
  const recapState = deriveRecapLadder(facts);
  const category = deriveCaptureHealthCategory(facts);

  return {
    meetingId: row.meetingId,
    title: formatConsultationDate(row.scheduledStart),
    parties: partiesLabel(details),
    when: formatShortDayMonth(row.scheduledStart),
    durationLabel: durationLabel(row),
    contextLabel: (details.party?.contextType ?? 'unknown').replaceAll('_', ' '),
    recording: recordingLadderView(recordingState, details.recordings),
    transcription: transcriptionLadderView(transcriptionState, details.recordings, opts.now),
    recap: recapLadderView(recapState, details.recap, details.recapFailed),
    category,
    action: resolveAction(
      category,
      transcriptionState,
      recapState,
      facts,
      details.recordings,
      details.recapFailed
    ),
  };
}
