import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-0000000000ff';
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

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
}));

const mockTrackServer = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrackServer(...a),
  PROJECT_SERVER_EVENTS: {
    PROPOSAL_ATTACHMENT_DOWNLOADED: 'project_proposal_attachment_downloaded',
  },
}));

const mockPresignDownload = vi.fn();
vi.mock('@/lib/storage/proposal-document', () => ({
  createPresignedProposalDocumentDownload: (...a: unknown[]) => mockPresignDownload(...a),
}));

import { getProposalDocumentDownloadAction } from './get-proposal-document-download';
import { log } from '@/lib/logging';

const USER = { id: 'user-1' };
const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  proposalId: PROPOSAL_ID,
  documentId: DOC_ID,
};

const NO_ACCESS = { success: false, error: 'You do not have access to this document.' };
const NOT_FOUND = { success: false, error: 'This document is no longer available.' };

const REQUEST = { id: REQUEST_ID, status: 'proposal_submitted' };
const trackOf = (relationshipId: string): { relationshipId: string } => ({ relationshipId });

const CLIENT_SCOPE = {
  ok: true,
  side: 'client',
  request: REQUEST,
  companyId: 'co',
  tracks: [trackOf(REL_ID)],
};
const ADMIN_SCOPE = { ok: true, side: 'admin', request: REQUEST, tracks: [trackOf(REL_ID)] };
const expertScope = (relationshipId: string): object => ({
  ok: true,
  side: 'expert',
  request: REQUEST,
  viewer: trackOf(relationshipId),
});

function proposalWith(status: string): object {
  return { id: PROPOSAL_ID, relationshipId: REL_ID, status };
}

describe('getProposalDocumentDownloadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockFindById.mockResolvedValue(proposalWith('submitted'));
    mockListByProposal.mockResolvedValue([
      { id: DOC_ID, r2Key: 'proposal-documents/p/u/x', fileName: 'ref.pdf' },
    ]);
    mockPresignDownload.mockResolvedValue('https://signed.example/get');
  });

  it('rejects when not signed in, before touching the gate', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockAuthorizeScope).not.toHaveBeenCalled();
  });

  it('rejects a malformed id', async () => {
    expect(await getProposalDocumentDownloadAction({ ...VALID_INPUT, documentId: 'nope' })).toEqual(
      { success: false, error: 'Invalid request.' }
    );
    expect(mockAuthorizeScope).not.toHaveBeenCalled();
  });

  it('scopes the gate to the request named in the input', async () => {
    await getProposalDocumentDownloadAction(VALID_INPUT);
    expect(mockAuthorizeScope).toHaveBeenCalledWith(USER, REQUEST_ID);
  });

  describe('client', () => {
    it('gets a URL for a document on a sent proposal and the server event records the lens', async () => {
      const result = await getProposalDocumentDownloadAction(VALID_INPUT);

      expect(result).toEqual({ success: true, url: 'https://signed.example/get' });
      expect(mockPresignDownload).toHaveBeenCalledWith('proposal-documents/p/u/x', 'ref.pdf');
      expect(mockTrackServer).toHaveBeenCalledWith('project_proposal_attachment_downloaded', {
        request_id: REQUEST_ID,
        relationship_id: REL_ID,
        proposal_id: PROPOSAL_ID,
        lens: 'client',
        distinct_id: USER.id,
      });
    });

    it.each(['submitted', 'changes_requested', 'accepted', 'resubmitted'])(
      'reads a %s proposal’s documents',
      async (status) => {
        mockFindById.mockResolvedValue(proposalWith(status));
        const result = await getProposalDocumentDownloadAction(VALID_INPUT);
        expect(result.success).toBe(true);
      }
    );

    it.each(['draft', 'withdrawn', 'declined'])(
      'is refused a %s proposal, as if it did not exist',
      async (status) => {
        mockFindById.mockResolvedValue(proposalWith(status));

        expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NOT_FOUND);

        expect(mockPresignDownload).not.toHaveBeenCalled();
        expect(mockTrackServer).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
          'Proposal document download denied',
          expect.objectContaining({
            side: 'client',
            reason: 'status_not_shared',
            status,
            proposalId: PROPOSAL_ID,
          })
        );
      }
    );

    it('is refused a track its scope does not carry (unopened or foreign)', async () => {
      mockAuthorizeScope.mockResolvedValue({ ...CLIENT_SCOPE, tracks: [trackOf(OTHER_REL_ID)] });

      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NO_ACCESS);

      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockPresignDownload).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'Proposal document download denied',
        expect.objectContaining({ side: 'client', reason: 'wrong_track' })
      );
    });
  });

  describe('admin', () => {
    it('is refused when the platform capability is missing (the gate answers not-ok)', async () => {
      mockAuthorizeScope.mockResolvedValue({ ok: false, code: 'request_files_not_found' });

      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NO_ACCESS);

      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockPresignDownload).not.toHaveBeenCalled();
    });

    it('gets a URL for a sent proposal', async () => {
      mockAuthorizeScope.mockResolvedValue(ADMIN_SCOPE);

      const result = await getProposalDocumentDownloadAction(VALID_INPUT);

      expect(result).toEqual({ success: true, url: 'https://signed.example/get' });
      expect(mockTrackServer).toHaveBeenCalledWith(
        'project_proposal_attachment_downloaded',
        expect.objectContaining({ lens: 'admin' })
      );
    });

    it.each(['draft', 'withdrawn', 'declined'])('is refused a %s proposal', async (status) => {
      mockAuthorizeScope.mockResolvedValue(ADMIN_SCOPE);
      mockFindById.mockResolvedValue(proposalWith(status));

      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NOT_FOUND);
    });

    it.each(['accepted', 'resubmitted'])('reads a %s proposal’s documents', async (status) => {
      mockAuthorizeScope.mockResolvedValue(ADMIN_SCOPE);
      mockFindById.mockResolvedValue(proposalWith(status));

      expect((await getProposalDocumentDownloadAction(VALID_INPUT)).success).toBe(true);
    });
  });

  describe('expert', () => {
    it('is refused another expert’s track', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope(OTHER_REL_ID));

      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NO_ACCESS);

      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockPresignDownload).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        'Proposal document download denied',
        expect.objectContaining({ side: 'expert', reason: 'wrong_track' })
      );
    });

    it('may open the files of their own draft', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope(REL_ID));
      mockFindById.mockResolvedValue(proposalWith('draft'));

      const result = await getProposalDocumentDownloadAction(VALID_INPUT);

      expect(result).toEqual({ success: true, url: 'https://signed.example/get' });
      expect(mockTrackServer).toHaveBeenCalledWith(
        'project_proposal_attachment_downloaded',
        expect.objectContaining({ lens: 'expert' })
      );
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('may open the files of their own sent proposal', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope(REL_ID));

      const result = await getProposalDocumentDownloadAction(VALID_INPUT);

      expect(result.success).toBe(true);
    });
  });

  describe('lookups', () => {
    it('rejects a proposal not belonging to the relationship', async () => {
      mockFindById.mockResolvedValue({
        id: PROPOSAL_ID,
        relationshipId: OTHER_REL_ID,
        status: 'submitted',
      });
      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NOT_FOUND);
    });

    it('rejects a missing proposal', async () => {
      mockFindById.mockResolvedValue(undefined);
      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NOT_FOUND);
    });

    it('answers NOT_FOUND for a documentId that is not on the proposal', async () => {
      mockListByProposal.mockResolvedValue([{ id: 'other', r2Key: 'k', fileName: 'x.pdf' }]);

      expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual(NOT_FOUND);

      expect(mockPresignDownload).not.toHaveBeenCalled();
      expect(mockTrackServer).not.toHaveBeenCalled();
    });
  });

  it('maps a presign failure to friendly copy, logs an error and fires no event', async () => {
    mockPresignDownload.mockRejectedValue(new Error('R2 down'));

    expect(await getProposalDocumentDownloadAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not download this document. Please try again.',
    });

    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign proposal document download',
      expect.any(Object)
    );
    expect(mockTrackServer).not.toHaveBeenCalled();
  });
});
