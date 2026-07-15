import { describe, it, expect, vi, beforeEach } from 'vitest';

const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

vi.mock('@balo/db', () => ({
  proposalMilestonesRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalPaymentInstallmentsRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
  proposalDocumentsRepository: { listByProposal: vi.fn().mockResolvedValue([]) },
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
vi.mock('@/lib/storage/proposal-pdf', () => ({
  proposalPdfKey: (id: string) => `proposals/${id}/client.pdf`,
  putProposalPdfToR2: (...a: unknown[]) => mockPut(...a),
}));

import {
  generateClientProposalPdf,
  ensureClientProposalPdf,
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
    const audience = mockHydrate.mock.calls[0]?.[5];
    expect(audience).toBe('client');
    expect(mockRender).toHaveBeenCalledTimes(1);
  });
});

describe('ensureClientProposalPdf', () => {
  beforeEach(() => vi.clearAllMocks());

  it('force-writes the rendered bytes to the proposal PDF key', async () => {
    await ensureClientProposalPdf(TARGET);
    expect(mockPut).toHaveBeenCalledWith(
      `proposals/${PROPOSAL_ID}/client.pdf`,
      new Uint8Array([1, 2, 3])
    );
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
