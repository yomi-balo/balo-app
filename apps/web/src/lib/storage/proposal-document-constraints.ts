/**
 * Proposal-document constraints (A6.2 / BAL-288). CLIENT-SAFE on purpose
 * (no `server-only`, no AWS imports) so the composer's uploader can pre-validate
 * before any network call. The server confirm action re-checks from the R2
 * object — this is UX, the server is the source of truth.
 *
 * Same content-type allow-list and 10 MB cap as conversation files (the design's
 * proposal attachments share the same document set: PDFs, images, Office docs,
 * CSV, plain text). Used for BOTH general `ref` attachments and the optional
 * `terms` supplement.
 */
export const PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES = new Set<string>([
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

export const MAX_PROPOSAL_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Accept attribute for the proposal uploader's hidden file input. */
export const PROPOSAL_DOCUMENT_ACCEPT =
  '.pdf,image/png,image/jpeg,image/webp,.docx,.xlsx,.pptx,.csv,.txt';
