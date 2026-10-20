import type { RequestFileViewerSideProp } from './request-files';

/**
 * The request brief's attached documents (`project_request_documents`) — a separate family
 * from `REQUEST_FILE_SERVER_EVENTS`, whose exact-key-set guard keeps the shared-file plane's
 * vocabulary closed. SERVER-ONLY: `viewer_side` is a gate-resolved fact, the same discipline
 * as `request_file_downloaded`, so the two download paths can be compared side by side.
 */
export const REQUEST_DOCUMENT_SERVER_EVENTS = {
  /** A presigned download URL was minted. Published from `get-request-document-download.ts`. */
  DOWNLOADED: 'request_document_downloaded',
} as const;

export interface RequestDocumentServerEventMap {
  [REQUEST_DOCUMENT_SERVER_EVENTS.DOWNLOADED]: {
    viewer_side: RequestFileViewerSideProp;
    distinct_id: string;
  };
}
