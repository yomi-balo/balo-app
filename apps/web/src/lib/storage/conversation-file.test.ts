import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockSend, mockGetSignedUrl, mockWarn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetSignedUrl: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: mockSend },
  R2_BUCKET: 'test-bucket',
  R2_PUBLIC_URL: 'https://cdn.test',
}));

vi.mock('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  DeleteObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

import {
  generateConversationFileKey,
  createPresignedConversationFileUpload,
  createPresignedConversationFileDownload,
  deleteConversationFileFromR2,
  CONVERSATION_FILE_PREFIX,
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  MAX_CONVERSATION_FILE_BYTES,
} from './conversation-file';

const REL = 'rel-1';
const USER = 'user-1';

describe('conversation-file storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateConversationFileKey', () => {
    it('scopes the key to relationship + uploader under the conversation-files prefix', () => {
      const key = generateConversationFileKey(REL, USER);
      expect(key.startsWith(`${CONVERSATION_FILE_PREFIX}${REL}/${USER}/`)).toBe(true);
    });

    it('generates a unique suffix per call', () => {
      expect(generateConversationFileKey(REL, USER)).not.toBe(
        generateConversationFileKey(REL, USER)
      );
    });
  });

  describe('allow-list and cap', () => {
    it('accepts the widened document set (docx/xlsx/pptx/csv/txt)', () => {
      for (const type of [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
      ]) {
        expect(CONVERSATION_ALLOWED_CONTENT_TYPES.has(type)).toBe(true);
      }
    });

    it('caps files at 10 MB', () => {
      expect(MAX_CONVERSATION_FILE_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('createPresignedConversationFileUpload', () => {
    it('presigns an allowed content type and returns url + key', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      const result = await createPresignedConversationFileUpload(REL, USER, 'text/csv');
      expect(result.presignedUrl).toBe('https://signed.example/put');
      expect(result.key.startsWith(`${CONVERSATION_FILE_PREFIX}${REL}/${USER}/`)).toBe(true);
      expect(mockGetSignedUrl).toHaveBeenCalledOnce();
    });

    it('rejects a disallowed content type without presigning', async () => {
      await expect(
        createPresignedConversationFileUpload(REL, USER, 'application/x-msdownload')
      ).rejects.toThrow(/Invalid content type/);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('createPresignedConversationFileDownload', () => {
    it('presigns a GET with an attachment disposition carrying the stored name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      const url = await createPresignedConversationFileDownload('k', 'scope.pdf');
      expect(url).toBe('https://signed.example/get');
      const command = mockGetSignedUrl.mock.calls[0]?.[1] as { input: Record<string, unknown> };
      expect(command.input.ResponseContentDisposition).toBe('attachment; filename="scope.pdf"');
    });

    it('strips header-breaking characters from the file name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      await createPresignedConversationFileDownload('k', 'a"b\\c\nd.pdf');
      const command = mockGetSignedUrl.mock.calls[0]?.[1] as { input: Record<string, unknown> };
      expect(command.input.ResponseContentDisposition).toBe('attachment; filename="a_b_c_d.pdf"');
    });
  });

  describe('deleteConversationFileFromR2', () => {
    it('refuses to delete keys outside the conversation-files prefix', async () => {
      await deleteConversationFileFromR2('project-documents/x/y/z');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('deletes a conversation-files key', async () => {
      mockSend.mockResolvedValue({});
      await deleteConversationFileFromR2(`${CONVERSATION_FILE_PREFIX}${REL}/${USER}/abc`);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('warns (never throws) when deletion fails', async () => {
      mockSend.mockRejectedValue(new Error('boom'));
      await expect(
        deleteConversationFileFromR2(`${CONVERSATION_FILE_PREFIX}${REL}/${USER}/abc`)
      ).resolves.toBeUndefined();
      expect(mockWarn).toHaveBeenCalled();
    });
  });
});
