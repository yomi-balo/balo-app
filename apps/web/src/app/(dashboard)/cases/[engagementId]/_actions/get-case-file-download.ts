'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository, isTwoSidedParty, meetingFilesRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { createPresignedMeetingFileDownload } from '@/lib/storage/meeting-file';
import { createPresignedConversationFileDownload } from '@/lib/storage/conversation-file';
import type { GetCaseFileDownloadResult } from './_types/case-action-types';

/**
 * ⚠ THE DISCRIMINATED INPUT MIRRORS `CaseFileOrigin`. A `meeting` file REQUIRES its
 * `meetingId` (the download gate takes the meeting as a WHERE term); a `conversation` file
 * forbids it. Expressing that as a Zod union rather than an optional field means a caller
 * cannot hand a meeting id to the conversation arm, or omit one from the meeting arm.
 */
const inputSchema = z.discriminatedUnion('origin', [
  z
    .object({
      engagementId: z.uuid(),
      origin: z.literal('meeting'),
      fileId: z.uuid(),
      meetingId: z.uuid(),
    })
    .strict(),
  z
    .object({ engagementId: z.uuid(), origin: z.literal('conversation'), fileId: z.uuid() })
    .strict(),
]);

/** The one copy every miss answers with — a foreign id and a deleted one are indistinguishable. */
const UNAVAILABLE = 'This file is no longer available.';

/**
 * BAL-421 — a short-lived presigned GET for ONE file on a case, from EITHER side of the D4
 * merge. These files are PRIVATE to the case's participants — never `R2_PUBLIC_URL`.
 *
 * ⚠⚠ A DOWNLOAD IS A **READ**, SO IT IS GATED ON THE MEMBERSHIP/VISIBILITY AXIS AND NEVER ON
 * `hasEngagementCapability`. That axis authorizes the ACT, never the READ, and its holder set
 * EXCLUDES agency role `expert` — precisely the colleagues who need to read delivery
 * artefacts. This is a mistake BAL-423 already made and fixed; it must not be reintroduced
 * here just because this ticket happens to open the engagement-axis seam next door.
 *
 * ⚠⚠ EACH ORIGIN KEEPS ITS OWN AUTHORIZATION HELPER. There is deliberately NO third, unified
 * "case file" gate:
 *
 *   · `meeting`      → `authorizeMeetingFileAccess({ meetingId, userId })` — BAL-423's shipped
 *     gate, UNCHANGED — then `findInMeeting({ meetingId, fileId })`. The repository has NO bare
 *     `findById` by design: every by-id read on that table carries the meeting as a WHERE term,
 *     so a foreign `fileId` NEVER resolves. That containment is the whole IDOR story for
 *     `fileId`, and it is why `meetingId` is REQUIRED on this arm rather than inferred.
 *   · `conversation` → `resolveCaseAccess`, then a lookup SCOPED BY `access.conversationId`.
 *     Same containment, different table.
 *
 * Writing one gate over both would force a single rule onto two tables whose participant sets
 * are resolved differently — a meeting resolves through `meeting_contexts` and its primary
 * context, a case thread through the engagement. That is how a merged file surface grows an
 * IDOR, and it is exactly what the discriminated `origin` exists to prevent.
 *
 * ⚠ `engagementId` IS VALIDATED ON **BOTH** ARMS, INCLUDING THE MEETING ONE. On the meeting
 * arm `authorizeMeetingFileAccess` is INDEPENDENTLY SUFFICIENT for the file itself; re-running
 * the case gate is defence in depth, and it means a caller who cannot reach the named case gets
 * the same refusal whatever file they name.
 *
 * ⚠⚠ IT DOES **NOT** BIND THE MEETING TO THE ENGAGEMENT, AND AN EARLIER VERSION OF THIS
 * DOCBLOCK CLAIMED IT DID ("can never be repurposed as a generic meeting-file oracle"). That
 * claim is false: `data.meetingId` is never checked against `data.engagementId`, so a caller who
 * legitimately reaches case A may name a meeting from case B and — IF `authorizeMeetingFileAccess`
 * independently grants them that meeting — get its file. There is NO security consequence,
 * because that second gate is the one that actually decides, and it decides on the meeting's own
 * participant set. But the two gates are INDEPENDENT rather than composed, and the honest
 * statement of the property is: this action serves a file the caller may read, on a case the
 * caller may read — not "a file of THIS case". Do not rely on the stronger reading; if a caller
 * ever needs it, add an explicit `meeting_contexts` coherence check.
 *
 * ⚠⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare
 * `requireUser()` and therefore sits on `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`.
 * Neither gate mints a row: `authorizeMeetingFileAccess` performs no writes at all, and
 * `resolveCaseAccess` reaches `findByContext`, never `ensureForContext`.
 *
 * ⚠ THE URL DIES ON ITS OWN AT 300 SECONDS — R2 rejects an expired signature server-side,
 * which is what makes "a stale URL stops working" true rather than aspirational.
 */
export async function getCaseFileDownloadAction(
  input: z.infer<typeof inputSchema>
): Promise<GetCaseFileDownloadResult> {
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
  const data = parsed.data;

  try {
    // The case gate runs FIRST on both arms — see the docblock.
    const access = await resolveCaseAccess(data.engagementId, user.id);
    if (access === null) {
      return { success: false, error: 'This case is no longer available.' };
    }

    const url =
      data.origin === 'meeting'
        ? await presignMeetingFile(data.meetingId, data.fileId, user.id)
        : await presignConversationFile(access.conversationId, data.fileId);

    if (url === null) {
      return { success: false, error: UNAVAILABLE };
    }
    return { success: true, url };
  } catch (error) {
    log.error('Failed to presign case file download', {
      engagementId: data.engagementId,
      origin: data.origin,
      fileId: data.fileId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not download this file. Please try again.' };
  }
}

/**
 * The `meeting` arm — BAL-423's gate, unchanged, then a meeting-scoped by-id read.
 *
 * ⚠ THE MEETING ID USED IS `access.meeting.id` — THE GATE'S ROW, not the parsed input. They
 * are the same value today (the gate looked the meeting up BY that input), but reading it off
 * the gate result is what keeps that true if the gate ever resolves a meeting by another route.
 */
async function presignMeetingFile(
  meetingId: string,
  fileId: string,
  userId: string
): Promise<string | null> {
  const access = await authorizeMeetingFileAccess({
    meetingId,
    actor: { kind: 'member', userId },
  });
  if (!access.ok) {
    return null;
  }

  const file = await meetingFilesRepository.findInMeeting({
    meetingId: access.meeting.id,
    fileId,
  });
  if (file === undefined) {
    return null;
  }

  // ⚠ CONSISTENT WITH THE FILES CARD, DELIBERATELY. A row whose `party` is not two-sided is
  // CORRUPT (the CHECK `meeting_file_party_two_sided` makes it unrepresentable) and
  // `loadCaseFiles` DROPS it. Without this branch the same row would be invisible in the card
  // yet still downloadable by anyone who knows its id — two read paths disagreeing about
  // whether a file exists is precisely the divergence that turns fail-closed into a bypass.
  if (!isTwoSidedParty(file.party)) {
    log.warn('Refusing to download a case meeting file with a non-two-sided party', {
      meetingId,
      fileId,
      userId,
      party: file.party,
    });
    return null;
  }

  // The STORED key and the STORED name — never anything the caller supplied.
  return createPresignedMeetingFileDownload(file.r2Key, file.fileName);
}

/**
 * The `conversation` arm — the file must belong to THE GATE-VALIDATED thread.
 *
 * ⚠ `conversationId` COMES FROM THE GATE, so a foreign `fileId` simply is not in this list and
 * resolves to `null` — identically to a stale or soft-deleted one. Probing learns nothing.
 */
async function presignConversationFile(
  conversationId: string,
  fileId: string
): Promise<string | null> {
  const files = await conversationsRepository.listFiles(conversationId, { kind: 'full' });
  const file = files.find((candidate) => candidate.id === fileId);
  if (file === undefined) {
    return null;
  }
  return createPresignedConversationFileDownload(file.r2Key, file.fileName);
}
