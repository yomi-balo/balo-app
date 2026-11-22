import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

vi.mock('@balo/db', () => ({
  proposalMilestonesRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalPaymentInstallmentsRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalDocumentsRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalClausesRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalsRepository: { findExpertOrgName: vi.fn().mockResolvedValue('Meridian Consulting') },
}));

const mockHydrate = vi.fn().mockReturnValue({ id: PROPOSAL_ID, audience: 'client' });
vi.mock('@/lib/project-request/proposal-audience-view', () => ({
  hydrateReviewDoc: (...a: unknown[]) => mockHydrate(...a),
}));

const mockRender = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));
vi.mock('@/lib/project-request/proposal/pdf/proposal-pdf-document', () => ({
  renderProposalPdfToBuffer: (...a: unknown[]) => mockRender(...a),
}));

const mockPut = vi.fn().mockResolvedValue(undefined);
const mockGet = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/storage/proposal-pdf', () => ({
  proposalPdfKey: (id: string) => `proposals/${id}/client-v2.pdf`,
  acceptedProposalPdfKey: (id: string) => `proposals/${id}/accepted.pdf`,
  getProposalPdfFromR2: (...a: unknown[]) => mockGet(...a),
  putProposalPdfToR2: (...a: unknown[]) => mockPut(...a),
}));

const { mockLogInfo } = vi.hoisted(() => ({ mockLogInfo: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  log: { info: mockLogInfo, warn: vi.fn(), error: vi.fn() },
}));

import {
  generateClientProposalPdf,
  ensureClientProposalPdf,
  freezeAcceptedProposalPdf,
  proposalPdfFileName,
} from './ensure-client-pdf';

const TARGET = {
  request: { title: 'CPQ', company: { name: 'Acme' } },
  relationship: { id: 'rel-1' },
  proposal: { id: PROPOSAL_ID, version: 3 },
} as never;

describe('generateClientProposalPdf', () => {
  beforeEach(() => vi.clearAllMocks());

  it('always hydrates with the CLIENT audience', async () => {
    await generateClientProposalPdf(TARGET);
    expect(mockHydrate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ audience: 'client' })
    );
    expect(mockRender).toHaveBeenCalledTimes(1);
  });
});

describe('ensureClientProposalPdf', () => {
  beforeEach(() => vi.clearAllMocks());

  it('force-writes the rendered bytes to the proposal PDF key', async () => {
    await ensureClientProposalPdf(TARGET);
    expect(mockPut).toHaveBeenCalledWith(
      `proposals/${PROPOSAL_ID}/client-v2.pdf`,
      new Uint8Array([1, 2, 3])
    );
  });
});

describe('freezeAcceptedProposalPdf', () => {
  const ACCEPTED_KEY = `proposals/${PROPOSAL_ID}/accepted.pdf`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(null);
    mockPut.mockResolvedValue(undefined);
    mockRender.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  it('renders once and writes once to the accepted key on a miss, returning the rendered bytes', async () => {
    const result = await freezeAcceptedProposalPdf(TARGET);

    expect(mockGet).toHaveBeenCalledWith(ACCEPTED_KEY);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith(ACCEPTED_KEY, new Uint8Array([1, 2, 3]));
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(mockLogInfo).toHaveBeenCalledWith('Accepted proposal PDF frozen', {
      proposalId: PROPOSAL_ID,
      relationshipId: 'rel-1',
      version: 3,
    });
  });

  it('returns the stored bytes on a hit with no render and no write', async () => {
    const stored = new Uint8Array([9, 9, 9]);
    mockGet.mockResolvedValue(stored);

    const result = await freezeAcceptedProposalPdf(TARGET);

    expect(result).toBe(stored);
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockLogInfo).not.toHaveBeenCalled();
  });

  it('rejects on a read error with no render and no write', async () => {
    mockGet.mockRejectedValue(new Error('r2 503'));

    await expect(freezeAcceptedProposalPdf(TARGET)).rejects.toThrow('r2 503');
    expect(mockRender).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('rejects when the write fails, never returning bytes it did not persist', async () => {
    mockPut.mockRejectedValue(new Error('put failed'));

    await expect(freezeAcceptedProposalPdf(TARGET)).rejects.toThrow('put failed');
    expect(mockLogInfo).not.toHaveBeenCalled();
  });
});

describe('proposalPdfFileName', () => {
  it('slugifies the title and appends the version', () => {
    expect(proposalPdfFileName('Salesforce CPQ!', 3)).toBe('Balo-Proposal-Salesforce-CPQ-v3.pdf');
  });

  it('falls back to a generic base for a symbol-only title', () => {
    expect(proposalPdfFileName('***', 1)).toBe('Balo-Proposal-proposal-v1.pdf');
  });
});
