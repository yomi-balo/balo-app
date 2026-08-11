import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const CONVERSATION_ID = 'd0000000-0000-4000-8000-000000000004';
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
  // BAL-424: this action is on `READ_ONLY_ALLOWLIST`, so it must use the READ-ONLY
  // sibling (findByContext) — never `resolveConversationAccess`, which get-or-CREATES.
  readConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
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
    mockResolveAccess.mockResolvedValue({ ok: true, conversationId: CONVERSATION_ID });
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

  /**
   * BAL-424 — no conversation ⇒ no files ⇒ the claimed fileId cannot belong to this thread.
   * Same copy as a foreign or soft-deleted id, so probing still learns nothing; and no
   * thread is provisioned on the way past (this action must stay read-only).
   */
  it('reports the file unavailable when no conversation exists yet, without provisioning one', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, conversationId: undefined });
    const result = await getConversationFileDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
    expect(mockListFiles).not.toHaveBeenCalled();
  });
});
