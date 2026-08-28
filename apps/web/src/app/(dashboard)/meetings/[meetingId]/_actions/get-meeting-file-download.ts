'use server';

import 'server-only';

import { z } from 'zod';
import { isTwoSidedParty, meetingFilesRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { createPresignedMeetingFileDownload } from '@/lib/storage/meeting-file';

const inputSchema = z.object({
  meetingId: z.uuid(),
  fileId: z.uuid(),
});

export type GetMeetingFileDownloadResult =
  | { success: true; url: string }
  | { success: false; error: string };

/**
 * Short-lived presigned GET for one meeting file (BAL-423).
 *
 * These files are PRIVATE to the meeting's participants — never `R2_PUBLIC_URL`. The file
 * must be live AND belong to the GATE-VALIDATED meeting: the lookup goes through
 * `findInMeeting({ meetingId: access.meeting.id, fileId })`, which puts the MEETING IN THE
 * WHERE CLAUSE, so a foreign `fileId` NEVER resolves. THAT CONTAINMENT IS THE WHOLE IDOR
 * STORY FOR `fileId`, and it is why the repository deliberately has no bare `findById` for a
 * caller to reach for instead — every by-id read on this table takes the meeting with it.
 *
 * ⚠ THE MEETING ID USED IS `access.meeting.id` — THE GATE'S ROW, NOT THE PARSED INPUT. They
 * are the same value today (the gate looked the meeting up BY that input), but reading it off
 * the gate result is what keeps that true if the gate ever resolves a meeting by any other
 * route. Docblock and code must name the same thing; they previously did not.
 *
 * ⚠ IT WAS A `listByMeeting(...).find(...)` AND IS NOW AN O(1) READ. Equally contained — the
 * containment was never the array scan, it was the meeting predicate — but it no longer pulls
 * every row AND EVERY `r2Key` of the meeting into memory to return one of them, and it no
 * longer depends silently on `listByMeeting`'s bound (a file past the cap used to be
 * undownloadable).
 *
 * ⚠ A FOREIGN `fileId` AND A SOFT-DELETED ONE RETURN THE SAME COPY, so probing learns
 * nothing about which uuids exist. A CORRUPT ROW (a `party` outside the two-sided CHECK)
 * returns it too — see below.
 *
 * ⚠ THE URL DIES ON ITS OWN AT 300 SECONDS. R2 rejects an expired signature server-side,
 * which is what makes "cannot fetch by holding a stale URL beyond its expiry" true rather
 * than aspirational.
 *
 * ⚠⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare
 * `requireUser()` and therefore sits on `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`. It
 * performs NO writes and reaches none through an import: `authorizeMeetingFileAccess` never
 * mints a row (there is no get-or-create meeting-file resolver to confuse it with, unlike the
 * conversation-access pair that allowlist warns about), and `findInMeeting` is a SELECT.
 */
export async function getMeetingFileDownloadAction(
  input: z.infer<typeof inputSchema>
): Promise<GetMeetingFileDownloadResult> {
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
  const { meetingId, fileId } = parsed.data;

  try {
    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok) {
      return { success: false, error: 'This meeting is no longer available.' };
    }

    // ⚠ `access.meeting.id` — the GATE'S row. Meeting-scoped in the WHERE clause, so a
    // foreign `fileId` resolves to `undefined`, identically to a stale or soft-deleted one.
    const file = await meetingFilesRepository.findInMeeting({
      meetingId: access.meeting.id,
      fileId,
    });
    if (file === undefined) {
      return { success: false, error: 'This file is no longer available.' };
    }

    // ⚠ CONSISTENT WITH `list-meeting-files.ts`, DELIBERATELY. A row whose `party` is not
    // two-sided is CORRUPT — the CHECK `meeting_file_party_two_sided` makes it
    // unrepresentable — and the list DROPS it. Without this branch the same row would be
    // invisible in the list yet still downloadable by anyone who knows its id: two read paths
    // disagreeing about whether a file exists is precisely the divergence that turns a
    // fail-closed posture into a bypass. SAME COPY as a missing file, so the two remain
    // indistinguishable to a prober.
    if (!isTwoSidedParty(file.party)) {
      log.warn('Refusing to download a meeting file with a non-two-sided party', {
        meetingId,
        userId: user.id,
        fileId,
        party: file.party,
      });
      return { success: false, error: 'This file is no longer available.' };
    }

    // The STORED key and the STORED name — never anything the caller supplied.
    const url = await createPresignedMeetingFileDownload(file.r2Key, file.fileName);
    return { success: true, url };
  } catch (error) {
    log.error('Failed to presign meeting file download', {
      meetingId,
      userId: user.id,
      fileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not download this file. Please try again.' };
  }
}
