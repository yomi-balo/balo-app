import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const DOCUMENT_ID = 'd0000000-0000-4000-8000-000000000007';

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
}));

const mockFindDocumentInRequest = vi.fn();
vi.mock('@balo/db', () => ({
  projectRequestsRepository: {
    findDocumentInRequest: (...args: unknown[]) => mockFindDocumentInRequest(...args),
  },
}));

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/project-document', () => ({
  createPresignedProjectDocumentDownload: (...args: unknown[]) => mockPresignDownload(...args),
}));

const mockLogError = vi.fn();
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: (...args: unknown[]) => mockLogError(...args) },
}));

import { getRequestDocumentDownloadAction } from './get-request-document-download';

const USER = { id: USER_ID };
const VALID_INPUT = { requestId: REQUEST_ID, documentId: DOCUMENT_ID };
const DOCUMENT = { id: DOCUMENT_ID, r2Key: 'project-documents/c/u/k', fileName: 'brief.pdf' };
const GONE = { success: false, error: 'This document is no longer available.' };

describe('getRequestDocumentDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockFindDocumentInRequest.mockResolvedValue(DOCUMENT);
    mockPresignDownload.mockResolvedValue('https://signed-download');
  });

  it('denies when not signed in, before touching the gate', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));

    const result = await getRequestDocumentDownloadAction(VALID_INPUT);

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorizeScope).not.toHaveBeenCalled();
  });

  it('rejects a malformed id', async () => {
    const result = await getRequestDocumentDownloadAction({
      requestId: REQUEST_ID,
      documentId: 'not-a-uuid',
    });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAuthorizeScope).not.toHaveBeenCalled();
  });

  it.each([
    ['admin', { ok: true, side: 'admin', request: { id: REQUEST_ID }, tracks: [] }],
    [
      'client',
      { ok: true, side: 'client', request: { id: REQUEST_ID }, companyId: 'co', tracks: [] },
    ],
    ['expert', { ok: true, side: 'expert', request: { id: REQUEST_ID }, viewer: {} }],
  ])('presigns the document for an authorized %s reader', async (_side, scope) => {
    mockAuthorizeScope.mockResolvedValue(scope);

    const result = await getRequestDocumentDownloadAction(VALID_INPUT);

    expect(result).toEqual({ success: true, url: 'https://signed-download' });
    expect(mockAuthorizeScope).toHaveBeenCalledWith(USER, REQUEST_ID);
    expect(mockFindDocumentInRequest).toHaveBeenCalledWith(DOCUMENT_ID, REQUEST_ID);
    expect(mockPresignDownload).toHaveBeenCalledWith('project-documents/c/u/k', 'brief.pdf');
  });

  it('answers the not-available copy when the gate denies, without reading the document', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: false, code: 'request_files_not_found' });

    const result = await getRequestDocumentDownloadAction(VALID_INPUT);

    expect(result).toEqual(GONE);
    expect(mockFindDocumentInRequest).not.toHaveBeenCalled();
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('answers the same copy for a document not on this request (or soft-deleted)', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: { id: REQUEST_ID },
      tracks: [],
    });
    mockFindDocumentInRequest.mockResolvedValue(undefined);

    const result = await getRequestDocumentDownloadAction(VALID_INPUT);

    expect(result).toEqual(GONE);
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('logs and returns a retry message when presigning throws', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: { id: REQUEST_ID },
      tracks: [],
    });
    mockPresignDownload.mockRejectedValue(new Error('r2 down'));

    const result = await getRequestDocumentDownloadAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      error: 'Could not open this document. Please try again.',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to presign request document download',
      expect.objectContaining({ requestId: REQUEST_ID, documentId: DOCUMENT_ID, error: 'r2 down' })
    );
  });
});
