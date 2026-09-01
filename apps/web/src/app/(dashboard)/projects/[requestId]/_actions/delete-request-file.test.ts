import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000009';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
  REQUEST_FILES_UNAVAILABLE_COPY: 'These files are no longer available.',
}));

const mockFindByIdInRequest = vi.fn();
const mockSoftDelete = vi.fn();
// ⚠ `vi.hoisted` — see confirm-request-file-upload.test.ts's comment: a `class` referenced
// inside a `vi.mock` factory hits the TDZ, since only `const mockXxx` patterns are relocated.
const { MockFileNotFoundError, MockAlreadyDeletedError } = vi.hoisted(() => {
  class MockFileNotFoundErrorImpl extends Error {}
  class MockAlreadyDeletedErrorImpl extends Error {}
  return {
    MockFileNotFoundError: MockFileNotFoundErrorImpl,
    MockAlreadyDeletedError: MockAlreadyDeletedErrorImpl,
  };
});
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: {
    findByIdInRequest: (...args: unknown[]) => mockFindByIdInRequest(...args),
    softDelete: (...args: unknown[]) => mockSoftDelete(...args),
  },
  RequestFileNotFoundError: MockFileNotFoundError,
  RequestFileAlreadyDeletedError: MockAlreadyDeletedError,
}));

const mockDeleteFromR2 = vi.fn<(key: string) => Promise<void>>();
mockDeleteFromR2.mockReturnValue(Promise.resolve());
vi.mock('@/lib/storage/request-file', () => ({
  deleteRequestFileFromR2: (key: string) => mockDeleteFromR2(key),
}));

import { deleteRequestFileAction } from './delete-request-file';

const USER = { id: USER_ID };
const VALID_INPUT = { requestId: REQUEST_ID, fileId: FILE_ID };

const CLIENT_FILE = {
  file: { id: FILE_ID, side: 'client', expertRelationshipId: null },
  grants: [],
};
const EXPERT_FILE = {
  file: { id: FILE_ID, side: 'expert', expertRelationshipId: REL_ID },
  grants: [],
};

describe('deleteRequestFileAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockSoftDelete.mockResolvedValue({
      file: { id: FILE_ID },
      r2Key: 'request-files/a/b/c',
      resolvedAudience: [],
    });
  });

  it('denies when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('denies the admin lens (read-only)', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: { id: REQUEST_ID },
      tracks: [],
    });
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'These files are no longer available.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('lets a client delete a client-uploaded file (party-level, Ruling 3)', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockFindByIdInRequest.mockResolvedValue(CLIENT_FILE);
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: true });
    expect(mockSoftDelete).toHaveBeenCalledWith({
      fileId: FILE_ID,
      projectRequestId: REQUEST_ID,
      actorUserId: USER_ID,
    });
    expect(mockDeleteFromR2).toHaveBeenCalledWith('request-files/a/b/c');
  });

  it('denies a client trying to delete an expert-side file', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockFindByIdInRequest.mockResolvedValue(EXPERT_FILE);
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('lets a live expert delete their own file', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: { relationshipId: REL_ID, expertProfileId: 'ep', access: { kind: 'live' } },
    });
    mockFindByIdInRequest.mockResolvedValue(EXPERT_FILE);
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: true });
  });

  it('denies a CLOSED expert from deleting their own file (delete right ≡ upload right)', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: 'ep',
        access: { kind: 'closed', closedAt: new Date() },
      },
    });
    mockFindByIdInRequest.mockResolvedValue(EXPERT_FILE);
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('denies an expert deleting a SIBLING track file (cross-track false)', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: { relationshipId: OTHER_REL_ID, expertProfileId: 'ep', access: { kind: 'live' } },
    });
    mockFindByIdInRequest.mockResolvedValue(EXPERT_FILE);
    const result = await deleteRequestFileAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('the R2 delete runs AFTER the transaction commits, and its failure never fails the action', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockFindByIdInRequest.mockResolvedValue(CLIENT_FILE);
    mockDeleteFromR2.mockImplementationOnce(() => Promise.reject(new Error('R2 down')));
    const result = await deleteRequestFileAction(VALID_INPUT);
    // The catch-and-log is attached to the promise; awaiting the action must not surface it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result).toEqual({ success: true });
  });
});
