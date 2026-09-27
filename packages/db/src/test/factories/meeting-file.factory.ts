import { randomUUID } from 'node:crypto';
import { db } from '../../client';
import { meetingFiles } from '../../schema';
import type { MeetingFile, MeetingFileSource } from '../../schema';
import { userFactory } from './user.factory';

interface MeetingFileFactoryInput {
  meetingId: string;
  /** Which in-call entry point produced it: the chat paperclip or the Files tab. */
  source: MeetingFileSource;
  /**
   * REQUIRED, no default: `defaultNow()` is the per-test transaction's start, shared by every
   * row the test writes, so a defaulted timestamp ties with everything else.
   */
  createdAt: Date;
  deletedAt?: Date;
  /** Defaults to a fresh user. */
  uploadedByUserId?: string;
  /** Defaults to `client`. The CHECK `meeting_file_party_two_sided` allows `client | expert`. */
  party?: MeetingFile['party'];
}

/**
 * Seeds ONE `meeting_files` row (BAL-423, a file uploaded during a call) with a controlled
 * `createdAt` and a fresh unique `r2_key`.
 *
 * Inserts DIRECTLY via `db`: `meetingFilesRepository.add` takes no `createdAt`.
 */
export async function meetingFileFactory(
  input: MeetingFileFactoryInput
): Promise<{ id: string; createdAt: Date }> {
  const uploadedByUserId = input.uploadedByUserId ?? (await userFactory()).id;

  const [row] = await db
    .insert(meetingFiles)
    .values({
      meetingId: input.meetingId,
      uploadedByUserId,
      party: input.party ?? 'client',
      source: input.source,
      r2Key: `meeting-files/${randomUUID()}`,
      fileName: 'seed.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      createdAt: input.createdAt,
      ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
    })
    .returning({ id: meetingFiles.id, createdAt: meetingFiles.createdAt });
  if (row === undefined) {
    throw new Error('meeting file insert failed');
  }
  return row;
}
