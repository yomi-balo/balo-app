'use server';

import 'server-only';

import { z } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { requestSharedFilesRepository, RequestFileTrackNotLiveError } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { trackServerAndFlush, REQUEST_FILE_SERVER_EVENTS } from '@/lib/analytics/server';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  REQUEST_FILE_ALLOWED_CONTENT_TYPES,
  MAX_REQUEST_FILE_BYTES,
  REQUEST_FILE_PREFIX,
  deleteRequestFileFromR2,
} from '@/lib/storage/request-file';
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
});

export type ConfirmRequestFileUploadResult =
  | { success: true; view: ClientRequestFileView | ExpertRequestFileView }
  | { success: false; error: string };

const UUID_RE = /^[0-9a-f-]{36}$/;

/**
 * Key shape + provenance (§7.5): request from the VALIDATED gate, user from the session.
 * Segment-split, NOT a regex over the whole key — avoids a ReDoS-shaped pattern (memory
 * `reference_sonarcloud_redos_tagstrip_regex`) and satisfies `noUncheckedIndexedAccess` by
 * destructure-and-guard rather than `!` (memory `reference_sonar_nonnull_false_positive`).
 */
function validateRequestUploadKey(
  key: string,
  projectRequestId: string,
  userId: string
): string | null {
  const [prefix, keyRequestId, keyUserId, leaf, ...extra] = key.split('/');
  if (extra.length > 0) return 'Invalid upload key.';
  if (`${prefix}/` !== REQUEST_FILE_PREFIX) return 'Invalid upload key.';
  if (keyRequestId !== projectRequestId) return 'Invalid upload key.';
  if (keyUserId !== userId) return 'Invalid upload key.';
  if (leaf === undefined || !UUID_RE.test(leaf)) return 'Invalid upload key.';
  return null;
}

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
  clientCompanyName: string
): void {
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
    const invitedAt =
      scope.request.relationships.find((r) => r.id === scope.viewer.relationshipId)?.invitedAt ??
      new Date(0);
    return toExpertRequestFileView(serialized, clientCompanyName, {
      relationshipId: scope.viewer.relationshipId,
      invitedAt,
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
 * transaction commits. No `revalidatePath` — the panel owns its own island state.
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
  const { requestId, key, fileName, contentType, sizeBytes, share } = parsed.data;

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
    });

    trackServerAndFlush(REQUEST_FILE_SERVER_EVENTS.UPLOADED, {
      uploader_side: target.side,
      audience_type: shareResult.file.audience,
      track_count: shareResult.resolvedLiveTracks.length,
      distinct_id: user.id,
    });

    const uploaderPersonName = fullName(user.firstName, user.lastName, 'Someone');
    const clientCompanyName = scope.request.company?.name ?? 'the client';
    publishShareNotifications(scope, shareResult, uploaderPersonName, clientCompanyName);

    log.info('Request file shared', {
      requestId: scope.request.id,
      userId: user.id,
      fileId: shareResult.file.id,
      side: shareResult.file.side,
      audience: shareResult.file.audience,
      trackCount: shareResult.resolvedLiveTracks.length,
    });

    const view = await buildShareView(scope, shareResult, uploaderPersonName, clientCompanyName);
    return { success: true, view };
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
