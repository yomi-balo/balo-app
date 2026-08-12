import 'server-only';

import { isTwoSidedParty, usersRepository, type MeetingFile } from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { log } from '@/lib/logging';
import type { RecapFileRowView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R10 — meeting files → the recap's Files card rows.
 *
 * ⚠⚠ `r2Key` NEVER CROSSES THE WIRE. It is an OBJECT LOCATOR — the exact string
 * `createPresignedMeetingFileDownload` signs — and this shape crosses the server→client
 * serialization boundary. `MeetingFileView` omits it by construction; this mapper projects
 * field-by-field rather than spreading the row, so a new column added to `meeting_files`
 * cannot silently join the payload. Downloads go through `getMeetingFileDownloadAction`,
 * which resolves the key server-side and returns a short-lived presigned GET.
 *
 * ⚠ NO EMAIL ADDRESS IS EVER RESOLVED HERE. Uploader labels come from
 * `usersRepository.findNamesByIds`, which projects `id / firstName / lastName` ONLY — never
 * `email` or `workosId`. A bare relational hydrate would pull both (memory
 * `reference_drizzle_with_hydration_leaks_secrets`). Concealment is enforced by NOT LOADING
 * the column, not by remembering to omit it downstream.
 *
 * ⚠ ONE BATCHED QUERY OVER THE DISTINCT UPLOADER SET — never one query per file. A recap
 * typically has one or two uploaders across many files.
 *
 * ⚠ A ROW WHOSE `party` IS NOT TWO-SIDED IS DROPPED, NEVER COERCED. Same fail-closed posture
 * as `listMeetingFilesAction`: guessing an attribution is worse than omitting the file.
 */
export async function mapRecapFiles(
  rows: readonly MeetingFile[],
  viewerUserId: string
): Promise<RecapFileRowView[]> {
  const uploaderIds = [...new Set(rows.map((row) => row.uploadedByUserId))].filter(
    (id) => id !== viewerUserId
  );

  const names = await usersRepository.findNamesByIds(uploaderIds);
  const firstNameById = new Map<string, string>();
  for (const person of names) {
    firstNameById.set(person.id, personDisplayName(person.firstName, null, 'Someone'));
  }

  const out: RecapFileRowView[] = [];
  for (const row of rows) {
    if (!isTwoSidedParty(row.party)) {
      log.warn('Dropping recap file with a non-two-sided party', {
        meetingId: row.meetingId,
        fileId: row.id,
        party: row.party,
      });
      continue;
    }
    out.push({
      file: {
        id: row.id,
        meetingId: row.meetingId,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        party: row.party,
        source: row.source,
        uploadedByUserId: row.uploadedByUserId,
        createdAtIso: row.createdAt.toISOString(),
      },
      uploaderLabel:
        row.uploadedByUserId === viewerUserId
          ? 'You'
          : (firstNameById.get(row.uploadedByUserId) ?? 'Someone'),
    });
  }
  return out;
}
