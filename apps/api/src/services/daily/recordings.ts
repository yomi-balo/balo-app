/**
 * BAL-473 (D1/D2, OD-6) — the Daily REST calls that drive ONE recording segment's Daily-side
 * half: start it, stop it, mint a short-lived access link to the finished source, and delete
 * the source once Mux has ingested it (D4). All four go through the shared `dailyRequest`
 * seam (`client.ts`) — no bare `fetch` in this file.
 *
 * ⚠ THESE FOUR CALLS DO NOT TOUCH `meeting_recordings`. This module is a thin, injectable
 * Daily REST wrapper; the state machine lives entirely in
 * `packages/db/src/repositories/meeting-recordings.ts` and is driven by the BullMQ jobs in
 * `apps/api/src/jobs/recording-*.ts` plus the webhook arms in `routes/daily/webhook.ts`.
 */
import { z } from 'zod';
import { dailyRequest } from './client.js';
import { DailyApiError } from './errors.js';

/**
 * ⚠ WHY 60 SECONDS AND NOT DAILY'S 300 (OD-6). `minIdleTimeOut` is the circuit breaker for a
 * recording left running in a room nobody is using — Daily's default is 300s, plus 1–3
 * minutes to actually shut down, i.e. up to ~8 minutes of empty-room recording PER SEGMENT at
 * the default. D1/D2's whole rejoin premise depends on this value, so inheriting it silently
 * was not an option.
 *
 * 60s is chosen against the two failure directions:
 *   · TOO LONG bills storage and transcode for minutes of nothing, and puts an empty room in
 *     the artefact the recap and any dispute will read.
 *   · TOO SHORT fragments a call on every network blip. At 60s (plus Daily's shutdown lag, so
 *     ~2–4 minutes in practice) a blip is absorbed, and a genuine departure ends the segment.
 *
 * It is deliberately SHORTER than `IDLE_END_EMPTY_MS` (5 min, `@balo/shared/meetings/timers`),
 * which is the window after which the lifecycle sweep ends the MEETING. So the ordinary
 * sequence is: room empties → Daily stops the segment → `ready-to-download` → ingest starts,
 * all BEFORE the meeting is terminated. If the room refills inside those 5 minutes the
 * `ready-to-download` post-commit re-arm starts a second segment (D2), which is the truth.
 */
export const MIN_IDLE_TIMEOUT_SECONDS = 60;

/**
 * `POST /rooms/:name/recordings/start` — OD-12 verified: EVERY parameter is camelCase.
 * Success is `{"status":"sent"}` and NOTHING ELSE — the Daily recording id is never returned
 * synchronously; it arrives later on `recording.started` / `recording.ready-to-download`.
 *
 * ⚠ `instanceId` IS `meeting_recordings.id` (OD-1's correlation model) — the CALLER mints it
 * BEFORE this call, by inserting the row first (`insertCapturing`). Do not call this before
 * the row exists.
 *
 * ⚠ SENDS NO OTHER KNOB — no `layout`, no bucket config, no `maxDuration`. `rooms.ts`'s "do
 * not set them speculatively" rule applies here too.
 *
 * ⚠⚠ FIX ROUND 2 (R5) — `maxDuration`'s DEFAULT IS UNVERIFIABLE AS DAILY DOCUMENTS IT, AND
 * THAT IS STATED HONESTLY RATHER THAN PICKING A SIDE. Daily's own reference page reads
 * "`15000` seconds (3 hours)" — but 15000 seconds is 4h10m, not 3h (10800s); the number and
 * the gloss disagree, and re-verification on 2026-08-26 confirmed the page is still
 * self-contradictory. Whichever reading is true, it comfortably exceeds any consultation, we
 * do not set it, and the re-arm (`routes/daily/webhook.ts`'s post-commit ensure) covers a
 * force-stop at either bound the same way.
 *
 * Rate-limit tier: ~1/s (5 per 5s) — much tighter than the 20/s most Daily calls get. There is
 * no retry loop inside `dailyRequest` by design; BullMQ's backoff on `recording-ensure` is the
 * retry.
 */
export async function startRoomRecording(
  roomName: string,
  input: { instanceId: string }
): Promise<void> {
  await dailyRequest<unknown>('POST', `/rooms/${encodeURIComponent(roomName)}/recordings/start`, {
    instanceId: input.instanceId,
    minIdleTimeOut: MIN_IDLE_TIMEOUT_SECONDS,
  });
}

/**
 * `POST /rooms/:name/recordings/stop`. Maps a `400`/`404` to `'nothing_to_stop'` — OD-7:
 * Daily may already have auto-stopped the segment on `minIdleTimeOut`, or the room may
 * already be torn down. Both are the SAME successful answer as far as `recording-stop` is
 * concerned: there is nothing left to stop. Every other non-2xx rethrows (BullMQ retries).
 *
 * Sits in the 20/s tier (unlike `start`).
 */
export async function stopRoomRecording(
  roomName: string,
  input: { instanceId: string }
): Promise<'stopped' | 'nothing_to_stop'> {
  try {
    await dailyRequest<unknown>('POST', `/rooms/${encodeURIComponent(roomName)}/recordings/stop`, {
      instanceId: input.instanceId,
    });
    return 'stopped';
  } catch (error) {
    if (error instanceof DailyApiError && (error.status === 400 || error.status === 404)) {
      return 'nothing_to_stop';
    }
    throw error;
  }
}

/** `GET /recordings/:id/access-link`'s body, PARSED — see {@link getRecordingAccessLink}. */
const accessLinkResponseSchema = z.object({
  download_link: z.string().min(1),
  expires: z.number().finite(),
});

/**
 * `GET /recordings/{id}/access-link` → a short-lived download URL for the finished Daily
 * source. ⚠ ZOD-PARSED, NOT CAST — this drives a vendor UPLOAD (`recording-ingest` hands the
 * link straight to Mux), so a wrong shape must not reach Mux as `undefined`. `client.ts`'s
 * `dailyRequest` ends in a bare `as T`; this is the `getAllPresence` discipline, restated for
 * a payload that is even more dangerous to get wrong.
 *
 * ⚠ MINT THIS INSIDE THE INGEST JOB, ON EVERY ATTEMPT — never at webhook time, never carried
 * across a retry. The link is short-lived; a stale one handed to Mux fails the ingest with no
 * recovery but a fresh mint.
 *
 * ⚠ NEVER LOG OR PERSIST `download_link`. `expiresAt` is safe to log (it is the vendor's own
 * answer to "how long is this good for", carried forward rather than assumed) and is the ONLY
 * thing about this response that belongs in a log line.
 */
export async function getRecordingAccessLink(
  recordingId: string
): Promise<{ downloadLink: string; expiresAt: Date }> {
  const path = `/recordings/${encodeURIComponent(recordingId)}/access-link`;
  const body = await dailyRequest<unknown>('GET', path);
  const parsed = accessLinkResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DailyApiError(
      'GET',
      path,
      0,
      'Daily GET /recordings/:id/access-link returned a body this platform cannot interpret'
    );
  }
  return {
    downloadLink: parsed.data.download_link,
    expiresAt: new Date(parsed.data.expires * 1000),
  };
}

/**
 * `DELETE /recordings/:id` — the D4 cleanup call, made ONLY after the segment is `ready`
 * (Mux has confirmed the asset is playable). `404` maps to `'already_gone'`, the `deleteRoom`
 * precedent verbatim: the caller's goal ("the Daily copy is gone") is met either way, and
 * treating a 404 as an error would make the common "we already cleaned this up" path noisy.
 */
export async function deleteRecording(recordingId: string): Promise<'deleted' | 'already_gone'> {
  try {
    await dailyRequest<unknown>('DELETE', `/recordings/${encodeURIComponent(recordingId)}`);
    return 'deleted';
  } catch (error) {
    if (error instanceof DailyApiError && error.status === 404) {
      return 'already_gone';
    }
    throw error;
  }
}
