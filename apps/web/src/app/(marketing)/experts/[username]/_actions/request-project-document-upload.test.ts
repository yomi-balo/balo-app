import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

vi.mock('server-only', () => ({}));

const mockCreatePresigned = vi.fn();
vi.mock('@/lib/storage/project-document', () => ({
  createPresignedProjectDocumentUpload: (...args: unknown[]) => mockCreatePresigned(...args),
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { requestProjectDocumentUploadAction } from './request-project-document-upload';

const USER_ID = 'user-1';
const COMPANY_ID = 'company-1';

describe('requestProjectDocumentUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, companyId: COMPANY_ID } };
  });

  it('throws when unauthenticated', async () => {
    mockSessionObj = {};
    await expect(
      requestProjectDocumentUploadAction({ contentType: 'application/pdf', fileName: 'a.pdf' })
    ).rejects.toThrow('Unauthorized');
  });

  it('presigns scoped to the session company + user (not client input)', async () => {
    mockCreatePresigned.mockResolvedValue({
      presignedUrl: 'https://put',
      key: 'project-documents/k',
    });
    const result = await requestProjectDocumentUploadAction({
      contentType: 'application/pdf',
      fileName: 'brief.pdf',
    });
    expect(mockCreatePresigned).toHaveBeenCalledWith(COMPANY_ID, USER_ID, 'application/pdf');
    expect(result).toEqual({
      success: true,
      presignedUrl: 'https://put',
      key: 'project-documents/k',
    });
  });

  it('returns a friendly error and logs when presign throws', async () => {
    mockCreatePresigned.mockRejectedValue(new Error('Invalid content type: text/html'));
    const result = await requestProjectDocumentUploadAction({
      contentType: 'text/html',
      fileName: 'x.html',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to prepare upload. Please try again.');
    expect(log.error).toHaveBeenCalledWith(
      'Failed to create presigned project document upload URL',
      expect.objectContaining({ error: 'Invalid content type: text/html' })
    );
  });
});
