/**
 * Conversation-file constraints (BAL-271 / A4 — D5). CLIENT-SAFE on purpose
 * (no `server-only`, no AWS imports) so the composer can pre-validate before
 * any network call. The server confirm action re-checks from the R2 object —
 * this is UX, the server is the source of truth.
 *
 * Wider than project documents (the design's worked example shares
 * .docx/.xlsx): adds Office docs, CSV and plain text; 10 MB cap.
 */
export const CONVERSATION_ALLOWED_CONTENT_TYPES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
]);

export const MAX_CONVERSATION_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Accept attribute for the composer's hidden file input. */
export const CONVERSATION_FILE_ACCEPT =
  '.pdf,image/png,image/jpeg,image/webp,.docx,.xlsx,.pptx,.csv,.txt';

/**
 * The types the in-app viewer renders in an `<img>`.
 *
 * ⚠ No `application/pdf`. An `<img>` ignores `Content-Disposition`, so these render from the
 * existing `attachment` presign with no new exposure — the presigned PUT does not sign
 * `content-type`, so the stored type is uploader-chosen, and HTML bytes in an `<img>` simply
 * fail to decode. A PDF would need the header flipped to `inline`, which makes that same
 * uploader-chosen type a rendering decision.
 *
 * ⚠ Never add `image/svg+xml`: it is a scriptable document, and it is absent from
 * {@link CONVERSATION_ALLOWED_CONTENT_TYPES} for the same reason.
 */
export const CONVERSATION_VIEWABLE_IMAGE_CONTENT_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** Can the in-app viewer display this file, or must the click fall through to a download? */
export function isConversationViewableImage(contentType: string): boolean {
  return CONVERSATION_VIEWABLE_IMAGE_CONTENT_TYPES.has(contentType);
}
