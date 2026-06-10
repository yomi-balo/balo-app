import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const FILE_UUID = 'f0000000-0000-4000-8000-000000000006';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const KEY = `conversation-files/${REL_ID}/${USER_ID}/${FILE_UUID}`;
const CREATED_AT = new Date('2026-06-10T10:00:00Z');

vi.mock('server-only', () => ({}));

const mockAddFile = vi.fn();
const mockMarkThreadRead = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    addFile: (...args: unknown[]) => mockAddFile(...args),
    markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
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

const mockPublishConversation = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  publishConversationEvent: (...args: unknown[]) => mockPublishConversation(...args),
}));

const mockPublishNotification = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublishNotification(...args),
}));

const mockSend = vi.fn();
vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));

vi.mock('@aws-sdk/client-s3', () => ({
  HeadObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

const mockDelete = vi.fn();
vi.mock('@/lib/storage/conversation-file', () => ({
  CONVERSATION_ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'text/csv']),
  CONVERSATION_FILE_PREFIX: 'conversation-files/',
  MAX_CONVERSATION_FILE_BYTES: 10 * 1024 * 1024,
  deleteConversationFileFromR2: (...args: unknown[]) => {
    mockDelete(...args);
    return Promise.resolve();
  },
}));

import { confirmConversationFileUploadAction } from './confirm-conversation-file-upload';
import { log } from '@/lib/logging';

const USER = { id: USER_ID, firstName: 'Dana', lastName: 'Whitfield' };

const ACCESS_OK = {
  ok: true,
  ctx: { lens: 'client' },
  request: { id: REQUEST_ID, title: 'CPQ implementation', createdByUserId: USER_ID },
  relationship: { id: REL_ID, expertProfileId: EXPERT_PROFILE_ID },
  recipient: { role: 'expert', expertProfileId: EXPERT_PROFILE_ID },
};

const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  key: KEY,
  fileName: 'scope.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
};

describe('confirmConversationFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(ACCESS_OK);
    mockSend.mockResolvedValue({ ContentLength: 1234, ContentType: 'application/pdf' });
    mockAddFile.mockResolvedValue({
      id: FILE_ID,
      relationshipId: REL_ID,
      uploadedByUserId: USER_ID,
      r2Key: KEY,
      fileName: 'scope.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      deletedAt: null,
    });
    mockMarkThreadRead.mockResolvedValue({ lastReadAt: CREATED_AT });
    mockPublishConversation.mockResolvedValue(undefined);
    mockPublishNotification.mockResolvedValue(undefined);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects a malformed key', async () => {
    const result = await confirmConversationFileUploadAction({
      ...VALID_INPUT,
      key: 'conversation-files/short/key',
    });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a key scoped to another relationship or user', async () => {
    const foreign = `conversation-files/${REL_ID}/a0000000-0000-4000-8000-00000000dead/${FILE_UUID}`;
    const result = await confirmConversationFileUploadAction({ ...VALID_INPUT, key: foreign });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('rejects + deletes when the real object exceeds the size cap', async () => {
    mockSend.mockResolvedValue({ ContentLength: 99 * 1024 * 1024, ContentType: 'application/pdf' });
    const result = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Uploaded file is too large. Please try a smaller file.',
    });
    expect(mockDelete).toHaveBeenCalledWith(KEY);
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('maps a missing/zero-byte object to EMPTY copy (never "too large")', async () => {
    mockSend.mockResolvedValue({ ContentLength: 0, ContentType: 'application/pdf' });
    const zero = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(zero).toEqual({ success: false, error: 'The uploaded file appears to be empty.' });
    expect(mockDelete).toHaveBeenCalledWith(KEY);

    mockSend.mockResolvedValue({ ContentType: 'application/pdf' }); // no ContentLength at all
    const missing = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(missing).toEqual({ success: false, error: 'The uploaded file appears to be empty.' });
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('rejects + deletes when the resolved content type is not allowed', async () => {
    mockSend.mockResolvedValue({ ContentLength: 100, ContentType: 'application/x-msdownload' });
    const result = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
    expect(mockDelete).toHaveBeenCalledWith(KEY);
  });

  it('inserts the row with the REAL size/type, publishes, notifies, marks read', async () => {
    const result = await confirmConversationFileUploadAction({
      ...VALID_INPUT,
      sizeBytes: 1, // client claim ignored
      contentType: 'text/csv', // R2's stored type wins
    });
    expect(result).toEqual({
      success: true,
      file: expect.objectContaining({
        id: FILE_ID,
        fileName: 'scope.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        uploadedByName: 'Dana Whitfield',
      }),
    });
    expect(mockAddFile).toHaveBeenCalledWith({
      relationshipId: REL_ID,
      uploadedByUserId: USER_ID,
      r2Key: KEY,
      fileName: 'scope.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
    });
    expect(mockPublishConversation).toHaveBeenCalledWith(
      REL_ID,
      'file',
      expect.objectContaining({ id: FILE_ID })
    );
    expect(mockPublishNotification).toHaveBeenCalledWith(
      'project.file_shared',
      expect.objectContaining({
        correlationId: FILE_ID,
        recipientRole: 'expert',
        expertProfileId: EXPERT_PROFILE_ID,
        fileName: 'scope.pdf',
      })
    );
    expect(mockMarkThreadRead).toHaveBeenCalledWith({
      relationshipId: REL_ID,
      userId: USER_ID,
      at: CREATED_AT,
    });
    expect(log.info).toHaveBeenCalledWith('Conversation file shared', expect.any(Object));
  });

  it('maps a duplicate confirm (23505) to "already shared" copy at WARN (expected double-click)', async () => {
    mockAddFile.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
    const result = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file was already shared.' });
    expect(log.warn).toHaveBeenCalledWith(
      'Duplicate conversation file confirm (expected double-click)',
      expect.any(Object)
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it('maps other failures to a generic friendly error', async () => {
    mockSend.mockRejectedValue(new Error('R2 down'));
    const result = await confirmConversationFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not share your file. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
  });
});
