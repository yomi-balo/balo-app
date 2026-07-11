import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const DOC_UUID = 'f0000000-0000-4000-8000-000000000006';
const DOC_ID = 'd0000000-0000-4000-8000-000000000007';
const KEY = `proposal-documents/${PROPOSAL_ID}/${USER_ID}/${DOC_UUID}`;
const CREATED_AT = new Date('2026-06-10T10:00:00Z');

vi.mock('server-only', () => ({}));

const { mockFindById, mockAddDocument, mockListByProposal, mockSoftDelete } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockAddDocument: vi.fn(),
  mockListByProposal: vi.fn(),
  mockSoftDelete: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  proposalsRepository: { findById: (...a: unknown[]) => mockFindById(...a) },
  proposalDocumentsRepository: {
    addDocument: (...a: unknown[]) => mockAddDocument(...a),
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

const mockSend = vi.fn();
vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: (...args: unknown[]) => mockSend(...args) },
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

const mockDelete = vi.fn();
vi.mock('@/lib/storage/proposal-document', () => ({
  PROPOSAL_DOCUMENT_ALLOWED_CONTENT_TYPES: new Set(['application/pdf', 'text/csv']),
  PROPOSAL_DOCUMENT_PREFIX: 'proposal-documents/',
  MAX_PROPOSAL_DOCUMENT_BYTES: 10 * 1024 * 1024,
  deleteProposalDocumentFromR2: (...args: unknown[]) => {
    mockDelete(...args);
    return Promise.resolve();
  },
}));

import { confirmProposalDocumentUploadAction } from './confirm-proposal-document-upload';
import { log } from '@/lib/logging';

const USER = { id: USER_ID, firstName: 'Ada', lastName: 'L' };

const BASE_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  proposalId: PROPOSAL_ID,
  kind: 'ref' as const,
  key: KEY,
  fileName: 'ref.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
};

describe('confirmProposalDocumentUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'expert' } });
    mockFindById.mockResolvedValue({ id: PROPOSAL_ID, relationshipId: REL_ID, status: 'draft' });
    mockSend.mockResolvedValue({ ContentLength: 2048, ContentType: 'application/pdf' });
    mockListByProposal.mockResolvedValue([]);
    mockSoftDelete.mockResolvedValue({ id: 'old' });
    mockAddDocument.mockResolvedValue({
      id: DOC_ID,
      kind: 'ref',
      fileName: 'ref.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      createdAt: CREATED_AT,
    });
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await confirmProposalDocumentUploadAction(BASE_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
  });

  it('blocks a non-expert lens', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
    expect(await confirmProposalDocumentUploadAction(BASE_INPUT)).toEqual({
      success: false,
      error: 'Only the expert can attach proposal documents.',
    });
  });

  it('rejects when the proposal is no longer a draft', async () => {
    mockFindById.mockResolvedValue({
      id: PROPOSAL_ID,
      relationshipId: REL_ID,
      status: 'submitted',
    });
    expect(await confirmProposalDocumentUploadAction(BASE_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be edited.',
    });
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  it('rejects a key that does not match the proposal + user provenance', async () => {
    const result = await confirmProposalDocumentUploadAction({
      ...BASE_INPUT,
      key: `proposal-documents/${PROPOSAL_ID}/other-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${DOC_UUID}`,
    });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockAddDocument).not.toHaveBeenCalled();
  });

  it('rejects an empty uploaded object and best-effort deletes it', async () => {
    mockSend.mockResolvedValue({ ContentLength: 0 });
    const result = await confirmProposalDocumentUploadAction(BASE_INPUT);
    expect(result).toEqual({ success: false, error: 'The uploaded file appears to be empty.' });
    expect(mockDelete).toHaveBeenCalledWith(KEY);
  });

  it('rejects an over-cap object', async () => {
    mockSend.mockResolvedValue({ ContentLength: 11 * 1024 * 1024, ContentType: 'application/pdf' });
    const result = await confirmProposalDocumentUploadAction(BASE_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Uploaded file is too large. Please try a smaller file.',
    });
  });

  it('inserts the row and returns the document view (ref)', async () => {
    const result = await confirmProposalDocumentUploadAction(BASE_INPUT);
    expect(result).toEqual({
      success: true,
      document: {
        id: DOC_ID,
        proposalId: PROPOSAL_ID,
        kind: 'ref',
        fileName: 'ref.pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        uploadedByUserId: USER_ID,
        createdAtIso: CREATED_AT.toISOString(),
      },
    });
    expect(mockAddDocument).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, kind: 'ref', r2Key: KEY })
    );
  });

  it('replaces a prior live terms supplement when kind is terms', async () => {
    mockListByProposal.mockResolvedValue([
      { id: 'old-terms', r2Key: 'proposal-documents/p/u/old' },
    ]);
    mockAddDocument.mockResolvedValue({
      id: DOC_ID,
      kind: 'terms',
      fileName: 'terms.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      createdAt: CREATED_AT,
    });
    const result = await confirmProposalDocumentUploadAction({ ...BASE_INPUT, kind: 'terms' });
    expect(result.success).toBe(true);
    expect(mockListByProposal).toHaveBeenCalledWith(PROPOSAL_ID, 'terms');
    expect(mockSoftDelete).toHaveBeenCalledWith('old-terms');
    expect(mockDelete).toHaveBeenCalledWith('proposal-documents/p/u/old');
    expect(log.warn).toHaveBeenCalledWith(
      'Replaced prior terms supplement on a proposal',
      expect.any(Object)
    );
  });

  it('maps a duplicate confirm (23505) to friendly copy with a warn', async () => {
    mockAddDocument.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const result = await confirmProposalDocumentUploadAction(BASE_INPUT);
    expect(result).toEqual({ success: false, error: 'This document was already attached.' });
    expect(log.warn).toHaveBeenCalledWith(
      'Duplicate proposal document confirm (expected double-click)',
      expect.any(Object)
    );
  });

  it('maps an unexpected failure to generic copy and logs error', async () => {
    mockAddDocument.mockRejectedValue(new Error('db down'));
    const result = await confirmProposalDocumentUploadAction(BASE_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'Could not attach your document. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to confirm proposal document upload',
      expect.any(Object)
    );
  });
});
