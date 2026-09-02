/**
 * BAL-431 / ADR-1048 — request-stage shared-file events. ALL THREE ARE SERVER EVENTS —
 * `uploader_side`, `viewer_side` and `via_all_audience` are all GATE-RESOLVED FACTS, and
 * emitting them client-side would let the browser assert its own side, the exact hole the
 * `meeting_files.party` rule closes.
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
  /** A presigned download URL was minted. Published from `get-request-file-download.ts`. */
  DOWNLOADED: 'request_file_downloaded',
} as const;

export interface RequestFileServerEventMap {
  [REQUEST_FILE_SERVER_EVENTS.UPLOADED]: {
    /** Gate-resolved — never trust a client-asserted side. */
    uploader_side: RequestFileSideProp;
    audience_type: RequestFileAudienceProp;
    /** The resolved live/granted set size at share time; 1 for `own_track`. */
    track_count: number;
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
    distinct_id: string;
  };
}
