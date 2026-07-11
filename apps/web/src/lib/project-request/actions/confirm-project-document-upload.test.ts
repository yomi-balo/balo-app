import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

vi.mock('server-only', () => ({}));

const { mockSend, mockDelete } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: mockSend },
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

vi.mock('@/lib/storage/project-document', () => ({
  deleteProjectDocumentFromR2: (...args: unknown[]) => mockDelete(...args),
  ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']),
  MAX_DOCUMENT_BYTES: 5 * 1024 * 1024,
  PROJECT_DOCUMENT_PREFIX: 'project-documents/',
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { confirmProjectDocumentUploadAction } from './confirm-project-document-upload';

// 36-char uuid-shaped segments to satisfy the key regex.
const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VALID_KEY = `project-documents/${COMPANY_ID}/${USER_ID}/${DOC_ID}`;

function input(overrides: Record<string, unknown> = {}): {
  key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
} {
  return {
    key: VALID_KEY,
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

describe('confirmProjectDocumentUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, onboardingCompleted: true, companyId: COMPANY_ID } };
  });

  it('throws when unauthenticated', async () => {
    mockSessionObj = {};
    await expect(confirmProjectDocumentUploadAction(input())).rejects.toThrow('Unauthorized');
  });

  it('confirms a valid object and returns the trusted ref (no DB write)', async () => {
    mockSend.mockResolvedValue({ ContentLength: 2048, ContentType: 'application/pdf' });
    const result = await confirmProjectDocumentUploadAction(input());
    expect(result).toEqual({
      success: true,
      document: {
        r2Key: VALID_KEY,
        fileName: 'brief.pdf',
        contentType: 'application/pdf',
        // size comes from R2 HEAD, not the client claim
        sizeBytes: 2048,
      },
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('rejects a key that does not match the uuid-scoped pattern', async () => {
    const result = await confirmProjectDocumentUploadAction(input({ key: 'project-documents/x' }));
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a key scoped to another company/user (cross-tenant)', async () => {
    const otherKey = `project-documents/${USER_ID}/${COMPANY_ID}/${DOC_ID}`;
    const result = await confirmProjectDocumentUploadAction(input({ key: otherKey }));
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects + deletes an oversized object', async () => {
    mockSend.mockResolvedValue({ ContentLength: 6 * 1024 * 1024, ContentType: 'application/pdf' });
    const result = await confirmProjectDocumentUploadAction(input());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/);
    expect(mockDelete).toHaveBeenCalledWith(VALID_KEY);
  });

  it('rejects + deletes a zero-length object', async () => {
    mockSend.mockResolvedValue({ ContentLength: 0, ContentType: 'application/pdf' });
    const result = await confirmProjectDocumentUploadAction(input());
    expect(result.success).toBe(false);
    expect(mockDelete).toHaveBeenCalledWith(VALID_KEY);
  });

  it('rejects + deletes an object with a disallowed stored content type', async () => {
    mockSend.mockResolvedValue({ ContentLength: 1024, ContentType: 'text/html' });
    const result = await confirmProjectDocumentUploadAction(input());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not supported/);
    expect(mockDelete).toHaveBeenCalledWith(VALID_KEY);
  });

  it('falls back to the client content type when R2 omits it', async () => {
    mockSend.mockResolvedValue({ ContentLength: 1024 });
    const result = await confirmProjectDocumentUploadAction(input({ contentType: 'image/png' }));
    expect(result.success).toBe(true);
    expect(result.document?.contentType).toBe('image/png');
  });

  it('returns a friendly error and logs when HEAD throws', async () => {
    mockSend.mockRejectedValue(new Error('R2 timeout'));
    const result = await confirmProjectDocumentUploadAction(input());
    expect(result).toEqual({ success: false, error: 'Failed to save document. Please try again.' });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to confirm project document upload',
      expect.objectContaining({ error: 'R2 timeout' })
    );
  });
});
