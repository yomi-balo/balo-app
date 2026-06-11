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
  generateProposalDocumentKey,
  createPresignedProposalDocumentUpload,
  createPresignedProposalDocumentDownload,
  deleteProposalDocumentFromR2,
  PROPOSAL_DOCUMENT_PREFIX,
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES,
  MAX_PROPOSAL_DOCUMENT_BYTES,
} from './proposal-document';

const PROPOSAL = 'proposal-1';
const USER = 'user-1';

describe('proposal-document storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateProposalDocumentKey', () => {
    it('scopes the key to proposal + uploader under the proposal-documents prefix', () => {
      const key = generateProposalDocumentKey(PROPOSAL, USER);
      expect(key.startsWith(`${PROPOSAL_DOCUMENT_PREFIX}${PROPOSAL}/${USER}/`)).toBe(true);
    });

    it('generates a unique suffix per call', () => {
      expect(generateProposalDocumentKey(PROPOSAL, USER)).not.toBe(
        generateProposalDocumentKey(PROPOSAL, USER)
      );
    });
  });

  describe('allow-list and cap', () => {
    it('accepts the shared document set (pdf/images/docx/xlsx/pptx/csv/txt)', () => {
      for (const type of [
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/webp',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
      ]) {
        expect(PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES.has(type)).toBe(true);
      }
    });

    it('caps files at 10 MB', () => {
      expect(MAX_PROPOSAL_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('createPresignedProposalDocumentUpload', () => {
    it('presigns an allowed content type and returns url + proposal-scoped key', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/put');
      const result = await createPresignedProposalDocumentUpload(PROPOSAL, USER, 'application/pdf');
      expect(result.presignedUrl).toBe('https://signed.example/put');
      expect(result.key.startsWith(`${PROPOSAL_DOCUMENT_PREFIX}${PROPOSAL}/${USER}/`)).toBe(true);
      expect(mockGetSignedUrl).toHaveBeenCalledOnce();
    });

    it('rejects a disallowed content type without presigning', async () => {
      await expect(
        createPresignedProposalDocumentUpload(PROPOSAL, USER, 'application/x-msdownload')
      ).rejects.toThrow(/Invalid content type/);
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('createPresignedProposalDocumentDownload', () => {
    it('presigns a GET with an attachment disposition carrying the stored name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      const url = await createPresignedProposalDocumentDownload('k', 'terms.pdf');
      expect(url).toBe('https://signed.example/get');
      const command = mockGetSignedUrl.mock.calls[0]?.[1] as { input: Record<string, unknown> };
      expect(command.input.ResponseContentDisposition).toBe('attachment; filename="terms.pdf"');
    });

    it('strips header-breaking characters from the file name', async () => {
      mockGetSignedUrl.mockResolvedValue('https://signed.example/get');
      // a"b <backslash> c <newline> d.pdf — each of ", \, and the control char
      // becomes a single underscore.
      const hostile = 'a"b' + String.fromCharCode(92) + 'c' + String.fromCharCode(10) + 'd.pdf';
      await createPresignedProposalDocumentDownload('k', hostile);
      const command = mockGetSignedUrl.mock.calls[0]?.[1] as { input: Record<string, unknown> };
      expect(command.input.ResponseContentDisposition).toBe('attachment; filename="a_b_c_d.pdf"');
    });
  });

  describe('deleteProposalDocumentFromR2', () => {
    it('refuses to delete keys outside the proposal-documents prefix', async () => {
      await deleteProposalDocumentFromR2('conversation-files/x/y/z');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('deletes a proposal-documents key', async () => {
      mockSend.mockResolvedValue({});
      await deleteProposalDocumentFromR2(`${PROPOSAL_DOCUMENT_PREFIX}${PROPOSAL}/${USER}/abc`);
      expect(mockSend).toHaveBeenCalledOnce();
    });

    it('warns (never throws) when deletion fails', async () => {
      mockSend.mockRejectedValue(new Error('boom'));
      await expect(
        deleteProposalDocumentFromR2(`${PROPOSAL_DOCUMENT_PREFIX}${PROPOSAL}/${USER}/abc`)
      ).resolves.toBeUndefined();
      expect(mockWarn).toHaveBeenCalled();
    });
  });
});
