import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const OTHER_USER_ID = 'e0000000-0000-4000-8000-000000000006';
const LEAF = 'f0000000-0000-4000-8000-000000000006';
const KEY = `request-files/${REQUEST_ID}/${USER_ID}/${LEAF}`;

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
}));

const mockIsClaimed = vi.fn();
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: { isR2KeyClaimed: (...args: unknown[]) => mockIsClaimed(...args) },
}));

const mockDelete = vi.fn();
vi.mock('@/lib/storage/request-file', () => ({
  REQUEST_FILE_PREFIX: 'request-files/',
  deleteRequestFileFromR2: (...args: unknown[]) => mockDelete(...args),
}));

const { mockWarn, mockError } = vi.hoisted(() => ({ mockWarn: vi.fn(), mockError: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: mockWarn, error: mockError },
}));

import { discardRequestFileUploadAction } from './discard-request-file-upload';

const USER = { id: USER_ID };
const CLIENT_SCOPE = { ok: true, side: 'client', request: { id: REQUEST_ID } };

describe('discardRequestFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockIsClaimed.mockResolvedValue(false);
    mockDelete.mockResolvedValue(undefined);
  });

  it('deletes the caller’s own unclaimed upload', async () => {
    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledWith(KEY);
  });

  it('also serves the expert arm', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: true, side: 'expert', request: { id: REQUEST_ID } });

    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: true });
  });

  it('refuses a key another user uploaded, and never deletes it', async () => {
    const result = await discardRequestFileUploadAction({
      requestId: REQUEST_ID,
      key: `request-files/${REQUEST_ID}/${OTHER_USER_ID}/${LEAF}`,
    });

    expect(result).toEqual({ success: false });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockIsClaimed).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('refuses a key minted for another request', async () => {
    const result = await discardRequestFileUploadAction({
      requestId: REQUEST_ID,
      key: `request-files/a0000000-0000-4000-8000-0000000000ff/${USER_ID}/${LEAF}`,
    });

    expect(result).toEqual({ success: false });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  /** ⚠ A confirmed file's bytes must never be removed by a discard. */
  it('refuses a key a file already claims, and never deletes it', async () => {
    mockIsClaimed.mockResolvedValue(true);

    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: false });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('refuses the read-only admin lens', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: true, side: 'admin', request: { id: REQUEST_ID } });

    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: false });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('refuses a caller the scope gate denied', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: false, code: 'request_files_not_found' });

    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: false });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('resolves { success: false } when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));

    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: false });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('resolves { success: false } on structurally invalid input', async () => {
    const result = await discardRequestFileUploadAction({ requestId: 'nope', key: KEY });

    expect(result).toEqual({ success: false });
    expect(mockAuthorizeScope).not.toHaveBeenCalled();
  });

  it('never throws: an R2 failure resolves { success: false } and is logged', async () => {
    mockDelete.mockRejectedValue(new Error('r2 down'));

    const result = await discardRequestFileUploadAction({ requestId: REQUEST_ID, key: KEY });

    expect(result).toEqual({ success: false });
    expect(mockError).toHaveBeenCalledWith(
      'Failed to discard request file upload',
      expect.objectContaining({ requestId: REQUEST_ID, error: 'r2 down' })
    );
  });
});
