/**
 * BAL-550 — THE SHARED CAPTURE-HEALTH VOCABULARY (plan §3).
 *
 * Three consumers need the SAME derivation and therefore it lives here, not route-local:
 *   1. the web view model (`apps/web/.../admin/health/capture/_lib`),
 *   2. the web component tests,
 *   3. `packages/db`'s `capture-health.integration.test.ts`, which proves the SQL health-rank
 *      CASE in `repositories/capture-health.ts` agrees with the TS derivation below over
 *      EVERY ladder combination.
 *
 * `@balo/shared` is pure (no `@balo/db`, no vendor SDK, no Node/browser globals), so both
 * apps and the db package can import it without the client-bundle footgun
 * (`reference_balo_db_client_bundle_footgun`).
 *
 * ⚠⚠ TWO DEFINITIONS OF THE CATEGORY EXIST ON PURPOSE — this one, and the SQL `CASE` built by
 * `healthRankSql` in `packages/db/src/repositories/capture-health.ts`. One ORDERS AND COUNTS
 * in Postgres (a keyset cannot order on a value computed in the browser); the other RENDERS.
 * They are held in agreement MECHANICALLY by the integration matrix, never by eye. Never edit
 * one without the other.
 */

/**
 * D4 — the ticket's page size, deliberately NOT `ADMIN_ALERT_PAGE_SIZE` (50), which belongs to
 * the pending-actions queue. This lens carries three ladders and a party line per row, so the
 * row is several times taller than a queue row.
 */
export const CAPTURE_HEALTH_PAGE_SIZE = 25;

/** The default window the page opens on when `?from=`/`?to=` name nothing. */
export const CAPTURE_HEALTH_DEFAULT_WINDOW_DAYS = 30;

/**
 * The widest span the windowed read will serve. The read is bounded by
 * `meeting_scheduled_start_idx`; an unbounded span would degrade it into a full scan of every
 * meeting Balo has ever held.
 */
export const CAPTURE_HEALTH_MAX_WINDOW_DAYS = 180;

/**
 * The four tiles, and the four values the SQL rank maps onto.
 *
 * ⚠ ONE DECLARATION, DERIVED BOTH WAYS (the {@link REDRIVE_KINDS} shape). The array is what
 * `?category=` parsing and the Server Action's `z.enum` iterate; the type is what every
 * signature names. Re-inlining either as a literal union re-opens the drift this replaced.
 */
export const CAPTURE_HEALTH_CATEGORIES = [
  'recording',
  'transcription',
  'recap',
  'healthy',
] as const;
export type CaptureHealthCategory = (typeof CAPTURE_HEALTH_CATEGORIES)[number];

/**
 * THE ONE RANK. Mirrors `healthCategory` (`.claude/design-references/admin-home.jsx:1211`) and
 * the SQL `CASE` in `capture-health.ts`. "Issues first" is this ascending.
 */
export const CAPTURE_HEALTH_RANK: Readonly<Record<CaptureHealthCategory, number>> = {
  recording: 0,
  transcription: 1,
  recap: 2,
  healthy: 3,
};

/** Ladder 1 — the meeting's recording segments, worst state dominating. */
export type RecordingLadderState = 'ready' | 'failed' | 'ingesting' | 'source_ready' | 'capturing';

/** Ladder 2 — the vendor batch transcription job (`meeting_recordings.transcript_job_*`). */
export type TranscriptionLadderState =
  | 'finished'
  | 'submitted'
  | 'withheld'
  | 'failed'
  | 'pending'
  | 'na'
  | 'none';

/** Ladder 3 — BAL-387's recap pipeline (`transcripts`). */
export type RecapLadderState = 'ready' | 'processing' | 'failed' | 'partial' | 'none' | 'na';

/** The two re-drivable kinds. `transcript-submit` and `calendar-amend` are out of scope. */
export const REDRIVE_KINDS = ['recording-ingest', 'transcript-pipeline'] as const;
export type RedriveKind = (typeof REDRIVE_KINDS)[number];

/** The recording-segment aggregate for ONE meeting. Every field is a real boolean (the SQL
 *  `coalesce`s `bool_or` over zero rows, which is NULL, to `false`). */
export interface CaptureHealthRecordingFacts {
  /** Live segments on this meeting. Never 0 from the windowed read (it inner-joins them). */
  readonly segmentCount: number;
  readonly anyFailed: boolean;
  readonly anySourceReady: boolean;
  readonly anyIngesting: boolean;
  /** `status = 'recording'` — a capture still in flight. */
  readonly anyCapturing: boolean;
  readonly anyReady: boolean;
  /** `failed` AND the Daily source still exists AND a `daily_recording_id` was ever issued —
   *  i.e. `meetingRecordingsRepository.reopenForIngestRedrive`'s CAS would match something. */
  readonly anyRedrivableFailure: boolean;
}

/** The batch-transcription aggregate. ⚠ These four columns live on `meeting_recordings`, NOT
 *  on `transcripts` — the same table the recording ladder reads. */
export interface CaptureHealthTranscriptionFacts {
  /** `transcript_job_failure_reason IS NOT NULL`. */
  readonly anyFailure: boolean;
  /** `transcript_job_submitted_at IS NOT NULL`. */
  readonly anySubmitted: boolean;
  /** submitted AND never finished. */
  readonly anyOpen: boolean;
  /** open AND submitted at or before the caller's single `withheldBefore` instant. */
  readonly anyWithheld: boolean;
  /** `transcript_job_finished_at IS NOT NULL`. */
  readonly anyFinished: boolean;
}

/** The recap aggregate, over this meeting's live `transcripts` rows. */
export interface CaptureHealthRecapFacts {
  readonly transcriptCount: number;
  /** ⚠ `status='failed' AND failed_stage IS NOT NULL` — BOTH terms, always. */
  readonly anyFailed: boolean;
  /** ⚠⚠ `status='ready' AND failed_stage IS NOT NULL` — THE PARTIAL RECAP. It is NEVER a
   *  failure: `recordStageSkip` stamps a stage on a path that still completed. */
  readonly anyPartial: boolean;
  readonly anyProcessing: boolean;
  readonly anyReady: boolean;
}

/** The raw facts the repository projects — the ONLY input to the derivations below. */
export interface CaptureHealthFacts {
  readonly recording: CaptureHealthRecordingFacts;
  readonly transcription: CaptureHealthTranscriptionFacts;
  readonly recap: CaptureHealthRecapFacts;
  /**
   * `false` when the meeting's live contexts name no engagement — a `match`-routed
   * `project_discovery`, a `request_interaction`, or an `admin` meeting. It is the only thing
   * that makes transcription/recap `na`: BAL-387's pipeline is engagement-anchored
   * (`transcripts.engagement_id` is NOT NULL), so those calls have no recap to be missing.
   */
  readonly hasEngagementContext: boolean;
}

/**
 * WORST-STATE-DOMINATES over the meeting's segments (D8's "say exactly how you rank them"):
 *
 *   failed (0) → source_ready (1) → capturing (2) → ingesting (3) → ready (4)
 *
 * LOWEST present wins. Only `failed` is terminal. `source_ready` and `capturing` are the two
 * states that can sit stuck with nobody driving them (a lost ingest job; a call that never
 * settled), so they outrank `ingesting`, which is a vendor callback genuinely in flight.
 *
 * ⚠ TOTAL BY CONSTRUCTION. `recording_status` has exactly these five labels and the windowed
 * read INNER-joins at least one live segment, so at least one flag is true and the final
 * `ready` is reached only when `anyReady` is the survivor.
 */
export function deriveRecordingLadder(facts: CaptureHealthFacts): RecordingLadderState {
  const { recording } = facts;
  if (recording.anyFailed) return 'failed';
  if (recording.anySourceReady) return 'source_ready';
  if (recording.anyCapturing) return 'capturing';
  if (recording.anyIngesting) return 'ingesting';
  return 'ready';
}

/**
 * FIRST MATCH WINS. The `na` branches are what stop a discovery call or an internal Balo call
 * reading as a broken pipeline: nothing was ever going to transcribe them.
 */
export function deriveTranscriptionLadder(facts: CaptureHealthFacts): TranscriptionLadderState {
  const { transcription, recording, hasEngagementContext } = facts;
  if (transcription.anyFailure) return 'failed';
  if (transcription.anyWithheld) return 'withheld';
  if (transcription.anyOpen) return 'submitted';
  if (transcription.anyFinished) return 'finished';
  // No engagement ⇒ no pipeline was ever going to run, once the source is actually ready.
  if (!hasEngagementContext && recording.anyReady) return 'na';
  // The source is ready and nothing was ever submitted — the batch processor is opt-in.
  if (recording.anyReady && !transcription.anySubmitted) return 'na';
  // The recording itself failed, so there is no source to transcribe. Not "pending".
  if (recording.anyFailed && !transcription.anySubmitted) return 'none';
  return 'pending';
}

/**
 * FIRST MATCH WINS.
 *
 * ⚠⚠ `partial` IS ITS OWN BRANCH AND NEVER FOLDS INTO `failed`. The two predicates are
 * DISJOINT (`status='failed'` vs `status='ready'`), so a partial can never reach the failed
 * branch; when both are true across two transcript rows of one meeting, `failed` legitimately
 * wins. A partial recap is never re-drivable and is never rendered as a failure.
 */
export function deriveRecapLadder(facts: CaptureHealthFacts): RecapLadderState {
  const { recap } = facts;
  if (recap.anyFailed) return 'failed';
  if (recap.anyPartial) return 'partial';
  if (recap.anyProcessing) return 'processing';
  if (recap.anyReady) return 'ready';
  if (deriveTranscriptionLadder(facts) === 'na') return 'na';
  return 'none';
}

/**
 * THE TILE PRECEDENCE — verbatim `healthCategory` (`admin-home.jsx:1211`), order-sensitive.
 *
 * ⚠ MIRRORED IN SQL by `healthRankSql` (`packages/db/src/repositories/capture-health.ts`),
 * which is the ORDERING authority for the keyset. The agreement between the two is proven
 * mechanically, per row, in `capture-health.integration.test.ts`.
 */
export function deriveCaptureHealthCategory(facts: CaptureHealthFacts): CaptureHealthCategory {
  if (facts.recording.anyFailed) return 'recording';
  const transcription = deriveTranscriptionLadder(facts);
  if (transcription === 'withheld' || transcription === 'failed') return 'transcription';
  const recap = deriveRecapLadder(facts);
  if (recap === 'failed' || recap === 'partial') return 'recap';
  return 'healthy';
}

/** The rank the SQL `CASE` must produce for these facts. The integration matrix asserts this
 *  equals the row's own `health_rank` for every seeded combination. */
export function captureHealthRankOf(facts: CaptureHealthFacts): number {
  return CAPTURE_HEALTH_RANK[deriveCaptureHealthCategory(facts)];
}
