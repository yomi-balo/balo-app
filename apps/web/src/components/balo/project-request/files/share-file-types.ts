/**
 * Types shared by the share dialog, the share hook and their callers. Type-only on purpose so any
 * of them can import it without pulling in a component or a server action.
 */

export interface ShareFileTrack {
  relationshipId: string;
  trackName: string;
}

/**
 * Who the file is going to, as the viewer's side sees it. A client picks among live experts; an
 * expert has exactly one recipient, the client party. Carried as data so the dialog never has to
 * ask which lens it is rendering.
 */
export type ShareRecipients =
  | { side: 'client'; liveTracks: ShareFileTrack[] }
  | { side: 'expert'; clientPartyName: string };

/** The audience half of `confirmRequestFileUploadAction`'s input. */
export type ShareSelection =
  | { mode: 'all_live_tracks' }
  | { mode: 'grants'; relationshipIds: string[] };

export type ShareAudienceChoice = 'this_thread' | 'all_live_tracks' | 'specific';

export type ShareEntryPoint = 'composer' | 'drop' | 'all_files';

/** What the dialog hands back when Share is pressed. */
export interface ShareSubmission {
  share: ShareSelection;
  /** Analytics only — never an authorization input. */
  audienceChoice: ShareAudienceChoice;
  note: string;
}

export interface ShareUploadState {
  fileName: string;
  sizeBytes: number;
  /** 0–100. */
  progress: number;
  status: 'uploading' | 'uploaded' | 'failed';
}

export type ShareFileMode =
  | { kind: 'thread'; threadRelationshipId: string; options: 'none' | 'thread' }
  | { kind: 'all_files' };
