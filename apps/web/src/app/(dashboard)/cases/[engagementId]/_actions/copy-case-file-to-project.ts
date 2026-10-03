'use server';

import 'server-only';

import { z } from 'zod';
import {
  conversationsRepository,
  isTwoSidedParty,
  meetingContextsRepository,
  meetingFilesRepository,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { authorizeClientCaseMutation } from '../_lib/authorize-client-case-mutation';
import {
  copyCaseFileIntoProjectDocuments,
  generateProjectDocumentKey,
} from '@/lib/storage/project-document';
import {
  PROJECT_DOCUMENT_CONTENT_TYPES,
  MAX_DOCUMENT_BYTES,
  type ProjectDocumentRef,
} from '@/lib/project-request/actions/schemas';

/**
 * ⚠ THE DISCRIMINATED INPUT MIRRORS `get-case-file-download.ts`'s — a `meeting` file REQUIRES
 * its `meetingId` (the WHERE term the lookup is scoped by), a `conversation` file forbids one.
 */
const inputSchema = z.discriminatedUnion('origin', [
  z
    .object({
      caseId: z.uuid(),
      origin: z.literal('meeting'),
      fileId: z.uuid(),
      meetingId: z.uuid(),
    })
    .strict(),
  z.object({ caseId: z.uuid(), origin: z.literal('conversation'), fileId: z.uuid() }).strict(),
]);

export type CopyCaseFileToProjectResult =
  | { success: true; document: ProjectDocumentRef }
  | { success: false; error: string };

const DENIED = "You don't have permission to attach files from this case.";
const WRONG_WORKSPACE = 'Switch to the workspace this case belongs to.';
/** The one copy every miss answers with — a foreign id and a deleted one are indistinguishable. */
const UNAVAILABLE = 'This file is no longer available.';
const GENERIC_ERROR = 'Could not attach this file. Please try again.';

interface ResolvedCaseFile {
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

type ProjectDocumentContentType = (typeof PROJECT_DOCUMENT_CONTENT_TYPES)[number];

function isProjectDocumentContentType(value: string): value is ProjectDocumentContentType {
  return (PROJECT_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * The `conversation` arm — the file must belong to THE GATE-VALIDATED thread. The conversation
 * is looked up by the CASE's own engagement context (never a client-supplied conversation id),
 * so a foreign `fileId` simply is not in this list and resolves to `null`.
 */
async function resolveConversationFile(
  caseId: string,
  fileId: string
): Promise<ResolvedCaseFile | null> {
  const conversation = await conversationsRepository.findByContext({
    contextType: 'engagement',
    contextId: caseId,
  });
  if (conversation === undefined) {
    return null;
  }
  const files = await conversationsRepository.listFiles(conversation.id, { kind: 'full' });
  const file = files.find((candidate) => candidate.id === fileId);
  if (file === undefined) {
    return null;
  }
  return {
    r2Key: file.r2Key,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
  };
}

/**
 * The `meeting` arm — `meetingId` must be one of THIS CASE's own live meetings before the file
 * lookup even runs, closing the gap a bare `findInMeeting` would leave open (a meeting from a
 * different case, reached by guessing its id).
 */
async function resolveMeetingFile(
  caseId: string,
  meetingId: string,
  fileId: string
): Promise<ResolvedCaseFile | null> {
  const caseMeetings = await meetingContextsRepository.listMeetingsForContext('case', caseId);
  const belongsToCase = caseMeetings.some((meeting) => meeting.id === meetingId);
  if (!belongsToCase) {
    return null;
  }

  const file = await meetingFilesRepository.findInMeeting({ meetingId, fileId });
  if (file === undefined) {
    return null;
  }
  // See `get-case-file-download.ts` — a row whose `party` is not two-sided is CORRUPT and is
  // dropped rather than guessed at.
  if (!isTwoSidedParty(file.party)) {
    log.warn('Refusing to copy a case meeting file with a non-two-sided party', {
      caseId,
      meetingId,
      fileId,
      party: file.party,
    });
    return null;
  }
  return {
    r2Key: file.r2Key,
    fileName: file.fileName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
  };
}

/**
 * BAL-589 (D9) — copy ONE case file (conversation or meeting) into the requester's
 * `project-documents/{companyId}/{userId}/{uuid}` prefix, so selecting a case file in the
 * "Convert to project" panel never makes the client re-upload it.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────────────────────
 *   1. `authorizeClientCaseMutation` — the shared client-lens membership gate, same as
 *      `startCaseBriefParseAction`: an expert-lens actor, or one missing `PARTICIPATE`, is
 *      denied before any file is resolved.
 *   2. The gate's `companyId` must equal the session's ACTIVE company.
 *   3. The file lookup is SCOPED TO THIS CASE on both arms — the conversation is the one
 *      attached to `caseId`'s own engagement context, never a client-supplied conversation id;
 *      the meeting must be one of `caseId`'s own live meetings before its file table is even
 *      read. A `caseId`/`fileId` pair naming another case's file resolves to the SAME
 *      "no longer available" answer as a foreign or deleted one.
 *   4. Eligibility (content type + {@link MAX_DOCUMENT_BYTES}) is re-checked here — defence in
 *      depth behind the picker's own disabled-row rendering.
 *
 * The copied key then passes every existing `isSessionOwnedProjectDocumentKey` guard
 * unchanged, because it is generated by the same {@link generateProjectDocumentKey}.
 */
export async function copyCaseFileToProjectAction(
  rawInput: unknown
): Promise<CopyCaseFileToProjectResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const data = parsed.data;

  const gate = await authorizeClientCaseMutation(data.caseId, user, DENIED);
  if (!gate.ok) {
    log.warn('Case file copy rejected — case gate denied', {
      caseId: data.caseId,
      userId: user.id,
      error: gate.error,
    });
    return { success: false, error: gate.error };
  }
  if (gate.companyId !== user.companyId) {
    log.warn('Case file copy rejected — active company does not match the case', {
      caseId: data.caseId,
      userId: user.id,
      activeCompanyId: user.companyId,
    });
    return { success: false, error: WRONG_WORKSPACE };
  }

  try {
    const file =
      data.origin === 'meeting'
        ? await resolveMeetingFile(data.caseId, data.meetingId, data.fileId)
        : await resolveConversationFile(data.caseId, data.fileId);

    if (file === null) {
      return { success: false, error: UNAVAILABLE };
    }

    if (!isProjectDocumentContentType(file.contentType)) {
      return { success: false, error: 'This file type is not supported.' };
    }
    if (file.sizeBytes > MAX_DOCUMENT_BYTES) {
      return { success: false, error: 'This file is over 5 MB.' };
    }

    const destKey = generateProjectDocumentKey(gate.companyId, user.id);
    await copyCaseFileIntoProjectDocuments(file.r2Key, destKey);

    log.info('Case file copied to project documents', {
      caseId: data.caseId,
      origin: data.origin,
      fileId: data.fileId,
    });

    return {
      success: true,
      document: {
        r2Key: destKey,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      },
    };
  } catch (error) {
    log.error('Failed to copy case file into project documents', {
      caseId: data.caseId,
      origin: data.origin,
      fileId: data.fileId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_ERROR };
  }
}
