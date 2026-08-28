'use server';

import 'server-only';

import { z } from 'zod';
import { isTwoSidedParty, meetingFilesRepository, MEETING_FILE_LIST_LIMIT } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';

const inputSchema = z.object({
  meetingId: z.uuid(),
});

export type ListMeetingFilesResult =
  | { success: true; files: MeetingFileView[] }
  | { success: false; error: string };

/**
 * List one meeting's live files, oldest first (BAL-423).
 *
 * ⚠⚠ BOTH SOURCES IN ONE LIST — THAT IS D0's ACCEPTANCE CRITERION, NOT AN OMISSION. The chat
 * paperclip and the Files-tab drop-zone write to the SAME table, distinguished only by
 * `source`; "listing a meeting's files returns both" is the thing this action exists to make
 * true. `listByMeeting` does not filter `source`, and neither does this view mapping. A
 * surface that wants one entry point filters in ITS view model, never here.
 *
 * ⚠ `r2Key` IS NEVER PROJECTED. It is an object locator and this result crosses the
 * server→client serialization boundary; downloads go through `getMeetingFileDownloadAction`,
 * which resolves the stored key server-side.
 *
 * ⚠ `isTwoSidedParty` COMES FROM `@balo/db`, NOT FROM THIS FILE. It used to be a private
 * helper here — but this module carries `'use server'`, and a `'use server'` module may
 * export ONLY async functions, so the predicate could never be shared with BAL-132 / BAL-388 /
 * BAL-421 from here without breaking `next build` (and ONLY `next build`: tsc, eslint and
 * vitest all stay green — memory `reference_use_server_no_value_exports`). It now lives beside
 * `MeetingFileParty`, the type it narrows to.
 *
 * ⚠ THE LIST IS BOUNDED AT `MEETING_FILE_LIST_LIMIT`, AND TRUNCATION IS NEVER SILENT. The
 * order is oldest-first, so hitting the cap drops the NEWEST files — the ones a live call most
 * wants — which is exactly the failure a silent cap would hide. A `log.warn` fires on the
 * boundary. When BAL-132 needs more, it adds keyset pagination, not a bigger number.
 *
 * ⚠⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. Bare `requireUser()` plus a
 * `READ_ONLY_ALLOWLIST` entry: `authorizeMeetingFileAccess` mints no rows and `listByMeeting`
 * is a SELECT.
 */
export async function listMeetingFilesAction(
  input: z.infer<typeof inputSchema>
): Promise<ListMeetingFilesResult> {
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
  const { meetingId } = parsed.data;

  try {
    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok) {
      return { success: false, error: 'This meeting is no longer available.' };
    }

    const rows = await meetingFilesRepository.listByMeeting(meetingId);

    // ⚠ NO SILENT CAPS. Reaching the bound means the NEWEST files were dropped.
    if (rows.length >= MEETING_FILE_LIST_LIMIT) {
      log.warn('Meeting file list hit its bound — newest files were truncated', {
        meetingId,
        userId: user.id,
        limit: MEETING_FILE_LIST_LIMIT,
      });
    }

    const files: MeetingFileView[] = [];
    for (const row of rows) {
      // A row whose `party` is not two-sided is CORRUPT — the CHECK makes it unrepresentable
      // — so it is DROPPED, never coerced to a side. Same fail-closed posture as
      // `selectPrimaryMeetingContext`, which drops a malformed context row rather than
      // promoting it: guessing an attribution is worse than omitting the file.
      if (!isTwoSidedParty(row.party)) {
        log.warn('Dropping meeting file with a non-two-sided party', {
          meetingId,
          userId: user.id,
          fileId: row.id,
          party: row.party,
        });
        continue;
      }
      files.push({
        id: row.id,
        meetingId: row.meetingId,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        party: row.party,
        source: row.source,
        uploadedByUserId: row.uploadedByUserId,
        createdAtIso: row.createdAt.toISOString(),
      });
    }

    return { success: true, files };
  } catch (error) {
    log.error('Failed to list meeting files', {
      meetingId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not load files. Please try again.' };
  }
}
