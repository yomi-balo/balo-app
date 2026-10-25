'use server';

import 'server-only';

import { z } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { requestSharedFilesRepository, RequestFileTrackNotLiveError } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { publishConversationEvent } from '@/lib/realtime/ably-server';
import { CONVERSATION_EVENT_FILE_SHARED } from '@/lib/realtime/channels';
import type { ConversationFileSharedPayload } from '@/lib/realtime/message-payload';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { plainMessageToHtml } from '@/lib/sanitize/plain-message-html';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { mapMessageRowToView } from '@/lib/conversations/conversation-view';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import {
  MESSAGE_MAX_TEXT,
  previewOfPlainText,
} from '@/lib/project-request/conversation-view-types';
// ⚠ `@balo/analytics/events` — the PURE constants subpath, never `/client`.
import {
  REQUEST_FILE_SHARE_ENTRY_POINTS,
  REQUEST_FILE_SHARE_AUDIENCE_CHOICES,
} from '@balo/analytics/events';
import { trackServerAndFlush, REQUEST_FILE_SERVER_EVENTS } from '@/lib/analytics/server';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  REQUEST_FILE_ALLOWED_CONTENT_TYPES,
  MAX_REQUEST_FILE_BYTES,
  deleteRequestFileFromR2,
} from '@/lib/storage/request-file';
import { validateRequestUploadKey } from '@/lib/request-files/request-upload-key';
import {
  authorizeRequestFileScope,
  REQUEST_FILES_UNAVAILABLE_COPY,
  REQUEST_FILE_TRACK_CLOSED_SELF_COPY,
  type RequestFileScope,
} from '@/lib/request-files/authorize-request-file-scope';
import {
  loadTrackDisplays,
  toSerializerFile,
  fullName,
  clientUploaderLabel,
} from '@/lib/request-files/load-request-files';
import {
  toClientRequestFileView,
  toExpertRequestFileView,
  type ClientRequestFileView,
  type ExpertRequestFileView,
  type RequestThreadFileCard,
} from '@/lib/request-files/request-file-audience-view';
import type { ShareRequestFileInput, ShareRequestFileResult } from '@balo/db';

const inputSchema = z.object({
  requestId: z.uuid(),
  key: z.string().min(1).max(512),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  /**
   * ⚠ THE ONLY CALLER-SUPPLIED AUDIENCE INPUT, AND IT IS IGNORED ON THE EXPERT SIDE. The gate
   * decides `side`; if `side === 'expert'` this field is discarded and the repository is
   * called with `audience: 'own_track'`. A client may name only LIVE tracks on THEIR OWN
   * request, re-validated in-transaction.
   */
  share: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('all_live_tracks') }),
    z.object({ mode: z.literal('grants'), relationshipIds: z.array(z.uuid()).min(1).max(50) }),
  ]),
  /**
   * The optional note that travels with the file as the card message's body. Plain text; the
   * server converts + sanitises it. 20000 is the coarse DoS bound — the UX limit is
   * `MESSAGE_MAX_TEXT` plain characters, enforced after the strip.
   */
  note: z.string().max(20000).optional(),
  /**
   * ⚠ ANALYTICS ONLY — NEVER AN AUTHORIZATION INPUT. Where the share started and what the
   * sharer picked, recorded as-claimed. The audience that is actually written comes from the
   * gate and `share` above, never from here; on the expert arm `audienceChoice` is coerced to
   * `this_thread` because an expert has no audience choice.
   */
  origin: z.object({
    entryPoint: z.enum(REQUEST_FILE_SHARE_ENTRY_POINTS),
    audienceChoice: z.enum(REQUEST_FILE_SHARE_AUDIENCE_CHOICES),
  }),
});

export type ConfirmRequestFileUploadResult =
  | {
      success: true;
      view: ClientRequestFileView | ExpertRequestFileView;
      /**
       * The card messages this share posted, one per receiving track whose thread is open, each
       * carrying `requestSharedFile` built from the SENDER's own lens. Empty when no receiving
       * track had an open thread.
       */
      threadMessages: Array<{ relationshipId: string; message: ConversationMessageView }>;
    }
  | { success: false; error: string };

type UploadedObjectCheck =
  | { ok: true; sizeBytes: number; contentType: string }
  | { ok: false; error: string };

/** HEAD-checks the object in R2 — size + type re-checked at the source (mirrors the conversation-file confirm action). */
async function verifyUploadedObject(
  key: string,
  claimedContentType: string
): Promise<UploadedObjectCheck> {
  const head = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));

  const realSize = head.ContentLength;
  if (realSize === undefined || realSize === 0) {
    deleteRequestFileFromR2(key).catch(() => {});
    return { ok: false, error: 'The uploaded file appears to be empty.' };
  }
  if (realSize > MAX_REQUEST_FILE_BYTES) {
    deleteRequestFileFromR2(key).catch(() => {});
    return { ok: false, error: 'Uploaded file is too large. Please try a smaller file.' };
  }

  const resolvedContentType = head.ContentType ?? claimedContentType;
  if (!REQUEST_FILE_ALLOWED_CONTENT_TYPES.has(resolvedContentType)) {
    deleteRequestFileFromR2(key).catch(() => {});
    return { ok: false, error: 'This file type is not supported.' };
  }

  return { ok: true, sizeBytes: realSize, contentType: resolvedContentType };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '23505';
}

type NonAdminScope = Extract<RequestFileScope, { ok: true; side: 'client' | 'expert' }>;

type ShareTarget = Pick<
  ShareRequestFileInput,
  'side' | 'audience' | 'expertRelationshipId' | 'grantRelationshipIds'
>;

/**
 * ⚠ ONE flat if/else, deliberately NOT a nested ternary (SonarCloud S3358) — the gate's
 * resolved `side` decides everything; the caller-supplied `share` field is read ONLY on the
 * client arm (§6.2 — ignored on the expert side).
 */
function deriveShareTarget(
  scope: NonAdminScope,
  share: z.infer<typeof inputSchema>['share']
): ShareTarget {
  if (scope.side === 'expert') {
    return {
      side: 'expert',
      audience: 'own_track',
      expertRelationshipId: scope.viewer.relationshipId,
      grantRelationshipIds: [],
    };
  }
  if (share.mode === 'all_live_tracks') {
    return {
      side: 'client',
      audience: 'all_live_tracks',
      expertRelationshipId: null,
      grantRelationshipIds: [],
    };
  }
  return {
    side: 'client',
    audience: 'grants',
    expertRelationshipId: null,
    grantRelationshipIds: share.relationshipIds,
  };
}

/**
 * Post-commit notifications — silent-by-design failures never surface to the caller
 * (`publishNotificationEvent` logs internally). ONE publish per resolved track on the client
 * arm — never a single "shared with everyone" fan-out, so each candidate's own dedupe key is
 * distinct.
 */
function publishShareNotifications(
  scope: NonAdminScope,
  shareResult: ShareRequestFileResult,
  uploaderPersonName: string,
  clientCompanyName: string,
  noteExcerpt: string | undefined
): void {
  // An excerpt is NOT an audience field (ADR-1048 §3): it is the sharer's own note, shown to the
  // recipient the share already reaches, so it is added only when there is one.
  const excerpt = noteExcerpt === undefined ? {} : { noteExcerpt };
  if (scope.side === 'expert') {
    publishNotificationEvent('request_file.shared_with_client', {
      correlationId: shareResult.file.id,
      fileId: shareResult.file.id,
      requestId: scope.request.id,
      relationshipId: scope.viewer.relationshipId,
      recipientId: scope.request.createdByUserId,
      requestTitle: scope.request.title,
      // No agency-name resolution in this PR — an independent expert's own name is also the
      // honest fallback the `personWithOrgLabel` template helper collapses to.
      expertPartyLabel: uploaderPersonName,
      expertPersonLabel: uploaderPersonName,
      fileName: shareResult.file.fileName,
      ...excerpt,
    }).catch(() => {});
    return;
  }
  for (const track of shareResult.resolvedLiveTracks) {
    publishNotificationEvent('request_file.shared_with_expert', {
      correlationId: `${shareResult.file.id}:${track.relationshipId}`,
      fileId: shareResult.file.id,
      requestId: scope.request.id,
      relationshipId: track.relationshipId,
      expertProfileId: track.expertProfileId,
      requestTitle: scope.request.title,
      clientCompanyName,
      sharedByPersonLabel: uploaderPersonName,
      fileName: shareResult.file.fileName,
      ...excerpt,
    }).catch(() => {});
  }
}

/** The audience-keyed view of the just-shared file — the confirm action's own return payload. */
async function buildShareView(
  scope: NonAdminScope,
  shareResult: ShareRequestFileResult,
  uploaderPersonName: string,
  clientCompanyName: string
): Promise<ClientRequestFileView | ExpertRequestFileView> {
  const serialized = toSerializerFile(shareResult.file);
  if (scope.side === 'expert') {
    // The upload gate admits only a live track, so `openedAt` is set; the fallback only narrows.
    const joinedAt = scope.viewer.standing.openedAt ?? new Date(0);
    return toExpertRequestFileView(serialized, clientCompanyName, {
      relationshipId: scope.viewer.relationshipId,
      joinedAt,
      access: scope.viewer.access,
    });
  }
  const tracks = await loadTrackDisplays(scope);
  return toClientRequestFileView(
    serialized,
    new Set(shareResult.grants.map((g) => g.relationshipId)),
    tracks,
    // ⚠ THE SHARED HELPER, not an inline template — the loader builds the SAME label for the
    // SAME row on the next page load. Two forms for one file was a real inconsistency.
    clientUploaderLabel(uploaderPersonName, clientCompanyName)
  );
}

type ShareNote = { ok: true; html: string; plainText: string } | { ok: false; error: string };

/**
 * The note → the card message's body. SECURITY BOUNDARY, identical to the composer's: plain text
 * → escaped minimal HTML → sanitiser, before persist. An empty (or markup-only) note is valid
 * and yields `html: ''`, a note-less card. Runs BEFORE the R2 verification, because that step
 * deletes the object on failure — a too-long note must leave the upload intact so the sharer
 * can shorten it and retry.
 */
function prepareShareNote(note: string | undefined): ShareNote {
  const trimmed = note?.trim() ?? '';
  if (trimmed.length === 0) return { ok: true, html: '', plainText: '' };
  const html = sanitizeProjectHtml(plainMessageToHtml(trimmed));
  const plainText = htmlToPlainText(html);
  if (plainText.length > MESSAGE_MAX_TEXT) {
    return { ok: false, error: `Keep your note under ${MESSAGE_MAX_TEXT} characters.` };
  }
  return plainText.length === 0
    ? { ok: true, html: '', plainText: '' }
    : { ok: true, html, plainText };
}

/** The sender's own card: `audience` is present only on the client-lens view. */
function senderCardOf(view: ClientRequestFileView | ExpertRequestFileView): RequestThreadFileCard {
  return 'audience' in view ? { kind: 'client', file: view } : { kind: 'expert', file: view };
}

type ConfirmGate =
  | { ok: true; scope: NonAdminScope; verified: Extract<UploadedObjectCheck, { ok: true }> }
  | { ok: false; error: string };

/**
 * Everything that must be TRUE before a share write is attempted, collapsed into one gate so
 * the action body reads as a flat sequence rather than four nested early-returns (SonarCloud
 * cognitive-complexity S3776): the scope gate, the admin read-only lens, Ruling 3's "upload
 * requires a live track" on the expert arm, key provenance (§7.5), and the R2 object
 * re-verification.
 */
async function resolveConfirmGate(
  user: Parameters<typeof authorizeRequestFileScope>[0],
  requestId: string,
  key: string,
  contentType: string
): Promise<ConfirmGate> {
  const scope = await authorizeRequestFileScope(user, requestId);
  if (!scope.ok) {
    return { ok: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
  }
  if (scope.side === 'admin') {
    return { ok: false, error: REQUEST_FILES_UNAVAILABLE_COPY };
  }
  // ⚠ SECOND PERSON: `side === 'expert'` means the READER is the expert whose track closed.
  // Deliberately NOT the third-person copy used in the `RequestFileTrackNotLiveError` catch
  // below — that one runs on the CLIENT arm, telling the client about someone else.
  if (scope.side === 'expert' && scope.viewer.access.kind !== 'live') {
    return { ok: false, error: REQUEST_FILE_TRACK_CLOSED_SELF_COPY };
  }

  const keyError = validateRequestUploadKey(key, scope.request.id, user.id);
  if (keyError !== null) {
    return { ok: false, error: keyError };
  }

  const verified = await verifyUploadedObject(key, contentType);
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }

  return { ok: true, scope, verified };
}

/**
 * Confirm a request-shared-file upload — THE SHARE WRITE (BAL-431 / ADR-1048). Validates key
 * shape + provenance, HEAD-checks the real size/type in R2, then calls
 * `requestSharedFilesRepository.share(...)` with `side` / `audience` / `expertRelationshipId`
 * taken from the GATE, never the request body. Publishes notifications + analytics AFTER the
 * transaction commits. No `revalidatePath` — the request island owns its own file state.
 *
 * ⚠ THE SHARE ALSO POSTS A CARD MESSAGE (BAL-617) into every receiving track whose thread is
 * open, INSIDE the share transaction (`threadMessageBody`), carrying the optional note. It
 * publishes the content-free `file_shared` ping per posted card — and NEVER
 * `conversation.message_posted`: a share notifies through `request_file.shared_with_*` alone, so
 * a recipient is never told twice.
 */
export async function confirmRequestFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<ConfirmRequestFileUploadResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, key, fileName, contentType, sizeBytes, share, origin } = parsed.data;

  const note = prepareShareNote(parsed.data.note);
  if (!note.ok) {
    return { success: false, error: note.error };
  }

  try {
    const gate = await resolveConfirmGate(user, requestId, key, contentType);
    if (!gate.ok) {
      return { success: false, error: gate.error };
    }
    const { scope, verified } = gate;

    const target = deriveShareTarget(scope, share);
    const shareResult = await requestSharedFilesRepository.share({
      projectRequestId: scope.request.id,
      uploadedByUserId: user.id,
      ...target,
      r2Key: key,
      fileName,
      contentType: verified.contentType,
      sizeBytes: verified.sizeBytes,
      threadMessageBody: note.html,
    });

    const hasNote = note.plainText.length > 0;
    trackServerAndFlush(REQUEST_FILE_SERVER_EVENTS.UPLOADED, {
      uploader_side: target.side,
      audience_type: shareResult.file.audience,
      track_count: shareResult.resolvedLiveTracks.length,
      entry_point: origin.entryPoint,
      audience_choice: target.side === 'expert' ? 'this_thread' : origin.audienceChoice,
      has_note: hasNote,
      distinct_id: user.id,
    });

    const uploaderPersonName = fullName(user.firstName, user.lastName, 'Someone');
    const clientCompanyName = scope.request.company?.name ?? 'the client';
    publishShareNotifications(
      scope,
      shareResult,
      uploaderPersonName,
      clientCompanyName,
      hasNote ? previewOfPlainText(note.plainText) : undefined
    );

    // The content-free ping, once per posted card, after commit. Deferred inside the publisher;
    // never throws. The receiving islands refetch through the lens-correct read.
    for (const { conversationId, message } of shareResult.threadMessages) {
      const ping: ConversationFileSharedPayload = {
        conversationId,
        messageId: message.id,
        senderUserId: message.senderUserId,
        createdAtIso: message.createdAt.toISOString(),
      };
      void publishConversationEvent(conversationId, CONVERSATION_EVENT_FILE_SHARED, ping);
    }

    log.info('Request file shared', {
      requestId: scope.request.id,
      userId: user.id,
      fileId: shareResult.file.id,
      side: shareResult.file.side,
      audience: shareResult.file.audience,
      trackCount: shareResult.resolvedLiveTracks.length,
      threadMessageCount: shareResult.threadMessages.length,
      entryPoint: origin.entryPoint,
      hasNote,
    });

    const view = await buildShareView(scope, shareResult, uploaderPersonName, clientCompanyName);
    const card = senderCardOf(view);
    return {
      success: true,
      view,
      threadMessages: shareResult.threadMessages.map(({ relationshipId, message }) => ({
        relationshipId,
        message: {
          ...mapMessageRowToView({
            ...message,
            senderFirstName: user.firstName,
            senderLastName: user.lastName,
          }),
          requestSharedFile: card,
        },
      })),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      log.warn('Duplicate request file confirm (expected double-click)', {
        requestId,
        userId: user.id,
        key,
      });
      return { success: false, error: 'This file was already shared.' };
    }
    if (error instanceof RequestFileTrackNotLiveError) {
      log.warn('Request file share targeted a closed track', {
        requestId,
        userId: user.id,
        relationshipId: error.relationshipId,
      });
      // ⚠ THIRD PERSON, AND CORRECTLY SO. `RequestFileTrackNotLiveError` is raised only when a
      // CLIENT named a closed track in a `grants` share — the reader is the client, being told
      // about someone else. Do NOT unify this with `REQUEST_FILE_TRACK_CLOSED_SELF_COPY`.
      return { success: false, error: 'That expert is no longer on this request.' };
    }
    log.error('Failed to confirm request file upload', {
      requestId,
      userId: user.id,
      key,
      sizeBytes,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not share your file. Please try again.' };
  }
}
