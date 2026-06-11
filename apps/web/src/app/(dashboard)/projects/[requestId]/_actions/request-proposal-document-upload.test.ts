import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockFindById = vi.fn();
vi.mock('@balo/db', () => ({
  proposalsRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
}));

const mockCreatePresigned = vi.fn();
vi.mock('@/lib/storage/proposal-document', () => ({
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'text/csv']),
  createPresignedProposalDocumentUpload: (...a: unknown[]) => mockCreatePresigned(...a),
}));

import { requestProposalDocumentUploadAction } from './request-proposal-document-upload';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert' };
const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  proposalId: PROPOSAL_ID,
  kind: 'ref' as const,
  contentType: 'application/pdf',
  fileName: 'ref.pdf',
};

describe('requestProposalDocumentUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'expert' } });
    mockFindById.mockResolvedValue({ id: PROPOSAL_ID, relationshipId: REL_ID, status: 'draft' });
    mockCreatePresigned.mockResolvedValue({
      presignedUrl: 'https://signed.example/put',
      key: `proposal-documents/${PROPOSAL_ID}/${USER.id}/abc`,
    });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await requestProposalDocumentUploadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
  });

  it('rejects invalid input', async () => {
    expect(await requestProposalDocumentUploadAction({ ...VALID_INPUT, fileName: '' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    expect(await requestProposalDocumentUploadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'No access.',
    });
    expect(mockCreatePresigned).not.toHaveBeenCalled();
  });

  it('blocks a non-expert (client) lens', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
    expect(await requestProposalDocumentUploadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the expert can attach proposal documents.',
    });
  });

  it('rejects when the proposal is not a live draft of this relationship', async () => {
    mockFindById.mockResolvedValue({
      id: PROPOSAL_ID,
      relationshipId: REL_ID,
      status: 'submitted',
    });
    expect(await requestProposalDocumentUploadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be edited.',
    });
    expect(mockCreatePresigned).not.toHaveBeenCalled();
  });

  it('rejects a foreign proposalId (different relationship)', async () => {
    mockFindById.mockResolvedValue({ id: PROPOSAL_ID, relationshipId: 'other', status: 'draft' });
    expect(await requestProposalDocumentUploadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be edited.',
    });
  });

  it('rejects a content type outside the allow-list', async () => {
    expect(
      await requestProposalDocumentUploadAction({
        ...VALID_INPUT,
        contentType: 'application/x-msdownload',
      })
    ).toEqual({ success: false, error: 'This file type is not supported.' });
    expect(mockCreatePresigned).not.toHaveBeenCalled();
  });

  it('presigns scoped to the validated proposal + session user', async () => {
    const result = await requestProposalDocumentUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      presignedUrl: 'https://signed.example/put',
      key: `proposal-documents/${PROPOSAL_ID}/${USER.id}/abc`,
    });
    expect(mockCreatePresigned).toHaveBeenCalledWith(PROPOSAL_ID, USER.id, 'application/pdf');
  });

  it('maps presign failures to friendly copy and logs error', async () => {
    mockCreatePresigned.mockRejectedValue(new Error('R2 down'));
    expect(await requestProposalDocumentUploadAction(VALID_INPUT)).toEqual({
      success: false,
      error: "Attaching documents isn't available right now.",
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign proposal document upload',
      expect.any(Object)
    );
  });
});
