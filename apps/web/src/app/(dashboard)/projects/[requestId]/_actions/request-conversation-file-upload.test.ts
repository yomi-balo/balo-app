import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';

vi.mock('server-only', () => ({}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockCreatePresigned = vi.fn();
vi.mock('@/lib/storage/conversation-file', () => ({
  CONVERSATION_ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'text/csv']),
  createPresignedConversationFileUpload: (...args: unknown[]) => mockCreatePresigned(...args),
}));

import { requestConversationFileUploadAction } from './request-conversation-file-upload';
import { log } from '@/lib/logging';

const USER = { id: 'user-client' };
const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  contentType: 'application/pdf',
  fileName: 'scope.pdf',
};

describe('requestConversationFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true });
    mockCreatePresigned.mockResolvedValue({
      presignedUrl: 'https://signed.example/put',
      key: `conversation-files/${REL_ID}/${USER.id}/abc`,
    });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await requestConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects invalid input', async () => {
    const result = await requestConversationFileUploadAction({ ...VALID_INPUT, fileName: '' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    const result = await requestConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'No access.' });
    expect(mockCreatePresigned).not.toHaveBeenCalled();
  });

  it('rejects a content type outside the allow-list', async () => {
    const result = await requestConversationFileUploadAction({
      ...VALID_INPUT,
      contentType: 'application/x-msdownload',
    });
    expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
    expect(mockCreatePresigned).not.toHaveBeenCalled();
  });

  it('presigns scoped to the validated relationship + session user', async () => {
    const result = await requestConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      presignedUrl: 'https://signed.example/put',
      key: `conversation-files/${REL_ID}/${USER.id}/abc`,
    });
    expect(mockCreatePresigned).toHaveBeenCalledWith(REL_ID, USER.id, 'application/pdf');
  });

  it('maps presign failures (e.g. R2 unconfigured) to a friendly error', async () => {
    mockCreatePresigned.mockRejectedValue(new Error('R2 not configured'));
    const result = await requestConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: "File sharing isn't available right now." });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign conversation file upload',
      expect.any(Object)
    );
  });
});
