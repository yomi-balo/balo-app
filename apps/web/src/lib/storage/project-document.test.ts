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
  DeleteObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
  CopyObjectCommand: class {
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

vi.mock('@/lib/storage/conversation-file', () => ({
  CONVERSATION_FILE_PREFIX: 'conversation-files/',
}));

vi.mock('@/lib/storage/meeting-file', () => ({
  MEETING_FILE_PREFIX: 'meeting-files/',
}));

import {
  generateProjectDocumentKey,
  createPresignedProjectDocumentUpload,
  deleteProjectDocumentFromR2,
  copyCaseFileIntoProjectDocuments,
  MAX_DOCUMENT_BYTES,
  PROJECT_DOCUMENT_PREFIX,
} from './project-document';

const COMPANY = 'company-1';
const USER = 'user-1';

describe('project-document storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateProjectDocumentKey', () => {
    it('scopes the key to company + user under the project-documents prefix', () => {
      const key = generateProjectDocumentKey(COMPANY, USER);
      expect(key.startsWith(`${PROJECT_DOCUMENT_PREFIX}${COMPANY}/${USER}/`)).toBe(true);
    });

    it('generates a unique suffix per call', () => {
      const a = generateProjectDocumentKey(COMPANY, USER);
      const b = generateProjectDocumentKey(COMPANY, USER);
      expect(a).not.toBe(b);
    });
  });

  describe('createPresignedProjectDocumentUpload', () => {
    it('presigns an allowed content type and returns url + key', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      const result = await createPresignedProjectDocumentUpload(COMPANY, USER, 'application/pdf');
      expect(result.presignedUrl).toBe('https://signed.example/put');
      expect(result.key.startsWith(`${PROJECT_DOCUMENT_PREFIX}${COMPANY}/${USER}/`)).toBe(true);
      expect(mockGetSignedUrl).toHaveBeenCalledOnce();
    });

    it('rejects a disallowed content type without presigning', async () => {
      await expect(
        createPresignedProjectDocumentUpload(COMPANY, USER, 'text/html')
      ).rejects.toThrow(/Invalid content type/);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('accepts every allow-listed image type', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed');
      for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
        await expect(
          createPresignedProjectDocumentUpload(COMPANY, USER, type)
        ).resolves.toHaveProperty('key');
      }
    });
  });

  describe('deleteProjectDocumentFromR2', () => {
    it('deletes a key under the project-documents prefix', async () => {
      mockSend.mockResolvedValue({});
      await deleteProjectDocumentFromR2(`${PROJECT_DOCUMENT_PREFIX}${COMPANY}/${USER}/abc`);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('refuses to delete a key outside the prefix (guard)', async () => {
      await deleteProjectDocumentFromR2('avatars/user-1/x.webp');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('swallows + warns on R2 failure (best-effort)', async () => {
      mockSend.mockRejectedValue(new Error('R2 down'));
      await expect(
        deleteProjectDocumentFromR2(`${PROJECT_DOCUMENT_PREFIX}${COMPANY}/${USER}/abc`)
      ).resolves.toBeUndefined();
      expect(mockWarn).toHaveBeenCalled();
    });
  });

  it('exposes the documented size limit', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(5 * 1024 * 1024);
  });

  describe('copyCaseFileIntoProjectDocuments', () => {
    const SRC_CONVERSATION = `conversation-files/conv-1/${USER}/stored-object`;
    const SRC_MEETING = `meeting-files/meeting-1/${USER}/stored-object`;
    const DEST = `${PROJECT_DOCUMENT_PREFIX}${COMPANY}/${USER}/copied-object`;

    it('copies a conversation file into the project-documents prefix', async () => {
      mockSend.mockResolvedValue({});
      await copyCaseFileIntoProjectDocuments(SRC_CONVERSATION, DEST);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('copies a meeting file into the project-documents prefix', async () => {
      mockSend.mockResolvedValue({});
      await copyCaseFileIntoProjectDocuments(SRC_MEETING, DEST);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('refuses a source outside the case-files space (guard)', async () => {
      await expect(
        copyCaseFileIntoProjectDocuments(`${PROJECT_DOCUMENT_PREFIX}other/x/y`, DEST)
      ).rejects.toThrow(/case-files space/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a destination outside the project-documents space (guard)', async () => {
      await expect(
        copyCaseFileIntoProjectDocuments(SRC_CONVERSATION, 'conversation-files/other/x/y')
      ).rejects.toThrow(/project-documents space/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rethrows (does not swallow) on R2 failure, unlike the delete path', async () => {
      mockSend.mockRejectedValue(new Error('R2 down'));
      await expect(copyCaseFileIntoProjectDocuments(SRC_CONVERSATION, DEST)).rejects.toThrow(
        'R2 down'
      );
      expect(mockWarn).toHaveBeenCalled();
    });

    // Never log or throw the R2 key, only the source origin + message.
    it('logs the source origin and error message on failure, never the keys', async () => {
      mockSend.mockRejectedValue(new Error('R2 down'));
      await expect(copyCaseFileIntoProjectDocuments(SRC_CONVERSATION, DEST)).rejects.toThrow(
        'R2 down'
      );
      expect(mockWarn).toHaveBeenCalledWith('Failed to copy case file into project documents', {
        sourceOrigin: 'conversation',
        error: 'R2 down',
      });
      const [, context] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
      expect(context).not.toHaveProperty('srcKey');
      expect(context).not.toHaveProperty('destKey');
    });

    it('tags a meeting-sourced failure with the meeting origin', async () => {
      mockSend.mockRejectedValue(new Error('R2 down'));
      await expect(copyCaseFileIntoProjectDocuments(SRC_MEETING, DEST)).rejects.toThrow('R2 down');
      expect(mockWarn).toHaveBeenCalledWith('Failed to copy case file into project documents', {
        sourceOrigin: 'meeting',
        error: 'R2 down',
      });
    });

    it('the guard errors never include the key', async () => {
      const badSrc = `${PROJECT_DOCUMENT_PREFIX}other/x/y`;
      let srcError: unknown;
      try {
        await copyCaseFileIntoProjectDocuments(badSrc, DEST);
      } catch (error) {
        srcError = error;
      }
      expect(srcError).toBeInstanceOf(Error);
      expect((srcError as Error).message).not.toContain(badSrc);

      const badDest = 'conversation-files/other/x/y';
      let destError: unknown;
      try {
        await copyCaseFileIntoProjectDocuments(SRC_CONVERSATION, badDest);
      } catch (error) {
        destError = error;
      }
      expect(destError).toBeInstanceOf(Error);
      expect((destError as Error).message).not.toContain(badDest);
    });
  });
});
