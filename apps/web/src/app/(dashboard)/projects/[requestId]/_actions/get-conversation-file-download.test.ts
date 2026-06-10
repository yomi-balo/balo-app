import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';

vi.mock('server-only', () => ({}));

const mockListFiles = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    listFiles: (...args: unknown[]) => mockListFiles(...args),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/conversation-file', () => ({
  createPresignedConversationFileDownload: (...args: unknown[]) => mockPresignDownload(...args),
}));

import { getConversationFileDownloadAction } from './get-conversation-file-download';
import { log } from '@/lib/logging';

const USER = { id: 'user-client' };
const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID, fileId: FILE_ID };

describe('getConversationFileDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true });
    mockListFiles.mockResolvedValue([
      { id: FILE_ID, r2Key: 'conversation-files/x/y/z', fileName: 'scope.pdf' },
    ]);
    mockPresignDownload.mockResolvedValue('https://signed.example/get');
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await getConversationFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    const result = await getConversationFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'No access.' });
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it('rejects a fileId that does not belong to this relationship', async () => {
    mockListFiles.mockResolvedValue([
      { id: 'other-file', r2Key: 'conversation-files/x/y/q', fileName: 'other.pdf' },
    ]);
    const result = await getConversationFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('presigns the stored key with the stored file name', async () => {
    const result = await getConversationFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, url: 'https://signed.example/get' });
    expect(mockPresignDownload).toHaveBeenCalledWith('conversation-files/x/y/z', 'scope.pdf');
  });

  it('maps failures to a friendly error and logs', async () => {
    mockPresignDownload.mockRejectedValue(new Error('boom'));
    const result = await getConversationFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not download this file. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign conversation file download',
      expect.any(Object)
    );
  });
});
