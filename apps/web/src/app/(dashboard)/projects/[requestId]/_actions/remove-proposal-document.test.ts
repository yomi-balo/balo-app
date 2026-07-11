import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const DOC_ID = 'd0000000-0000-4000-8000-000000000007';

vi.mock('server-only', () => ({}));

const { mockFindById, mockListByProposal, mockSoftDelete } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockListByProposal: vi.fn(),
  mockSoftDelete: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  proposalsRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  proposalDocumentsRepository: {
    listByProposal: (...a: unknown[]) => mockListByProposal(...a),
    softDelete: (...a: unknown[]) => mockSoftDelete(...a),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockDelete = vi.fn();
vi.mock('@/lib/storage/proposal-document', () => ({
  deleteProposalDocumentFromR2: (...args: unknown[]) => {
    mockDelete(...args);
    return Promise.resolve();
  },
}));

import { removeProposalDocumentAction } from './remove-proposal-document';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert' };
const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  proposalId: PROPOSAL_ID,
  documentId: DOC_ID,
};

describe('removeProposalDocumentAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'expert' } });
    mockFindById.mockResolvedValue({ id: PROPOSAL_ID, relationshipId: REL_ID, status: 'draft' });
    mockListByProposal.mockResolvedValue([{ id: DOC_ID, r2Key: 'proposal-documents/p/u/x' }]);
    mockSoftDelete.mockResolvedValue({ id: DOC_ID });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await removeProposalDocumentAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
  });

  it('blocks a non-expert lens', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
    expect(await removeProposalDocumentAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the expert can remove proposal documents.',
    });
  });

  it('rejects when the proposal is no longer a draft', async () => {
    mockFindById.mockResolvedValue({
      id: PROPOSAL_ID,
      relationshipId: REL_ID,
      status: 'submitted',
    });
    expect(await removeProposalDocumentAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be edited.',
    });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('rejects a documentId not belonging to the proposal', async () => {
    mockListByProposal.mockResolvedValue([{ id: 'other', r2Key: 'proposal-documents/p/u/y' }]);
    expect(await removeProposalDocumentAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This document is no longer available.',
    });
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });

  it('soft-deletes and best-effort R2-deletes the document', async () => {
    const result = await removeProposalDocumentAction(VALID_INPUT);
    expect(result).toEqual({ success: true, documentId: DOC_ID });
    expect(mockSoftDelete).toHaveBeenCalledWith(DOC_ID);
    expect(mockDelete).toHaveBeenCalledWith('proposal-documents/p/u/x');
  });

  it('treats a lost race (already removed) as not found', async () => {
    mockSoftDelete.mockResolvedValue(undefined);
    expect(await removeProposalDocumentAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This document is no longer available.',
    });
  });

  it('maps an unexpected failure to generic copy and logs error', async () => {
    mockListByProposal.mockRejectedValue(new Error('db down'));
    expect(await removeProposalDocumentAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not remove this document. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to remove proposal document',
      expect.any(Object)
    );
  });
});
