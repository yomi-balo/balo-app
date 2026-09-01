import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000009';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
}));

const mockFindByIdInRequest = vi.fn();
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: {
    findByIdInRequest: (...args: unknown[]) => mockFindByIdInRequest(...args),
  },
}));

const mockToSerializerFile = vi.fn((row: unknown) => row);
vi.mock('@/lib/request-files/load-request-files', () => ({
  toSerializerFile: (row: unknown) => mockToSerializerFile(row),
}));

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/request-file', () => ({
  createPresignedRequestFileDownload: (...args: unknown[]) => mockPresignDownload(...args),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrack(...args),
  REQUEST_FILE_SERVER_EVENTS: { DOWNLOADED: 'request_file_downloaded' },
}));

import { getRequestFileDownloadAction } from './get-request-file-download';

const USER = { id: USER_ID };
const VALID_INPUT = { requestId: REQUEST_ID, fileId: FILE_ID };

const LIVE_FILE = {
  file: {
    id: FILE_ID,
    r2Key: 'request-files/a/b/c',
    fileName: 'file.pdf',
    side: 'client',
    audience: 'all_live_tracks',
    expertRelationshipId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    deletedAt: null,
  },
  grants: [],
};

describe('getRequestFileDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockPresignDownload.mockResolvedValue('https://signed-download');
  });

  it('denies when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));
    const result = await getRequestFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('resolves "This file is no longer available." for a file on another request', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockFindByIdInRequest.mockResolvedValue(undefined);
    const result = await getRequestFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
  });

  it('downloads for a client viewer without an audience check', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockFindByIdInRequest.mockResolvedValue(LIVE_FILE);
    const result = await getRequestFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, url: 'https://signed-download' });
    expect(mockTrack).toHaveBeenCalledWith(
      'request_file_downloaded',
      expect.objectContaining({ viewer_side: 'client' })
    );
  });

  it('denies an expert whose track cannot see the file (cross-track false)', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: {
        relationshipId: OTHER_REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        access: { kind: 'live' },
      },
    });
    mockFindByIdInRequest.mockResolvedValue({
      file: { ...LIVE_FILE.file, side: 'client', audience: 'grants' },
      grants: [{ relationshipId: REL_ID }],
    });
    const result = await getRequestFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('allows a granted expert and records via_all_audience=false for a grants share', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        access: { kind: 'live' },
      },
    });
    mockFindByIdInRequest.mockResolvedValue({
      file: { ...LIVE_FILE.file, side: 'client', audience: 'grants' },
      grants: [{ relationshipId: REL_ID }],
    });
    const result = await getRequestFileDownloadAction(VALID_INPUT);
    expect(result.success).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith(
      'request_file_downloaded',
      expect.objectContaining({ viewer_side: 'expert', via_all_audience: false })
    );
  });

  it('allows the admin lens to read a tombstoned file', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: { id: REQUEST_ID },
      tracks: [],
    });
    mockFindByIdInRequest.mockResolvedValue({
      file: { ...LIVE_FILE.file, deletedAt: new Date() },
      grants: [],
    });
    const result = await getRequestFileDownloadAction(VALID_INPUT);
    expect(result.success).toBe(true);
    expect(mockFindByIdInRequest).toHaveBeenCalledWith(FILE_ID, REQUEST_ID, {
      includeDeleted: true,
    });
  });
});
