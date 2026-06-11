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

const {
  mockFindCurrent,
  mockCreateDraft,
  mockUpdateDraft,
  mockSetMilestones,
  mockSetInstallments,
  ProposalNotDraftError,
} = vi.hoisted(() => {
  class ProposalNotDraftError extends Error {
    constructor(public readonly status: string | null) {
      super('not a draft');
      this.name = 'ProposalNotDraftError';
    }
  }
  return {
    mockFindCurrent: vi.fn(),
    mockCreateDraft: vi.fn(),
    mockUpdateDraft: vi.fn(),
    mockSetMilestones: vi.fn(),
    mockSetInstallments: vi.fn(),
    ProposalNotDraftError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findCurrentByRelationship: (...a: unknown[]) => mockFindCurrent(...a),
    createDraft: (...a: unknown[]) => mockCreateDraft(...a),
    updateDraft: (...a: unknown[]) => mockUpdateDraft(...a),
  },
  proposalMilestonesRepository: { setForProposal: (...a: unknown[]) => mockSetMilestones(...a) },
  proposalPaymentInstallmentsRepository: {
    setForProposal: (...a: unknown[]) => mockSetInstallments(...a),
  },
  ProposalNotDraftError,
}));

import { saveProposalDraftAction } from './save-proposal-draft';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert', firstName: 'Ada', lastName: 'L' };

const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  overview: '<p>scope</p>',
  pricingMethod: 'fixed' as const,
  priceCents: 0,
  milestones: [{ title: 'M1', descriptionHtml: '<p>d</p>', valueCents: 1000 }],
  installments: [{ label: 'Upfront', pct: 100 }],
};

describe('saveProposalDraftAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'expert' } });
    mockFindCurrent.mockResolvedValue(undefined);
    mockCreateDraft.mockResolvedValue({ id: PROPOSAL_ID });
    mockUpdateDraft.mockResolvedValue({ id: PROPOSAL_ID });
    mockSetMilestones.mockResolvedValue([]);
    mockSetInstallments.mockResolvedValue([]);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects invalid input', async () => {
    const result = await saveProposalDraftAction({ ...VALID_INPUT, priceCents: -1 });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'No access.' });
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('blocks a non-expert (client) lens', async () => {
    mockResolveAccess.mockResolvedValue({ ok: true, ctx: { lens: 'client' } });
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Only the expert can build a proposal.' });
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('creates a draft when none exists, then persists children', async () => {
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({ success: true, proposalId: PROPOSAL_ID });
    expect(mockCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        relationshipId: REL_ID,
        overview: '<p>scope</p>',
        pricingMethod: 'fixed',
      })
    );
    expect(mockUpdateDraft).not.toHaveBeenCalled();
    expect(mockSetMilestones).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      milestones: [
        { title: 'M1', descriptionHtml: '<p>d</p>', acceptanceCriteria: null, valueCents: 1000 },
      ],
    });
    expect(mockSetInstallments).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      installments: [{ label: 'Upfront', pct: 100 }],
    });
  });

  it('updates the existing draft in place when one exists', async () => {
    mockFindCurrent.mockResolvedValue({ id: PROPOSAL_ID });
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({ success: true, proposalId: PROPOSAL_ID });
    expect(mockUpdateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, overview: '<p>scope</p>' })
    );
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('warns and returns stale copy when updateDraft hits a non-draft', async () => {
    mockFindCurrent.mockResolvedValue({ id: PROPOSAL_ID });
    mockUpdateDraft.mockRejectedValue(new ProposalNotDraftError('submitted'));
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This proposal can no longer be edited.' });
    expect(log.warn).toHaveBeenCalledWith(
      'Proposal draft autosave rejected (no longer a draft)',
      expect.any(Object)
    );
  });

  it('maps an unexpected repo failure to generic copy and logs error', async () => {
    mockCreateDraft.mockRejectedValue(new Error('db down'));
    const result = await saveProposalDraftAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: "Couldn't save your draft. Please try again.",
    });
    expect(log.error).toHaveBeenCalledWith('Failed to save proposal draft', expect.any(Object));
  });
});
