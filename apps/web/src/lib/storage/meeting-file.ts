import 'server-only';

import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2Client, R2_BUCKET } from '@/lib/storage/r2';
import { log } from '@/lib/logging';

/**
 * R2 storage seam for MEETING files (BAL-423 — D0/D1). THE FIFTH INSTANCE of the shipped
 * `lib/storage/` presign convention (avatars, project documents, proposal documents,
 * conversation files, now meeting files), copied structurally from `conversation-file.ts`.
 *
 * ⚠ IT IMPORTS `r2Client` / `R2_BUCKET` FROM `@/lib/storage/r2` AND NEVER RE-INLINES THEM.
 * That is D1 stated as code: one client, one bucket binding, one place the `R2_*` env vars are
 * read. A second `new S3Client({...})` here would be a second credential surface that could
 * silently point at a different endpoint.
 *
 * ⚠ DOWNLOADS ARE PRESIGNED GETs, NEVER `R2_PUBLIC_URL`. These files are private to the
 * meeting's participants; every read is gated by `authorizeMeetingFileAccess` and then handed
 * a signature that dies in 300 seconds. Key unguessability is NOT access control — it is
 * defence in depth behind the gate.
 *
 * ⚠ THE SERVICE LIVES IN `apps/web`, NOT `apps/api`. The `R2_*` server vars are Vercel-only
 * today (OQ-1 on `apps/api/src/lib/storage/r2.ts`), so the presign must run here regardless;
 * authorizing in one app and presigning in another would add a trust boundary and a network
 * hop to a live-call action.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠⚠ THE 10 MB CAP IS BOUND INTO THE SIGNATURE, NOT MERELY CHECKED AFTERWARDS.
 * ──────────────────────────────────────────────────────────────────────────────
 * `createPresignedMeetingFileUpload` signs a `ContentLength`, so R2 REJECTS a body of any
 * other length at the edge, before a byte is stored. Without it the cap would be advisory
 * until the post-hoc `HeadObjectCommand` in `confirm-meeting-file-upload.ts` — i.e. an
 * attacker holding one valid presigned URL could park an arbitrarily large object in the
 * bucket (billable, and never confirmed, so never reachable by any read path and never
 * deleted) simply by not calling confirm. The HEAD check REMAINS, as defence in depth and as
 * the source of truth for what is persisted; it is no longer the only control.
 *
 * ⚠ `lib/storage/conversation-file.ts` HAS THE SAME GAP — INHERITED, AND DELIBERATELY NOT
 * FIXED HERE. This module was copied structurally from it, and its presigned PUT still binds
 * no `ContentLength`. Closing it there is a SEPARATE TICKET: that surface HAS live callers
 * (BAL-424's messaging), so changing its presign signature changes a shipped client contract
 * and needs its own test pass and rollout. Do not "while I'm here" it into this PR.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠ RESIDUAL, STATED RATHER THAN SILENTLY CARRIED: THE CONFIRM-TIME SWAP (TOCTOU).
 * ──────────────────────────────────────────────────────────────────────────────
 * The presigned PUT stays valid for its full `UPLOAD_TTL_SECONDS`, INCLUDING after confirm
 * has HEAD-verified the object. So within that window the uploader can overwrite the object
 * with different CONTENT at the SAME key, and the row's `content_type` / `size_bytes` then
 * describe bytes that are no longer there.
 *
 *   · THE SIZE AND TYPE HALVES ARE CLOSED by the signed `ContentLength` above plus the
 *     `ContentType` the signature already bound: a replacement body must match both, so it
 *     cannot become larger, smaller, or a different declared type than the row records.
 *   · WHAT REMAINS is a same-length, same-type content swap inside a ≤60-second window, by
 *     the ORIGINAL UPLOADER ONLY (the signature is bound to the key they were issued, which
 *     `validateUploadKey` proves was minted for that meeting AND that user). It is not a
 *     cross-party or cross-tenant hole.
 *   · CLOSING IT NEEDS PERSISTED STATE THIS TABLE DOES NOT HAVE: capture the object's `ETag`
 *     at confirm and send `IfMatch` on the download `GetObjectCommand`. That requires a NEW
 *     `meeting_files` COLUMN, which is out of scope for this PR — NO SCHEMA COLUMN WAS ADDED.
 *     It is BAL-132's to take, together with the `conversation-file.ts` fix above, since both
 *     want the same `etag` + `IfMatch` shape.
 */

// ── Constants ──
/** Key prefix all meeting files live under. Also the `deleteMeetingFileFromR2` guard. */
export const MEETING_FILE_PREFIX = 'meeting-files/';

// Allow-list + cap live in the client-safe constraints module (BAL-132's drop-zone
// pre-validates); re-exported here so server callers keep one import site.
export { MEETING_ALLOWED_CONTENT_TYPES, MAX_MEETING_FILE_BYTES } from './meeting-file-constraints';
import { MEETING_ALLOWED_CONTENT_TYPES, MAX_MEETING_FILE_BYTES } from './meeting-file-constraints';

/**
 * ⚠ 60 SECONDS, AND `MAX_MEETING_FILE_BYTES = 10 MB` IS PINNED TO IT. A larger cap lets a
 * slow-connection PUT outrun its own signature and fail opaquely mid-call. Raise both or
 * neither — see the constraints module's docblock.
 */
const UPLOAD_TTL_SECONDS = 60;

/** Long enough to click through a download, short enough that a leaked URL dies quickly. */
const DOWNLOAD_TTL_SECONDS = 300;

// ── Key generation ──
/**
 * ⚠⚠ THE ONE DEFINITION OF A MEETING FILE'S KEY PREFIX — MINTED HERE, VERIFIED HERE.
 *
 * `generateMeetingFileKey` builds on it and `confirm-meeting-file-upload.ts` re-derives the
 * expected prefix from it for its `startsWith` provenance check. Both sides therefore
 * NORMALISE IDENTICALLY BY CONSTRUCTION rather than by two functions that happen to agree.
 *
 * ⚠ THE LOWERCASING IS LOAD-BEARING, NOT COSMETIC. `z.uuid()` accepts UPPERCASE hex and
 * Postgres resolves an uppercase uuid to the same row, so an uppercase `meetingId` passes
 * validation and the gate — but it would then mint a key that
 * `MEETING_FILE_KEY_PATTERN` (`[0-9a-f-]`, lowercase-only) REJECTS at confirm. The object
 * would already be in R2, unconfirmable and therefore unreachable by every read path and
 * never deleted: PERMANENTLY ORPHANED, with no error the uploader could act on. Normalising
 * at the single point both sides share is what makes that unreachable.
 * `crypto.randomUUID()` is lowercase already, so the leaf needs none.
 */
export function meetingFileKeyPrefix(meetingId: string, userId: string): string {
  return `${MEETING_FILE_PREFIX}${meetingId.toLowerCase()}/${userId.toLowerCase()}/`;
}

/**
 * Keys are scoped to MEETING + uploader so the confirm action can verify provenance from the
 * gate result + the session alone, with no second DB read. Shape:
 * `meeting-files/{meetingId}/{userId}/{uuid}`.
 *
 * ⚠ MEETING-SCOPED, NOT ENGAGEMENT-SCOPED — matching the table's anchor. A discovery call and
 * its kickoff are DIFFERENT meetings on the same engagement, and their objects must not share
 * a prefix: the confirm-time `startsWith` provenance check is only as strong as the segment it
 * compares, and an engagement-scoped prefix would accept a key minted for a different call.
 *
 * The `meetingId` comes from the VALIDATED gate result and the `userId` from the session —
 * neither is ever client-supplied.
 */
export function generateMeetingFileKey(meetingId: string, userId: string): string {
  return `${meetingFileKeyPrefix(meetingId, userId)}${crypto.randomUUID()}`;
}

/**
 * The key's LEAF uuid — the only part of an `r2Key` that may be logged.
 *
 * ⚠ AN `r2Key` IS AN OBJECT LOCATOR AND A FULL ONE NEVER GOES TO A LOG, at any level. The
 * whole key spells out the meeting id and the uploader's user id in plain text, so a log
 * line carrying it hands an Axiom reader (or anything downstream of it) both identifiers plus
 * a directly usable storage path. `list-meeting-files.ts` already refuses to project `r2Key`
 * across the serialization boundary for the same reason; this module holds the same bar on
 * the logging boundary. The leaf is a fresh random uuid, so it correlates two log lines about
 * the same object and reveals nothing else.
 */
export function meetingFileKeyLeaf(key: string): string {
  // `lastIndexOf` + `slice`, not `split` — a linear scan with no array allocation and no
  // regex, so there is nothing here for SonarCloud S5852 to be unhappy about.
  return key.slice(key.lastIndexOf('/') + 1);
}

// ── Presigned PUT (server-only) ──
/**
 * Mint the upload credential. BOTH the content type AND the exact byte length are BOUND INTO
 * THE SIGNATURE — see the module docblock. R2 rejects a body that does not match either, so
 * the 10 MB cap is enforced at the edge rather than only at confirm.
 *
 * ⚠ THE SIZE GUARD IS RESTATED HERE EVEN THOUGH `requestMeetingFileUploadAction` ALREADY
 * CHECKS IT. Same posture as the content-type guard directly below it: this function mints a
 * credential, and a credential-minting function must not depend on its caller having
 * validated. The action's check exists to produce FRIENDLY COPY; this one exists so the
 * credential is never wrong. Neither is redundant.
 */
export async function createPresignedMeetingFileUpload(
  meetingId: string,
  userId: string,
  contentType: string,
  sizeBytes: number
): Promise<{ presignedUrl: string; key: string }> {
  if (!MEETING_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Invalid content type: ${contentType}`);
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_MEETING_FILE_BYTES) {
    throw new Error(`Invalid content length: ${sizeBytes}`);
  }

  const key = generateMeetingFileKey(meetingId, userId);
  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
    // ⚠ SIGNED, so a mismatched body is refused BY R2, at the edge.
    ContentLength: sizeBytes,
  });
  const presignedUrl = await getSignedUrl(r2Client, command, { expiresIn: UPLOAD_TTL_SECONDS });

  return { presignedUrl, key };
}

// ── Presigned GET (server-only) ──
/**
 * Short-lived download URL forcing an attachment disposition with the STORED file name.
 *
 * Quotes, backslashes and control characters are stripped from the name so a crafted upload
 * name cannot break out of the `Content-Disposition` header. The name being STORED (not
 * client-supplied at download time) is what makes this a one-time sanitisation rather than a
 * per-request trust decision. BIDI OVERRIDES are handled EARLIER — at WRITE time, by
 * `sanitizeMeetingFileName` — so the stored name is already display-safe; see that function.
 *
 * ⚠ NO `IfMatch` IS SENT, AND THAT IS THE STATED RESIDUAL, NOT AN OVERSIGHT. See the
 * confirm-time swap block in the module docblock: pinning the download to the exact object
 * verified at confirm needs a persisted `ETag`, i.e. a NEW `meeting_files` column, which this
 * PR deliberately does not add. The size and type halves of that window are already closed by
 * the signed `ContentLength` + `ContentType` on the PUT.
 */
export async function createPresignedMeetingFileDownload(
  key: string,
  fileName: string
): Promise<string> {
  // eslint-disable-next-line no-control-regex -- strip header-breaking control chars from the stored name
  const safeName = fileName.replaceAll(/["\\\u0000-\u001f]/g, '_');
  const command = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
  });
  return getSignedUrl(r2Client, command, { expiresIn: DOWNLOAD_TTL_SECONDS });
}

// ── R2 deletion (server-only, fire-and-forget) ──
/**
 * Best-effort object delete, PREFIX-GUARDED.
 *
 * ⚠ IT NEVER THROWS AND NEVER FAILS THE ROW OPERATION (D3). Retention is indefinite and
 * deletion is a `deleted_at` marker plus this object delete; if the object delete fails, the
 * row is still gone from every read and the object is orphaned. What makes that safe is the
 * NON-partial `meeting_file_key_idx`: a soft-deleted row's `r2_key` stays permanently
 * reserved, so a retry can never collide with the key of an object that may still exist.
 */
export async function deleteMeetingFileFromR2(key: string): Promise<void> {
  // Prefix guard — refuse to delete anything outside the meeting-files space.
  if (!key.startsWith(MEETING_FILE_PREFIX)) return;

  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (error) {
    // ⚠ THE LEAF, NEVER THE FULL KEY — see `meetingFileKeyLeaf`. The full key spells out the
    // meeting id and the uploader's user id.
    log.warn('Failed to delete meeting file from R2', {
      fileKeyLeaf: meetingFileKeyLeaf(key),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
