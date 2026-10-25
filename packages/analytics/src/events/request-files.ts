/**
 * BAL-431 / ADR-1048 — request-stage shared-file events. THE THREE `REQUEST_FILE_SERVER_EVENTS` ARE SERVER EVENTS —
 * `uploader_side`, `viewer_side` and `via_all_audience` are all GATE-RESOLVED FACTS, and
 * emitting them client-side would let the browser assert its own side, the exact hole the
 * `meeting_files.party` rule closes.
 *
 * `REQUEST_FILE_EVENTS` (BAL-617) is the CLIENT namespace: the share dialog and the in-app
 * preview are pure UI moments with no gate-resolved fact in their properties, so the browser
 * emits them. `lens` is the viewer's own lens and `entry_point` / `surface` are UI positions;
 * none of them is an authorization input.
 *
 * A NEW FAMILY FILE, not an extension of an existing one — every family's exact-key-set guard
 * (`request-files.test.ts`) actively prevents folding new events into an existing one.
 */

export const REQUEST_FILE_AUDIENCE_TYPES = ['all_live_tracks', 'grants', 'own_track'] as const;
export type RequestFileAudienceProp = (typeof REQUEST_FILE_AUDIENCE_TYPES)[number];

export const REQUEST_FILE_SIDES = ['client', 'expert'] as const;
export type RequestFileSideProp = (typeof REQUEST_FILE_SIDES)[number];

export const REQUEST_FILE_AUDIENCE_ACTIONS = ['grant', 'revoke'] as const;
export type RequestFileAudienceActionProp = (typeof REQUEST_FILE_AUDIENCE_ACTIONS)[number];

export const REQUEST_FILE_VIEWER_SIDES = ['client', 'expert', 'admin'] as const;
export type RequestFileViewerSideProp = (typeof REQUEST_FILE_VIEWER_SIDES)[number];

export const REQUEST_FILE_SHARE_ENTRY_POINTS = ['composer', 'drop', 'all_files'] as const;
export type RequestFileShareEntryPointProp = (typeof REQUEST_FILE_SHARE_ENTRY_POINTS)[number];

export const REQUEST_FILE_SHARE_AUDIENCE_CHOICES = [
  'this_thread',
  'all_live_tracks',
  'specific',
] as const;
export type RequestFileShareAudienceChoiceProp =
  (typeof REQUEST_FILE_SHARE_AUDIENCE_CHOICES)[number];

export const REQUEST_FILE_PREVIEW_KINDS = ['image', 'pdf'] as const;
export type RequestFilePreviewKindProp = (typeof REQUEST_FILE_PREVIEW_KINDS)[number];

export const REQUEST_FILE_PREVIEW_SURFACES = ['thread_card', 'files_card', 'files_sheet'] as const;
export type RequestFilePreviewSurfaceProp = (typeof REQUEST_FILE_PREVIEW_SURFACES)[number];

/** Why a URL was minted: a real download, or an in-app preview (image or PDF). */
export const REQUEST_FILE_DOWNLOAD_PURPOSES = ['download', 'preview'] as const;
export type RequestFileDownloadPurposeProp = (typeof REQUEST_FILE_DOWNLOAD_PURPOSES)[number];

export const REQUEST_FILE_EVENTS = {
  /** The share dialog opened. */
  SHARE_DIALOG_OPENED: 'request_file_share_dialog_opened',
  /** The share dialog was cancelled or closed without sharing. */
  SHARE_DIALOG_CANCELLED: 'request_file_share_dialog_cancelled',
  /** An image or PDF preview opened in-app. */
  PREVIEWED: 'request_file_previewed',
} as const;

export interface RequestFileEventMap {
  [REQUEST_FILE_EVENTS.SHARE_DIALOG_OPENED]: {
    entry_point: RequestFileShareEntryPointProp;
  };
  [REQUEST_FILE_EVENTS.SHARE_DIALOG_CANCELLED]: {
    entry_point: RequestFileShareEntryPointProp;
    /** The upload had finished when the dialog was dismissed. */
    upload_complete: boolean;
  };
  [REQUEST_FILE_EVENTS.PREVIEWED]: {
    kind: RequestFilePreviewKindProp;
    surface: RequestFilePreviewSurfaceProp;
    lens: RequestFileViewerSideProp;
  };
}

export const REQUEST_FILE_SERVER_EVENTS = {
  /** A file was shared/uploaded (either side). Published from `confirm-request-file-upload.ts`. */
  UPLOADED: 'request_file_uploaded',
  /**
   * A file's audience changed by an explicit lever — grant or revoke. ⚠ Delete is NOT this
   * event (no `via_all_audience` concept applies to a tombstone) — see `DOWNLOADED`'s sibling
   * discussion; delete is deliberately unmeasured in v1 (Ruling 4 names four AUDIT actions,
   * not four analytics events).
   */
  AUDIENCE_CHANGED: 'request_file_audience_changed',
  /**
   * A presigned URL was minted, for a download or an in-app preview (`purpose`). Published from
   * `get-request-file-download.ts`.
   */
  DOWNLOADED: 'request_file_downloaded',
} as const;

export interface RequestFileServerEventMap {
  [REQUEST_FILE_SERVER_EVENTS.UPLOADED]: {
    /** Gate-resolved — never trust a client-asserted side. */
    uploader_side: RequestFileSideProp;
    audience_type: RequestFileAudienceProp;
    /** The resolved live/granted set size at share time; 1 for `own_track`. */
    track_count: number;
    /** Where the share started. Analytics-only; never an authorization input. */
    entry_point: RequestFileShareEntryPointProp;
    /** What the sharer chose in the dialog (always `this_thread` on the expert side). */
    audience_choice: RequestFileShareAudienceChoiceProp;
    /** A note travelled with the file. The note text is never a property. */
    has_note: boolean;
    distinct_id: string;
  };
  [REQUEST_FILE_SERVER_EVENTS.AUDIENCE_CHANGED]: {
    action: RequestFileAudienceActionProp;
    audience_type: RequestFileAudienceProp;
    distinct_id: string;
  };
  [REQUEST_FILE_SERVER_EVENTS.DOWNLOADED]: {
    viewer_side: RequestFileViewerSideProp;
    via_all_audience: boolean;
    purpose: RequestFileDownloadPurposeProp;
    distinct_id: string;
  };
}
