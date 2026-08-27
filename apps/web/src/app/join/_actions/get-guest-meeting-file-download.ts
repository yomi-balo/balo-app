'use server';

import 'server-only';

import { z } from 'zod';
import { headers } from 'next/headers';
import { isTwoSidedParty, meetingFilesRepository } from '@balo/db';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { hashedClientIp } from '@/lib/magic-link';
import { log } from '@/lib/logging';
import { resolveMeetingGuestSubject } from '@/lib/meetings/resolve-meeting-guest';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';
import { createPresignedMeetingFileDownload } from '@/lib/storage/meeting-file';
import type { DownloadFileActionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z
  .object({
    meetingId: z.uuid(),
    guestToken: z.string().min(20).max(200),
    fileId: z.uuid(),
  })
  .strict();

const GUEST_DOWNLOAD_PRESIGN_TTL_SECONDS = 60;

/**
 * BAL-445 — the GUEST download of one meeting file. Short-lived presigned GET.
 *
 * ⚠⚠ F8/Presign-residual (fix-round-1) — the presign window is 60s, NOT the member action's
 * 300s (`GUEST_DOWNLOAD_PRESIGN_TTL_SECONDS` above). A guest download is always an immediate
 * user click (there is no batching case here), and ruling R1 makes "removing a guest is
 * immediate and total" the load-bearing justification for having no session at all — a 300s
 * window left revocation non-immediate for up to five minutes on exactly the surface where
 * that promise matters most.
 *
 * ⚠ THE RESIDUAL IS SHORTENED, NOT CLOSED. Once minted, Cloudflare R2 honours a presigned URL
 * independently of Balo for its full TTL — a guest revoked at T can still fetch a file whose
 * URL was minted at T−1s until T+59s. That is documented here rather than left implicit, per
 * the fix brief: a 60s window is the right trade for an always-immediate click, not a claim of
 * zero residual.
 *
 * ⚠ `access.meeting.id` — THE GATE'S ROW, NEVER THE PARSED INPUT. `findInMeeting` puts the
 * meeting in the WHERE clause, so a foreign `fileId` resolves to `undefined` identically to a
 * stale or soft-deleted one — the shipped IDOR containment, verbatim.
 *
 * ⚠ A CORRUPT ROW (`party` outside the two-sided CHECK) returns the SAME copy as a missing
 * file — consistent with the member action and with `list-guest-meeting-files.ts`, so the two
 * read paths cannot disagree about whether a file exists.
 *
 * ⚠⚠ F8/WARNING-1 (fix-round-1) — `resolveMeetingGuestSubject` (a DB read) now runs INSIDE the
 * `try`, so a repository throw is logged and collapsed like every other failure shape.
 *
 * ⚠⚠ S1 (fix-round-2) — the second (guest-id-keyed) limiter below uses a `:gid:` prefix,
 * disjoint from the IP-keyed one's `:ip:` prefix, and the IP segment is hashed via
 * `hashedClientIp` — see `list-guest-meeting-files.ts`'s docblock for the collision this closes.
 */
export async function getGuestMeetingFileDownloadAction(
  input: z.infer<typeof inputSchema>
): Promise<DownloadFileActionResult> {
  if (!checkMemoryLimit(`guest-file-download:ip:${hashedClientIp(await headers())}`)) {
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }
  const { meetingId, guestToken, fileId } = parsed.data;

  try {
    const subject = await resolveMeetingGuestSubject(guestToken);
    if (subject === null) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    // ⚠⚠ F7 (fix-round-1) — the SECOND limiter, keyed on the resolved guest, not the IP. See
    // `list-guest-meeting-files.ts`'s docblock for the full reasoning.
    // ⚠⚠ S1 (fix-round-2) — `:gid:`, disjoint from the IP key's `:ip:` prefix above.
    if (!checkMemoryLimit(`guest-file-download:gid:${subject.guest.id}`)) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'guest', guest: subject },
    });
    if (!access.ok) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    const file = await meetingFilesRepository.findInMeeting({
      meetingId: access.meeting.id,
      fileId,
    });
    if (file === undefined) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    if (!isTwoSidedParty(file.party)) {
      log.warn('Refusing to download a meeting file with a non-two-sided party (guest read)', {
        meetingId,
        guestId: subject.guest.id,
        fileId,
        party: file.party,
      });
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    const url = await createPresignedMeetingFileDownload(file.r2Key, file.fileName, {
      expiresInSeconds: GUEST_DOWNLOAD_PRESIGN_TTL_SECONDS,
    });
    return { success: true, url };
  } catch (error) {
    // ⚠ NO `guestId` HERE — `subject` is scoped to the `try` (F8/WARNING-1), and a throw from
    // `resolveMeetingGuestSubject` itself means there IS no resolved guest to name.
    log.error('Failed to presign guest meeting file download', {
      meetingId,
      fileId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }
}
