import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const DOC_ID = 'd0000000-0000-4000-8000-000000000007';

vi.mock('server-only', () => ({}));

const { mockFindById, mockListByProposal } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockListByProposal: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  proposalsRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  proposalDocumentsRepository: {
    listByProposal: (...a: unknown[]) => mockListByProposal(...a),
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

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/proposal-document', () => ({
  createPresignedProposalDocumentDownload: (...a: unknown[]) => mockPresignDownload(...a),
}));

import { getProposalDocumentDownloadAction } from './get-proposal-document-download';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert' };
const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  proposalId: PROPOSAL_ID,
  documentId: DOC_ID,
};

describe('getProposalDocumentDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'expert' } });
    mockFindById.mockResolvedValue({ id: PROPOSAL_ID, relationshipId: REL_ID, status: 'draft' });
    mockListByProposal.mockResolvedValue([
      { id: DOC_ID, r2Key: 'proposal-documents/p/u/x', fileName: 'ref.pdf' },
    ]);
    mockPresignDownload.mockResolvedValue('https://signed.example/get');
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'No access.',
    });
  });

  it('gates download to the expert author (client lens denied in this slice)', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have access to this document.',
    });
    expect(mockPresignDownload).not.toHaveBeenCalled();
  });

  it('rejects a proposal not belonging to the relationship', async () => {
    mockFindById.mockResolvedValue({ id: PROPOSAL_ID, relationshipId: 'other', status: 'draft' });
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This document is no longer available.',
    });
  });

  it('rejects a documentId not belonging to the proposal', async () => {
    mockListByProposal.mockResolvedValue([{ id: 'other', r2Key: 'k', fileName: 'x.pdf' }]);
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This document is no longer available.',
    });
  });

  it('presigns a short-lived GET for a valid document', async () => {
    const result = await getProposalDocumentDownloadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, url: 'https://signed.example/get' });
    expect(mockPresignDownload).toHaveBeenCalledWith('proposal-documents/p/u/x', 'ref.pdf');
  });

  it('maps presign failure to friendly copy and logs error', async () => {
    mockPresignDownload.mockRejectedValue(new Error('R2 down'));
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not download this document. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign proposal document download',
      expect.any(Object)
    );
  });
});
