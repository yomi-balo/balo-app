import 'server-only';

import type { MeetingRecording } from '@balo/db';
import {
  MUX_PLAYBACK_MAX_TTL_SECONDS,
  toMeetingRecordingView,
  type MeetingRecordingView,
} from '@balo/shared/meetings';
import type { RecapRecordingState } from '@balo/analytics/events';
import { signedThumbnailUrl } from '@/lib/mux/playback';
import { log } from '@/lib/logging';
import type { RecapRecordingRowView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-440 — meeting recordings → the recap's recording block rows.
 *
 * How long after a meeting ends a recording may still plausibly be ingesting before the copy
 * switches from a time-based promise ("Processing your recording…") to a timeless one ("Still
 * processing").
 *
 * ⚠⚠ DELIBERATELY **NOT** `load-recap.ts`'s `PIPELINE_GRACE_MS`, THOUGH THE VALUE IS THE SAME.
 * That constant tunes the TRANSCRIPT pipeline; this one tunes the Daily→Mux INGEST pipeline.
 * They are two rules that happen to agree today, not one rule in two places — folding them
 * together would couple two independent vendor tunings. Do not "tidy" them.
 */
export const RECORDING_LONG_TAIL_MS = 30 * 60 * 1000;

/** Poster frame offset. A Daily recording's t=0 is often a blank pre-roll frame. */
export const POSTER_FRAME_SECONDS = 5;

/**
 * Is `row` past the long-tail threshold, anchored on `meetingEndedAt`?
 *
 * ⚠ ANCHORED ON `meetings.ended_at`, NEVER ON THE RECORDING'S OWN `started_at` — `startedAt` is
 * permanently NULL in the worst wedge case (the worker died before Daily's `recordings/start`
 * call returned), which is exactly the scenario this flag exists to catch. A meeting with no
 * `endedAt` fails toward the TIMELESS copy (`true`) — the honest default, since elapsed time
 * cannot be measured, so no time-based promise can be made.
 */
function isLongTailProcessing(
  view: Pick<MeetingRecordingView, 'status'>,
  meetingId: string,
  recordingId: string,
  meetingEndedAt: Date | null,
  now: Date
): boolean {
  if (view.status === 'ready' || view.status === 'failed') {
    return false;
  }
  if (meetingEndedAt === null) {
    log.warn('Recording present on a meeting with no endedAt', { meetingId, recordingId });
    return true;
  }
  return now.getTime() - meetingEndedAt.getTime() > RECORDING_LONG_TAIL_MS;
}

/**
 * Mint the poster URL for a single-segment `ready` row. NEVER THROWS — a mint failure (most
 * commonly `MUX_SIGNING_KEY_*` unset, which is Railway-only today and absent on Vercel) is
 * caught, logged, and degrades to `null`, which the component renders as the same `bg-muted`
 * fallback an image `onError` produces. An uncaught throw here would 500 a page that renders
 * fine today, for every meeting with a ready recording — same posture as `load-recap.ts`'s
 * `readMoneyBlock` ("NEVER throws — a failure is the fragment's OWN muted fallback").
 */
async function mintPosterUrl(
  playbackId: string,
  durationSeconds: number | null,
  meetingId: string,
  recordingId: string
): Promise<string | null> {
  const timeSeconds =
    durationSeconds !== null && durationSeconds > POSTER_FRAME_SECONDS
      ? POSTER_FRAME_SECONDS
      : undefined;
  try {
    return await signedThumbnailUrl(playbackId, {
      ttlSeconds: MUX_PLAYBACK_MAX_TTL_SECONDS,
      ...(timeSeconds === undefined ? {} : { timeSeconds }),
    });
  } catch (error) {
    log.error('Failed to mint recording poster URL', {
      meetingId,
      recordingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

/**
 * Rows → the recap's recording view, in the SAME order `listByMeeting` returned them
 * (`asc(createdAt)`, the capture order the "Segment {n}" labels count against).
 *
 * ⚠⚠ `toMeetingRecordingView(row)` IS THE ONLY PROJECTION — never a spread, never a
 * field-by-field re-projection. That would be a second definition of the concealment boundary;
 * `@balo/shared/meetings` already owns it (BAL-473).
 *
 * Poster minting is restricted to the SINGLE-SEGMENT, `ready`, playable case: 2+ segments
 * render the compact list (which has no thumbnails — minting N thumbnails would be wasted
 * signing and wasted payload), and a non-`ready` or `playbackId === null` row has nothing to
 * mint a frame from.
 */
export async function mapRecapRecordings(
  rows: readonly MeetingRecording[],
  meetingEndedAt: Date | null,
  now: Date
): Promise<RecapRecordingRowView[]> {
  const singleSegment = rows.length === 1;

  return Promise.all(
    rows.map(async (row): Promise<RecapRecordingRowView> => {
      const view = toMeetingRecordingView(row);
      const longTail = isLongTailProcessing(view, row.meetingId, row.id, meetingEndedAt, now);

      const posterUrl =
        singleSegment && view.status === 'ready' && view.playbackId !== null
          ? await mintPosterUrl(view.playbackId, view.durationSeconds, row.meetingId, row.id)
          : null;

      return {
        recording: view,
        posterUrl,
        isLongTailProcessing: longTail,
      };
    })
  );
}

/**
 * The meeting's recording posture, for `recap_viewed.recording_state`.
 *
 * Precedence: any `ready` ⇒ `'ready'`; else any in-flight (`recording` / `source_ready` /
 * `ingesting`) ⇒ `'processing'`; else any `failed` ⇒ `'failed'`; else `'absent'`. The ordering
 * answers "could this viewer have played something" — a meeting with one `ready` and one
 * `failed` segment reads as `'ready'`.
 */
export function deriveRecordingState(rows: readonly RecapRecordingRowView[]): RecapRecordingState {
  if (rows.length === 0) {
    return 'absent';
  }
  if (rows.some((row) => row.recording.status === 'ready')) {
    return 'ready';
  }
  if (rows.some((row) => row.recording.status !== 'failed')) {
    return 'processing';
  }
  return 'failed';
}
