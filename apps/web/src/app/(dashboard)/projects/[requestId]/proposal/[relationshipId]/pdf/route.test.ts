import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGetCurrentUser,
  mockFindByIdWithRelations,
  mockFindCurrentByRelationship,
  mockFindExpertOrgName,
  mockListMilestones,
  mockListInstallments,
  mockListDocuments,
  mockResolveRequestLens,
  mockHydrateReviewDoc,
  mockGetPdfFromR2,
  mockPutPdfToR2,
  mockRenderPdf,
  mockTrackServerAndFlush,
  mockLog,
} = vi.hoisted(() => ({
  mockGetCurrentUser: vi.fn(),
  mockFindByIdWithRelations: vi.fn(),
  mockFindCurrentByRelationship: vi.fn(),
  mockFindExpertOrgName: vi.fn(),
  mockListMilestones: vi.fn(),
  mockListInstallments: vi.fn(),
  mockListDocuments: vi.fn(),
  mockResolveRequestLens: vi.fn(),
  mockHydrateReviewDoc: vi.fn(),
  mockGetPdfFromR2: vi.fn(),
  mockPutPdfToR2: vi.fn(),
  mockRenderPdf: vi.fn(),
  mockTrackServerAndFlush: vi.fn(),
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/db', () => ({
  projectRequestsRepository: { findByIdWithRelations: mockFindByIdWithRelations },
  proposalsRepository: {
    findCurrentByRelationship: mockFindCurrentByRelationship,
    findExpertOrgName: mockFindExpertOrgName,
  },
  proposalMilestonesRepository: { listByProposal: mockListMilestones },
  proposalPaymentInstallmentsRepository: { listByProposal: mockListInstallments },
  proposalDocumentsRepository: { listByProposal: mockListDocuments },
}));

vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => mockGetCurrentUser() }));

vi.mock('@/lib/project-request/resolve-request-lens', () => ({
  resolveRequestLens: (...args: unknown[]) => mockResolveRequestLens(...args),
}));

vi.mock('@/lib/project-request/proposal-audience-view', () => ({
  hydrateReviewDoc: (...args: unknown[]) => mockHydrateReviewDoc(...args),
}));

vi.mock('@/lib/storage/proposal-pdf', () => ({
  proposalPdfKey: (id: string) => `proposals/${id}/client.pdf`,
  getProposalPdfFromR2: (...args: unknown[]) => mockGetPdfFromR2(...args),
  putProposalPdfToR2: (...args: unknown[]) => mockPutPdfToR2(...args),
}));

vi.mock('@/lib/project-request/proposal/pdf/proposal-pdf-document', () => ({
  renderProposalPdfToBuffer: (...args: unknown[]) => mockRenderPdf(...args),
}));

vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrackServerAndFlush(...args),
  PROJECT_SERVER_EVENTS: { PROJECT_PROPOSAL_PDF_DOWNLOADED: 'project_proposal_pdf_downloaded' },
}));

vi.mock('@/lib/logging', () => ({ log: mockLog }));

import { GET } from './route';

// The route now UUID-validates both path params, so the fixtures use canonical UUIDs.
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RELATIONSHIP_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_RELATIONSHIP_ID = '33333333-3333-4333-8333-333333333333';

const USER = { id: 'user-1', platformRole: 'user' };
const REQUEST = {
  id: REQUEST_ID,
  title: 'CRM Cleanup',
  company: { id: 'co-1', name: 'Northwind Industrial' },
  relationships: [{ id: RELATIONSHIP_ID, status: 'proposal_submitted' }],
};
const PROPOSAL = {
  id: 'proposal-1',
  status: 'submitted',
  version: 2,
  relationshipId: RELATIONSHIP_ID,
};

function callGet(requestId = REQUEST_ID, relationshipId = RELATIONSHIP_ID): Promise<Response> {
  return GET(new Request('http://localhost/pdf'), {
    params: Promise.resolve({ requestId, relationshipId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(USER);
  mockFindByIdWithRelations.mockResolvedValue(REQUEST);
  mockResolveRequestLens.mockReturnValue({ lens: 'client' });
  mockFindCurrentByRelationship.mockResolvedValue(PROPOSAL);
  mockFindExpertOrgName.mockResolvedValue('CloudPeak');
  mockListMilestones.mockResolvedValue([]);
  mockListInstallments.mockResolvedValue([]);
  mockListDocuments.mockResolvedValue([]);
  mockHydrateReviewDoc.mockReturnValue({ id: 'proposal-1', version: 2 });
  mockGetPdfFromR2.mockResolvedValue(null); // cache miss by default
  mockPutPdfToR2.mockResolvedValue(undefined);
  mockRenderPdf.mockResolvedValue(Buffer.from('%PDF-generated'));
});

describe('GET proposal PDF — param validation (UUID guard)', () => {
  it('returns 404 for a malformed (non-UUID) requestId, before any query/hydrate/render', async () => {
    const res = await callGet('not-a-uuid', RELATIONSHIP_ID);
    expect(res.status).toBe(404);
    // Rejected before touching the DB, the serializer, or the renderer.
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockHydrateReviewDoc).not.toHaveBeenCalled();
    expect(mockRenderPdf).not.toHaveBeenCalled();
  });

  it('returns 404 for a malformed (non-UUID) relationshipId, before any query/hydrate/render', async () => {
    const res = await callGet(REQUEST_ID, 'rel-missing');
    expect(res.status).toBe(404);
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
    expect(mockHydrateReviewDoc).not.toHaveBeenCalled();
    expect(mockRenderPdf).not.toHaveBeenCalled();
  });
});

describe('GET proposal PDF — auth & status gates', () => {
  it('returns 401 with no session (and touches no data)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('returns 404 when the request is missing', async () => {
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    expect((await callGet()).status).toBe(404);
  });

  it('returns 404 when the lens resolves to null (unauthorized)', async () => {
    mockResolveRequestLens.mockReturnValue(null);
    expect((await callGet()).status).toBe(404);
  });

  it('returns 404 when the relationship is not on the request', async () => {
    expect((await callGet(REQUEST_ID, OTHER_RELATIONSHIP_ID)).status).toBe(404);
  });

  it('returns 404 when there is no current proposal', async () => {
    mockFindCurrentByRelationship.mockResolvedValue(undefined);
    expect((await callGet()).status).toBe(404);
    expect(mockRenderPdf).not.toHaveBeenCalled();
  });

  it('returns 404 for a draft proposal (gate is status !== draft)', async () => {
    mockFindCurrentByRelationship.mockResolvedValue({ ...PROPOSAL, status: 'draft' });
    const res = await callGet();
    expect(res.status).toBe(404);
    expect(mockRenderPdf).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });
});

describe('GET proposal PDF — expert lens is forbidden (cannot reach the client PDF)', () => {
  it('returns 403 and never serializes or renders anything', async () => {
    mockResolveRequestLens.mockReturnValue({ lens: 'expert' });
    const res = await callGet();
    expect(res.status).toBe(403);
    // The money serializer, the renderer, and even the cache are never touched.
    expect(mockHydrateReviewDoc).not.toHaveBeenCalled();
    expect(mockRenderPdf).not.toHaveBeenCalled();
    expect(mockGetPdfFromR2).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });
});

describe('GET proposal PDF — audience invariant (money-safety)', () => {
  it('serializes with the CLIENT audience for the client lens', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const call = mockHydrateReviewDoc.mock.calls[0];
    expect(call?.[5]).toBe('client');
  });

  it('serializes with the CLIENT audience even for the ADMIN lens (never admin)', async () => {
    mockResolveRequestLens.mockReturnValue({ lens: 'admin' });
    const res = await callGet();
    expect(res.status).toBe(200);
    const call = mockHydrateReviewDoc.mock.calls[0];
    expect(call?.[5]).toBe('client');
    // Assert the forbidden audiences were never passed.
    expect(call?.[5]).not.toBe('admin');
    expect(call?.[5]).not.toBe('expert');
  });
});

describe('GET proposal PDF — analytics', () => {
  it('emits project_proposal_pdf_downloaded with audience=client for the client lens', async () => {
    await callGet();
    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('project_proposal_pdf_downloaded', {
      proposal_id: 'proposal-1',
      version: 2,
      audience: 'client',
      distinct_id: 'user-1',
    });
  });

  it('records audience=admin for the admin lens (downloader identity)', async () => {
    mockResolveRequestLens.mockReturnValue({ lens: 'admin' });
    await callGet();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'project_proposal_pdf_downloaded',
      expect.objectContaining({ audience: 'admin', distinct_id: 'user-1' })
    );
  });
});

describe('GET proposal PDF — read-through cache', () => {
  it('streams the stored bytes on a cache HIT (no render, no upload)', async () => {
    mockGetPdfFromR2.mockResolvedValue(new Uint8Array(Buffer.from('%PDF-cached')));
    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('Balo-Proposal-CRM-Cleanup-v2.pdf');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mockRenderPdf).not.toHaveBeenCalled();
    expect(mockHydrateReviewDoc).not.toHaveBeenCalled();
    expect(mockPutPdfToR2).not.toHaveBeenCalled();

    const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
    expect(body).toBe('%PDF-cached');
  });

  it('generates, uploads and streams on a cache MISS', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(mockRenderPdf).toHaveBeenCalledTimes(1);
    expect(mockPutPdfToR2).toHaveBeenCalledWith(
      'proposals/proposal-1/client.pdf',
      expect.anything()
    );
    expect(mockLog.info).toHaveBeenCalledWith('Proposal client PDF generated', expect.any(Object));
    const body = Buffer.from(await res.arrayBuffer()).toString('latin1');
    expect(body).toBe('%PDF-generated');
  });

  it('still returns 200 when the R2 upload fails (non-fatal, in-memory buffer streamed)', async () => {
    mockPutPdfToR2.mockRejectedValue(new Error('R2 down'));
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Proposal client PDF upload to R2 failed',
      expect.any(Object)
    );
  });

  it('regenerates (does not 500) when the cache READ throws a transient error', async () => {
    mockGetPdfFromR2.mockRejectedValue(new Error('transient blip'));
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(mockRenderPdf).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Proposal client PDF cache read failed; regenerating',
      expect.any(Object)
    );
  });
});

describe('GET proposal PDF — failure handling', () => {
  it('returns 500 when rendering throws', async () => {
    mockRenderPdf.mockRejectedValue(new Error('render exploded'));
    const res = await callGet();
    expect(res.status).toBe(500);
    expect(mockLog.error).toHaveBeenCalledWith(
      'Proposal client PDF generation failed',
      expect.any(Object)
    );
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });
});
