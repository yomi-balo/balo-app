import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

vi.mock('server-only', () => ({}));

const mockDelete = vi.fn();
vi.mock('@/lib/storage/project-document', () => ({
  deleteProjectDocumentFromR2: (...args: unknown[]) => mockDelete(...args),
  PROJECT_DOCUMENT_PREFIX: 'project-documents/',
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { removeProjectDocumentAction } from './remove-project-document';

const USER_ID = 'user-1';
const COMPANY_ID = 'company-1';
const OWN_KEY = `project-documents/${COMPANY_ID}/${USER_ID}/doc-1`;

describe('removeProjectDocumentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, companyId: COMPANY_ID } };
    mockDelete.mockResolvedValue(undefined);
  });

  it('throws when unauthenticated', async () => {
    mockSessionObj = {};
    await expect(removeProjectDocumentAction({ key: OWN_KEY })).rejects.toThrow('Unauthorized');
  });

  it('deletes a key owned by the session company + user', async () => {
    const result = await removeProjectDocumentAction({ key: OWN_KEY });
    expect(mockDelete).toHaveBeenCalledWith(OWN_KEY);
    expect(result).toEqual({ success: true });
  });

  it('refuses a key scoped to another company/user', async () => {
    const result = await removeProjectDocumentAction({
      key: 'project-documents/other-company/other-user/doc-1',
    });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('returns a friendly error and logs when delete throws', async () => {
    mockDelete.mockRejectedValue(new Error('R2 down'));
    const result = await removeProjectDocumentAction({ key: OWN_KEY });
    expect(result).toEqual({
      success: false,
      error: 'Failed to remove document. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to remove project document',
      expect.objectContaining({ error: 'R2 down' })
    );
  });
});
