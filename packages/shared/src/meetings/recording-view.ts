/**
 * BAL-473 (ADR-1013 + 2026-07-14 amendment) — the client-safe projection of a
 * `meeting_recordings` row, and the concealment boundary it is projected THROUGH.
 *
 * PURE and dependency-free (no `@balo/db`, no I/O) — the `@balo/shared/meetings` rule,
 * restated: `apps/web` must be able to reach this without pulling the `postgres` driver into
 * a client bundle, where it fails `next build` (it cannot resolve Node builtins like `tls`).
 *
 * ⚠ RESTATED, NOT IMPORTED. `@balo/shared` must never value-import `@balo/db` — so
 * {@link MeetingRecordingStatus} below is a SECOND definition of the same five-label union
 * `packages/db/src/schema/meeting-recordings.ts` derives from `recordingStatusEnum`. That
 * file carries a compile-time `Exact<>` proof the two agree, so a drift is a build failure,
 * not a runtime surprise.
 */

/** The segment lifecycle (mirrors `recording_status` — see this file's docblock). */
export type MeetingRecordingStatus =
  | 'recording'
  | 'source_ready'
  | 'ingesting'
  | 'ready'
  | 'failed';

/**
 * ⚠⚠ THE ONLY SHAPE OF A RECORDING THAT MAY CROSS TO A CLIENT. Same posture as the fee
 * concealment in `@balo/shared/credit/money-block` — the concealment is expressed in the
 * TYPE, so a leak is a compile error rather than a review miss.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY EACH ONE:
 *   · `dailyRecordingId` — a vendor handle to a downloadable source object.
 *   · `muxAssetId`       — the Mux ASSET id. Distinct from the PLAYBACK id: the asset id is
 *                          an API handle (delete, update, list); the playback id is inert
 *                          without a signed token, which is why `playbackId` IS on this view.
 *   · `failureReason` / `failedStage` — free-text vendor internals. A client learns `status`.
 *   · `sourceDeletedAt`  — an ops fact about our storage, not about their recording.
 *   · any download link  — never persisted anywhere, never in any payload, at any TTL.
 *   · `transcriptJob*`   — BAL-483's four columns: a Daily batch-processor job id, its two
 *                          instants and its vendor error text. The transcript itself reaches a
 *                          client through `transcripts` (projected to `{id, status}`), never
 *                          through the recording, and the capture's vendor plumbing never at
 *                          all — not even the fact that it happened.
 */
export interface MeetingRecordingView {
  readonly id: string;
  readonly status: MeetingRecordingStatus;
  readonly playbackId: string | null;
  readonly durationSeconds: number | null;
  readonly startedAt: string | null; // ISO-8601
  readonly readyAt: string | null; // ISO-8601
}

/** The exact key set of {@link MeetingRecordingView}, as data, so the test is a real proof. */
export const MEETING_RECORDING_VIEW_KEYS = [
  'id',
  'status',
  'playbackId',
  'durationSeconds',
  'startedAt',
  'readyAt',
] as const;

/** Every column that must NEVER appear in a client payload — as data, for the same reason. */
export const MEETING_RECORDING_CONCEALED_KEYS = [
  'dailyRecordingId',
  'muxAssetId',
  'failedStage',
  'failureReason',
  'sourceDeletedAt',
  'downloadLink',
  'downloadUrl',
  'accessLink',
  // BAL-483 — the Daily batch-processor transcription job. Vendor handles and vendor error
  // text; a client learns nothing about them, not even that transcription happened.
  'transcriptJobId',
  'transcriptJobSubmittedAt',
  'transcriptJobFinishedAt',
  'transcriptJobFailureReason',
] as const;

/**
 * Project a `meeting_recordings` row to the client-safe view. Takes a STRUCTURAL input
 * (not a `@balo/db` type) — a caller may hand it a deliberately over-wide object (e.g. the
 * full DB row) and the return is still exactly {@link MEETING_RECORDING_VIEW_KEYS}.
 */
export function toMeetingRecordingView(row: {
  id: string;
  status: MeetingRecordingStatus;
  muxPlaybackId: string | null;
  durationSeconds: number | null;
  startedAt: Date | null;
  readyAt: Date | null;
}): MeetingRecordingView {
  return {
    id: row.id,
    status: row.status,
    playbackId: row.muxPlaybackId,
    durationSeconds: row.durationSeconds,
    startedAt: row.startedAt === null ? null : row.startedAt.toISOString(),
    readyAt: row.readyAt === null ? null : row.readyAt.toISOString(),
  };
}
