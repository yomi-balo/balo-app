import { describe, it, expect } from 'vitest';
import {
  REQUEST_FILE_SERVER_EVENTS,
  REQUEST_FILE_AUDIENCE_TYPES,
  REQUEST_FILE_SIDES,
  REQUEST_FILE_AUDIENCE_ACTIONS,
  REQUEST_FILE_VIEWER_SIDES,
  REQUEST_FILE_EVENTS,
  REQUEST_FILE_SHARE_ENTRY_POINTS,
  REQUEST_FILE_SHARE_AUDIENCE_CHOICES,
  REQUEST_FILE_PREVIEW_KINDS,
  REQUEST_FILE_PREVIEW_SURFACES,
  REQUEST_FILE_DOWNLOAD_PURPOSES,
} from './request-files';

describe('REQUEST_FILE_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(REQUEST_FILE_SERVER_EVENTS)).toEqual([
      'UPLOADED',
      'AUDIENCE_CHANGED',
      'DOWNLOADED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(REQUEST_FILE_SERVER_EVENTS.UPLOADED).toBe('request_file_uploaded');
    expect(REQUEST_FILE_SERVER_EVENTS.AUDIENCE_CHANGED).toBe('request_file_audience_changed');
    expect(REQUEST_FILE_SERVER_EVENTS.DOWNLOADED).toBe('request_file_downloaded');
  });

  it('every value carries the request_file_ prefix and snake_case shape', () => {
    for (const value of Object.values(REQUEST_FILE_SERVER_EVENTS)) {
      expect(value).toMatch(/^request_file_[a-z]+(_[a-z]+)*$/);
    }
  });
});

describe('REQUEST_FILE_AUDIENCE_TYPES', () => {
  it('is order-pinned', () => {
    expect(REQUEST_FILE_AUDIENCE_TYPES).toEqual(['all_live_tracks', 'grants', 'own_track']);
  });
});

describe('REQUEST_FILE_SIDES', () => {
  it('is order-pinned', () => {
    expect(REQUEST_FILE_SIDES).toEqual(['client', 'expert']);
  });
});

describe('REQUEST_FILE_AUDIENCE_ACTIONS', () => {
  it('is order-pinned', () => {
    expect(REQUEST_FILE_AUDIENCE_ACTIONS).toEqual(['grant', 'revoke']);
  });
});

describe('REQUEST_FILE_VIEWER_SIDES', () => {
  it('is order-pinned', () => {
    expect(REQUEST_FILE_VIEWER_SIDES).toEqual(['client', 'expert', 'admin']);
  });
});

describe('REQUEST_FILE_EVENTS', () => {
  it('has exactly the expected keys and event names', () => {
    expect(REQUEST_FILE_EVENTS).toEqual({
      SHARE_DIALOG_OPENED: 'request_file_share_dialog_opened',
      SHARE_DIALOG_CANCELLED: 'request_file_share_dialog_cancelled',
      PREVIEWED: 'request_file_previewed',
    });
  });

  it('shares no event name with the server family', () => {
    const server = new Set<string>(Object.values(REQUEST_FILE_SERVER_EVENTS));
    for (const value of Object.values(REQUEST_FILE_EVENTS)) {
      expect(server.has(value)).toBe(false);
    }
  });

  it('pins the vocabulary tuples in order', () => {
    expect(REQUEST_FILE_SHARE_ENTRY_POINTS).toEqual(['composer', 'drop', 'all_files']);
    expect(REQUEST_FILE_SHARE_AUDIENCE_CHOICES).toEqual([
      'this_thread',
      'all_live_tracks',
      'specific',
    ]);
    expect(REQUEST_FILE_PREVIEW_KINDS).toEqual(['image', 'pdf']);
    expect(REQUEST_FILE_PREVIEW_SURFACES).toEqual(['thread_card', 'files_card', 'files_sheet']);
    expect(REQUEST_FILE_DOWNLOAD_PURPOSES).toEqual(['download', 'preview']);
  });
});
