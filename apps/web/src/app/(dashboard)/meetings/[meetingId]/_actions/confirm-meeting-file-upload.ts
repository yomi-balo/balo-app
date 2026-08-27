'use server';

import 'server-only';

import { z } from 'zod';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { meetingFilesRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import { publishMeetingEvent } from '@/lib/realtime/ably-server';
import { MEETING_EVENT_FILE } from '@/lib/realtime/channels';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import {
  MEETING_ALLOWED_CONTENT_TYPES,
  MAX_MEETING_FILE_BYTES,
  deleteMeetingFileFromR2,
  meetingFileKeyLeaf,
  meetingFileKeyPrefix,
} from '@/lib/storage/meeting-file';
import { sanitizeMeetingFileName } from '@/lib/storage/meeting-file-constraints';

// meeting-files/{meetingId uuid}/{userId uuid}/{uuid} — the shape `generateMeetingFileKey`
// mints. Anchored at both ends, fixed-width segments, no nested quantifier: linear by
// construction (SonarCloud S5852).
const MEETING_FILE_KEY_PATTERN = /^meeting-files\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

/**
 * ⚠⚠ THERE IS NO `party` KEY IN THIS SCHEMA, AND THAT ABSENCE IS THE CONTROL.
 *
 * `party` is whatever `authorizeMeetingFileAccess` RETURNS as `side`; the insert below writes
 * `party: access.side`. Zod strips unknown keys by default, so a request body carrying
 * `party: 'expert'` from a client-side actor is silently discarded and the row still persists
 * `'client'`. That makes cross-party attribution structurally unreachable rather than merely
 * unchecked — and `confirm-meeting-file-upload.test.ts` asserts exactly that, for both sides.
 *
 * `source` IS a legitimate caller fact — which in-call entry point produced the upload (D0) —
 * and it carries NO authorization weight, so it belongs here and `party` never can.
 *
 * ⚠ THERE IS ALSO NO `contentType` KEY, AND THAT ABSENCE IS DELIBERATE TOO. The presign bound
 * the type into the PUT signature and `verifyUploadedObject` reads it back off the stored
 * object; a claimed type has no remaining job except to be trusted by accident. Removing it
 * from the schema is what makes "the object is the source of truth" structural rather than a
 * convention someone can quietly reintroduce a `??` fallback against.
 *
 * ⚠ `sizeBytes` IS RETAINED, ADVISORY, AND ONLY EVER LOGGED. It never reaches the row —
 * `verified.sizeBytes` (the HEAD result) does. It stays in the schema because a mismatch
 * between what the client thought it uploaded and what R2 holds is worth seeing in a failure
 * log. If you find yourself persisting it, you have reintroduced the same bug as the type.
 */
const inputSchema = z.object({
  meetingId: z.uuid(),
  key: z.string().min(1).max(512),
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  source: z.enum(['chat', 'files_tab']),
});

export type ConfirmMeetingFileUploadResult =
  | { success: true; file: MeetingFileView }
  | { success: false; error: string };

/**
 * True when `error` is a Postgres unique-violation (SQLSTATE 23505) — a double confirm of the
 * same R2 key trips the NON-partial `meeting_file_key_idx`. Structural narrowing (no `any`,
 * no assertion — the `in` guard narrows `object` to carry `code`).
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return 'code' in error && error.code === '23505';
}

/**
 * Key shape + PROVENANCE. The meeting comes from the VALIDATED gate result and the user from
 * the session — neither is client-supplied, so a key minted for another meeting or by another
 * uploader cannot be confirmed here.
 *
 * ⚠ THE EXPECTED PREFIX IS DERIVED FROM `meetingFileKeyPrefix`, THE SAME FUNCTION THE MINTING
 * SIDE USES — never re-spelled here. That is what makes the two sides normalise identically
 * (both lowercase the two uuids) BY CONSTRUCTION. Re-spelling the template here is exactly
 * how an uppercase-hex `meetingId` came to mint a key that `MEETING_FILE_KEY_PATTERN`
 * (lowercase-only) then rejected, orphaning an object already stored in R2.
 */
function validateUploadKey(key: string, meetingId: string, userId: string): string | null {
  if (!MEETING_FILE_KEY_PATTERN.test(key)) {
    return 'Invalid upload key.';
  }
  if (!key.startsWith(meetingFileKeyPrefix(meetingId, userId))) {
    return 'Invalid upload key.';
  }
  return null;
}

type UploadedObjectCheck =
  | { ok: true; sizeBytes: number; contentType: string }
  | { ok: false; error: string };

/**
 * HEAD-checks the object in R2 — size + type read AT THE SOURCE. A rejected object is
 * best-effort deleted.
 *
 * ⚠ MISSING/ZERO SIZE AND OVER-CAP ARE DIFFERENT FAILURES WITH DIFFERENT COPY. Never conflate
 * an empty object under "too large" — the two have opposite user remedies.
 *
 * ⚠⚠ A MISSING `head.ContentType` IS A **REJECTION**, NOT A CUE TO FALL BACK ON THE CLIENT'S
 * CLAIM. This previously read `head.ContentType ?? claimedContentType`, which silently
 * demoted a source-of-truth check into a client assertion in precisely the case where the
 * source of truth was unavailable — i.e. exactly when it mattered. An object with no
 * `Content-Type` cannot be shown to be one of the nine allowed types, and "cannot be shown to
 * be allowed" must resolve to DENIED. It also cannot arise from the shipped upload path
 * (`createPresignedMeetingFileUpload` binds `ContentType` into the signature), so treating it
 * as fatal costs nothing legitimate.
 *
 * ⚠ THE ACTION NO LONGER ACCEPTS A CLAIMED CONTENT TYPE AT ALL — see the input schema. This
 * function therefore takes only the key: there is no second opinion to weigh.
 */
async function verifyUploadedObject(key: string): Promise<UploadedObjectCheck> {
  const head = await r2Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));

  const realSize = head.ContentLength;
  if (realSize === undefined || realSize === 0) {
    deleteMeetingFileFromR2(key).catch(() => {});
    return { ok: false, error: 'The uploaded file appears to be empty.' };
  }
  if (realSize > MAX_MEETING_FILE_BYTES) {
    deleteMeetingFileFromR2(key).catch(() => {});
    return { ok: false, error: 'Uploaded file is too large. Please try a smaller file.' };
  }

  const realContentType = head.ContentType;
  if (realContentType === undefined || !MEETING_ALLOWED_CONTENT_TYPES.has(realContentType)) {
    deleteMeetingFileFromR2(key).catch(() => {});
    return { ok: false, error: 'This file type is not supported.' };
  }

  return { ok: true, sizeBytes: realSize, contentType: realContentType };
}

/**
 * Confirm an uploaded meeting file (BAL-423 — step 3 of presign → PUT → confirm): validates
 * key shape + provenance, HEAD-checks the real size/type in R2, then INSERTS the
 * `meeting_files` row with `party` taken from THE GATE, not from the request.
 *
 * `add` is called STANDALONE (no wider transaction) so its bare-insert contract is satisfied;
 * a duplicate `r2Key` (23505) maps to friendly copy at `log.warn`, not `log.error` — a
 * double-click is expected, not an error.
 *
 * ⚠ NO `revalidatePath` — BAL-132 owns island state and realtime freshness.
 *
 * ⚠⚠ BAL-437 FILLED THE DEFERRED ABLY FAN-OUT, AND IT IS **THE ONLY ONE**. Both in-call entry
 * points reach THIS action — the Files drop as `source: 'files_tab'`, the chat paperclip as
 * `source: 'chat'` — so the single `publishMeetingEvent` below is what makes "the chat
 * paperclip and the Files drop publish through one shared fan-out" STRUCTURAL rather than a
 * convention two callers agree to honour. Do not add a second publish for chat: the chat
 * timeline's inline row consumes this very event.
 *
 * ⚠ NO NOTIFICATION EVENT, UNCHANGED. `conversation.file_shared` exists for the absent
 * counterparty; there is none here. If BAL-132 finds a real absent-recipient case (a file
 * added after the call ends, to a party who has left), the correct move is
 * `notificationEvents.publish()` from THIS action — never a direct Brevo call — with the
 * payload defined ONCE in `@balo/shared/notifications`.
 *
 * ⚠ NO POSTHOG EVENTS, SAME REASONING. This ships inert (D4), so every constant would have
 * zero producers; event registration costs five files, two of them re-export allowlists that
 * fail in a different package. BAL-132 owns the events and will know their real UX names.
 */
export async function confirmMeetingFileUploadAction(
  input: z.infer<typeof inputSchema>
): Promise<ConfirmMeetingFileUploadResult> {
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
  const { meetingId, key, fileName, sizeBytes, source } = parsed.data;

  try {
    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok) {
      return { success: false, error: 'This meeting is no longer available.' };
    }
    // ⚠⚠ THE GUEST-UPLOAD BRAKE (BAL-445), AND IT IS THE POINT — `party: access.side` cannot
    // compile for a guest (the guest arm carries no `side`), so "a guest may not upload"
    // is a type property, not a convention. Unreachable in production today: this action
    // gates on `requireOnboardedUser()` above, which a guest never satisfies. Handled anyway,
    // per `fetch-meeting-thread.ts`'s precedent that a Server Action is a public endpoint and
    // must never assume its own UI.
    if (access.viewer !== 'member') {
      return { success: false, error: 'This meeting is no longer available.' };
    }

    // 1. Key shape + provenance: meeting from the VALIDATED gate, user from the session.
    const keyError = validateUploadKey(key, meetingId, user.id);
    if (keyError !== null) {
      return { success: false, error: keyError };
    }

    // 2. Verify the object in R2 — size + type read at the source.
    const verified = await verifyUploadedObject(key);
    if (!verified.ok) {
      return { success: false, error: verified.error };
    }

    // 3. ⚠ SANITISE THE NAME AT **WRITE** TIME. Bidi override code points are stripped here,
    //    once, so every present and future reader of this row — the in-call list, chat, the
    //    download's `Content-Disposition`, BAL-421's merged case view — is safe by default
    //    rather than by each remembering. See `sanitizeMeetingFileName`.
    //
    //    A name made ENTIRELY of those controls strips to `''`, which is not a name. It is a
    //    rejection, and the already-stored object is best-effort deleted so it does not
    //    linger unreferenced.
    const safeFileName = sanitizeMeetingFileName(fileName);
    if (safeFileName === '') {
      deleteMeetingFileFromR2(key).catch(() => {});
      return { success: false, error: 'This file name is not supported.' };
    }

    // 4. Insert the row (standalone, no wider tx — the bare-insert contract).
    //    ⚠ `party: access.side` — THE GATE'S RESOLVED SIDE. Never `input.party`; there is no
    //    such field, by design.
    const row = await meetingFilesRepository.add({
      meetingId,
      uploadedByUserId: user.id,
      party: access.side,
      source,
      r2Key: key,
      fileName: safeFileName,
      contentType: verified.contentType,
      sizeBytes: verified.sizeBytes,
    });

    const file: MeetingFileView = {
      id: row.id,
      meetingId: row.meetingId,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      // ⚠ `access.side`, NOT `row.party` — and they are the same value by construction (it
      // is what the insert above wrote). The column reuses the THREE-label
      // `meeting_participant_party` enum narrowed by the CHECK
      // `meeting_file_party_two_sided`, so `$inferSelect` types it wider than it can ever
      // be at rest. The gate's `side` is already exactly two-valued, so reading it here
      // needs no narrowing branch and invents no default for an unrepresentable label.
      party: access.side,
      source: row.source,
      uploadedByUserId: row.uploadedByUserId,
      createdAtIso: row.createdAt.toISOString(),
    };

    // The key business event. ⚠ Never log `r2Key` at info, and never log the file NAME — it
    // can carry PII — nor, obviously, the contents.
    log.info('Meeting file shared', {
      meetingId,
      userId: user.id,
      fileId: row.id,
      party: row.party,
      source: row.source,
      sizeBytes: verified.sizeBytes,
      contentType: verified.contentType,
    });

    /**
     * ⚠⚠ **THE ONE FAN-OUT.** Both in-call surfaces consume this single event: the Files panel
     * bumps its revision and reloads; the chat timeline prepends an inline row for
     * `source: 'chat'` only. ⚠ IT NEVER THROWS AND IT IS DEFERRED — a publish failure is a
     * `log.error`, and the row is already persisted and already returned below, so the sharer
     * is never told a shared file failed.
     */
    void publishMeetingEvent(meetingId, MEETING_EVENT_FILE, file);

    return { success: true, file };
  } catch (error) {
    // ⚠ THE KEY'S LEAF UUID, NEVER THE FULL `r2Key` — at warn OR error. The full key spells
    // out the meeting id and the uploader's user id and is a directly usable storage path;
    // this module's own docblock sets that bar for `log.info`, and it does not relax one
    // level down. The leaf correlates two lines about the same object and reveals nothing
    // else. `meetingId` and `userId` are already present as first-class fields.
    const fileKeyLeaf = meetingFileKeyLeaf(key);

    // A duplicate confirm (double-click/retry) is EXPECTED — warn, not error.
    if (isUniqueViolation(error)) {
      log.warn('Duplicate meeting file confirm (expected double-click)', {
        meetingId,
        userId: user.id,
        fileKeyLeaf,
      });
      return { success: false, error: 'This file was already shared.' };
    }
    log.error('Failed to confirm meeting file upload', {
      meetingId,
      userId: user.id,
      fileKeyLeaf,
      sizeBytes,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not share your file. Please try again.' };
  }
}
