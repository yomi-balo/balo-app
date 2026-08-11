import type { MeetingFileParty, MeetingFileSource } from '@balo/db';

/**
 * Meeting-file view-model TYPES (BAL-423). PLAIN TYPES ONLY — no values, no functions, no
 * constants.
 *
 * ⚠⚠ THIS MODULE EXISTS BECAUSE OF THE `'use server'` VALUE-EXPORT HAZARD. A `'use server'`
 * module may export ONLY async functions. An `export const` — or any exported non-async value
 * — fails `next build` with a runtime-shaped error, while `tsc`, ESLint AND vitest all pass:
 * there is no local gate that catches it. So the shapes the four meeting-file Server Actions
 * return are declared HERE and imported back with `export type`, which is ERASED at compile
 * and therefore emits nothing into the action modules at all.
 *
 * ⚠ CLIENT-SAFE. The `@balo/db` import above is `import type` — erased, never a value import
 * — so BAL-132's in-call island can render these without dragging `postgres` into the browser
 * bundle (memory `reference_balo_db_client_bundle_footgun`: a client component that
 * VALUE-imports `@balo/db` breaks `next build` with "can't resolve 'tls'"). Keep it that way:
 * do not add a runtime import, a helper function or a constant to this file.
 */

/**
 * One meeting file, as a surface renders it.
 *
 * ⚠ `r2Key` IS DELIBERATELY ABSENT. It is an object locator, and this shape crosses the
 * server→client serialization boundary. Downloads go through
 * `getMeetingFileDownloadAction`, which resolves the stored key server-side and returns a
 * short-lived presigned GET — the client never holds the key.
 */
export interface MeetingFileView {
  id: string;
  meetingId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /**
   * ⚠ THE GATE'S RESOLVED SIDE as persisted, never a caller claim. BAL-388's lens-aware
   * rendering keys on this.
   */
  party: MeetingFileParty;
  /** Which in-call entry point produced it (D0) — `chat` or `files_tab`. */
  source: MeetingFileSource;
  uploadedByUserId: string;
  createdAtIso: string;
}
