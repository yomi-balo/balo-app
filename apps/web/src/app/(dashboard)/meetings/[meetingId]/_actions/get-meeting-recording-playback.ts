'use server';

import 'server-only';

import { z } from 'zod';
import { meetingRecordingsRepository } from '@balo/db';
import { playbackTtlForDuration } from '@balo/shared/meetings';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { signedPlaybackUrl } from '@/lib/mux/playback';

const inputSchema = z.object({
  meetingId: z.uuid(),
  recordingId: z.uuid(),
});

export type GetMeetingRecordingPlaybackResult =
  | { success: true; url: string }
  | { success: false; error: string };

/**
 * BAL-440 — mint a short-lived signed Mux playback URL for one recording segment. Structural
 * copy of `get-meeting-file-download.ts`, and it runs behind the SAME gate the recap read
 * already uses: no second definition of "who may see this meeting" is written by this ticket.
 *
 * ⚠⚠ `authorizeMeetingFileAccess` IS THE IDENTICAL FUNCTION THE RECAP READ USES
 * (`resolveRecapAccess` → `authorizeMeetingFileAccess`). Same module, same arguments. This is
 * the whole discharge of the plan's binding requirement — see plan §2.
 *
 * ⚠⚠ `meetingRecordingsRepository.findInMeeting({ meetingId: access.meeting.id, recordingId })`
 * — THE GATE'S ROW, NOT THE PARSED INPUT — puts the meeting in the WHERE clause, which is the
 * WHOLE IDOR STORY for `recordingId`: a foreign id and a soft-deleted one resolve identically to
 * `undefined`, so probing this action learns nothing about which recording uuids exist.
 *
 * ⚠ `requireUser()`, NOT `requireOnboardedUser()` — this is a genuine READ (no write anywhere in
 * its import graph: the gate performs no writes, and `findInMeeting` is a SELECT), so it is
 * registered on `READ_ONLY_ALLOWLIST` in `_read-only-actions.ts`.
 *
 * ⚠⚠ THE LOG PAYLOAD NEVER CARRIES THE URL, THE TOKEN, OR `muxPlaybackId` — only ids.
 */
export async function getMeetingRecordingPlaybackAction(
  input: z.infer<typeof inputSchema>
): Promise<GetMeetingRecordingPlaybackResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { meetingId, recordingId } = parsed.data;

  try {
    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok) {
      return { success: false, error: 'This meeting is no longer available.' };
    }

    // ⚠ `access.meeting.id` — the GATE'S row. Meeting-scoped in the WHERE clause, so a foreign
    // `recordingId` resolves to `undefined`, identically to a stale or soft-deleted one.
    const row = await meetingRecordingsRepository.findInMeeting({
      meetingId: access.meeting.id,
      recordingId,
    });
    if (row === undefined) {
      return { success: false, error: 'This recording is no longer available.' };
    }

    if (row.status !== 'ready' || row.muxPlaybackId === null) {
      return { success: false, error: 'This recording is not ready yet.' };
    }

    const url = await signedPlaybackUrl(
      row.muxPlaybackId,
      playbackTtlForDuration(row.durationSeconds)
    );
    return { success: true, url };
  } catch (error) {
    log.error('Failed to mint meeting recording playback URL', {
      meetingId,
      userId: user.id,
      recordingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: "Couldn't load this recording. Please try again." };
  }
}
