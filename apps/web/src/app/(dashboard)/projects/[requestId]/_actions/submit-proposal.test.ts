import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const PROPOSAL_ID = 'c0000000-0000-4000-8000-000000000003';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';
const CLIENT_USER_ID = 'e0000000-0000-4000-8000-000000000005';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const mockSanitizeOverview = vi.fn();
const mockSanitizeProject = vi.fn();
vi.mock('@/lib/sanitize/project-html', () => ({
  sanitizeProposalOverviewHtml: (...a: unknown[]) => mockSanitizeOverview(...a),
  sanitizeProjectHtml: (...a: unknown[]) => mockSanitizeProject(...a),
}));

const {
  mockFindById,
  mockListMilestones,
  mockListInstallments,
  mockUpdateDraft,
  mockSetMilestones,
  mockSetInstallments,
  mockPromote,
  mockTransitionRequest,
  mockInstallmentsSumTo100,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
  ProposalNotDraftError,
  ProposalCoherenceError,
} = vi.hoisted(() => {
  class InvalidProposalTransitionError extends Error {}
  class InvalidRelationshipTransitionError extends Error {}
  class InvalidStatusTransitionError extends Error {}
  class ProposalNotDraftError extends Error {}
  class ProposalCoherenceError extends Error {
    public readonly rule: string;
    constructor(rule: string, message?: string) {
      super(message ?? rule);
      this.name = 'ProposalCoherenceError';
      this.rule = rule;
    }
  }
  return {
    mockFindById: vi.fn(),
    mockListMilestones: vi.fn(),
    mockListInstallments: vi.fn(),
    mockUpdateDraft: vi.fn(),
    mockSetMilestones: vi.fn(),
    mockSetInstallments: vi.fn(),
    mockPromote: vi.fn(),
    mockTransitionRequest: vi.fn(),
    mockInstallmentsSumTo100: vi.fn(),
    InvalidProposalTransitionError,
    InvalidRelationshipTransitionError,
    InvalidStatusTransitionError,
    ProposalNotDraftError,
    ProposalCoherenceError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    updateDraft: (...a: unknown[]) => mockUpdateDraft(...a),
    promoteToSubmit: (...a: unknown[]) => mockPromote(...a),
  },
  proposalMilestonesRepository: {
    listByProposal: (...a: unknown[]) => mockListMilestones(...a),
    setForProposal: (...a: unknown[]) => mockSetMilestones(...a),
  },
  proposalPaymentInstallmentsRepository: {
    listByProposal: (...a: unknown[]) => mockListInstallments(...a),
    setForProposal: (...a: unknown[]) => mockSetInstallments(...a),
  },
  projectRequestsRepository: {
    transitionStatus: (...a: unknown[]) => mockTransitionRequest(...a),
  },
  installmentsSumTo100: (...a: unknown[]) => mockInstallmentsSumTo100(...a),
  // Real pure helper (BAL-294) — sum of milestone estimated_minutes; null counts as 0.
  sumEstimatedMinutes: (milestones: Array<{ estimatedMinutes: number | null }>) =>
    milestones.reduce((s, m) => s + (m.estimatedMinutes ?? 0), 0),
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  InvalidStatusTransitionError,
  ProposalNotDraftError,
  ProposalCoherenceError,
}));

import { submitProposalAction } from './submit-proposal';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert', firstName: 'Ada', lastName: 'Lovelace' };

const VALID_INPUT = { requestId: REQUEST_ID, relationshipId: REL_ID, proposalId: PROPOSAL_ID };

const DRAFT = {
  id: PROPOSAL_ID,
  status: 'draft',
  relationshipId: REL_ID,
  isCurrent: true,
  overview: '<p>scope</p>',
  pricingMethod: 'fixed',
  priceCents: 500000,
  currency: 'aud',
  timeframeWeeks: 6,
  exclusions: null,
  depositCents: null,
  rateCents: null,
  cadence: null,
};

const MILESTONES = [
  {
    title: 'M1',
    descriptionHtml: '<p>d</p>',
    acceptanceCriteria: 'done',
    valueCents: 500000,
    estimatedMinutes: null,
  },
];
const INSTALLMENTS = [{ label: 'Upfront', pct: 100 }];

function accessOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ctx: { lens: 'expert' },
    relationship: { expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_requested' },
    request: { status: 'proposal_requested', title: 'CPQ implementation' },
    recipient: { role: 'client', userId: CLIENT_USER_ID },
    ...overrides,
  };
}

describe('submitProposalAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(accessOk());
    mockFindById.mockResolvedValue({ ...DRAFT });
    mockListMilestones.mockResolvedValue(MILESTONES);
    mockListInstallments.mockResolvedValue(INSTALLMENTS);
    mockInstallmentsSumTo100.mockReturnValue(true);
    mockSanitizeOverview.mockImplementation((html: string) => html);
    mockSanitizeProject.mockImplementation((html: string) => html);
    mockUpdateDraft.mockResolvedValue({ id: PROPOSAL_ID });
    mockSetMilestones.mockResolvedValue([]);
    mockSetInstallments.mockResolvedValue([]);
    mockPromote.mockResolvedValue({ id: PROPOSAL_ID });
    mockTransitionRequest.mockResolvedValue({ id: REQUEST_ID });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await submitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
  });

  it('rejects invalid input', async () => {
    expect(await submitProposalAction({ ...VALID_INPUT, proposalId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });

  it('blocks a non-expert (client) lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'client' } }));
    expect(await submitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the expert can submit a proposal.',
    });
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('rejects a draft that is not live / not a draft / wrong relationship', async () => {
    mockFindById.mockResolvedValue({ ...DRAFT, status: 'submitted' });
    expect(await submitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be submitted.',
    });
  });

  describe('readiness gates (server-side re-validation)', () => {
    it('rejects an empty overview', async () => {
      mockFindById.mockResolvedValue({ ...DRAFT, overview: '<p></p>' });
      const result = await submitProposalAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'Add an overview before submitting.' });
      expect(mockPromote).not.toHaveBeenCalled();
    });

    it('rejects when there are no milestones', async () => {
      mockListMilestones.mockResolvedValue([]);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result.success).toBe(false);
      expect(mockPromote).not.toHaveBeenCalled();
    });

    it('rejects an untitled milestone', async () => {
      mockListMilestones.mockResolvedValue([{ ...MILESTONES[0], title: '   ' }]);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'Every milestone needs a title.' });
    });

    it('rejects Fixed when installments do not sum to 100', async () => {
      mockInstallmentsSumTo100.mockReturnValue(false);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Payment installments must total 100%.',
      });
      expect(mockPromote).not.toHaveBeenCalled();
    });

    it('rejects Fixed when a milestone has no value', async () => {
      mockListMilestones.mockResolvedValue([{ ...MILESTONES[0], valueCents: null }]);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'Every milestone needs a value.' });
    });

    it('accepts T&M with deposit + rate, effort on every milestone, and no installments', async () => {
      mockFindById.mockResolvedValue({
        ...DRAFT,
        pricingMethod: 'tm',
        depositCents: 100000,
        rateCents: 20000,
      });
      mockListMilestones.mockResolvedValue([{ ...MILESTONES[0], estimatedMinutes: 120 }]);
      mockListInstallments.mockResolvedValue([]);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result.success).toBe(true);
      expect(mockPromote).toHaveBeenCalledWith({ proposalId: PROPOSAL_ID, relationshipId: REL_ID });
    });

    it('rejects T&M when a milestone is missing an effort estimate (BAL-294)', async () => {
      mockFindById.mockResolvedValue({
        ...DRAFT,
        pricingMethod: 'tm',
        depositCents: 100000,
        rateCents: 20000,
      });
      mockListMilestones.mockResolvedValue([{ ...MILESTONES[0], estimatedMinutes: null }]);
      mockListInstallments.mockResolvedValue([]);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Every milestone needs an effort estimate.',
      });
      expect(mockPromote).not.toHaveBeenCalled();
    });

    it('rejects T&M missing deposit/rate', async () => {
      mockFindById.mockResolvedValue({ ...DRAFT, pricingMethod: 'tm' });
      mockListInstallments.mockResolvedValue([]);
      const result = await submitProposalAction(VALID_INPUT);
      expect(result).toEqual({
        success: false,
        error: 'Add a deposit and an hourly rate before submitting.',
      });
    });
  });

  it('sanitises overview + each milestone description before persisting, then promotes', async () => {
    mockSanitizeOverview.mockReturnValue('<p>clean</p>');
    mockSanitizeProject.mockReturnValue('<p>cleanm</p>');
    const result = await submitProposalAction(VALID_INPUT);

    expect(result).toEqual({
      success: true,
      proposalId: PROPOSAL_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      transitioned: true,
      analytics: {
        priceCents: 500000,
        currency: 'aud',
        totalEstimatedMinutes: 0, // Fixed → effort nulled
        pricingMethod: 'fixed',
        milestoneCount: 1,
      },
    });

    // sanitise the overview with the WIDENED sanitiser
    expect(mockSanitizeOverview).toHaveBeenCalledWith('<p>scope</p>');
    // sanitise each milestone description with the brief sanitiser
    expect(mockSanitizeProject).toHaveBeenCalledWith('<p>d</p>');
    // persisted the cleaned overview
    expect(mockUpdateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PROPOSAL_ID, overview: '<p>clean</p>' })
    );
    expect(mockSetMilestones).toHaveBeenCalledWith({
      proposalId: PROPOSAL_ID,
      milestones: [
        {
          title: 'M1',
          descriptionHtml: '<p>cleanm</p>',
          acceptanceCriteria: 'done',
          valueCents: 500000,
          estimatedMinutes: null,
        },
      ],
    });
  });

  it('persists (updateDraft + both setForProposal) BEFORE promoteToSubmit', async () => {
    const order: string[] = [];
    mockUpdateDraft.mockImplementation(async () => {
      order.push('updateDraft');
      return { id: PROPOSAL_ID };
    });
    mockSetMilestones.mockImplementation(async () => {
      order.push('setMilestones');
      return [];
    });
    mockSetInstallments.mockImplementation(async () => {
      order.push('setInstallments');
      return [];
    });
    mockPromote.mockImplementation(async () => {
      order.push('promote');
      return { id: PROPOSAL_ID };
    });

    await submitProposalAction(VALID_INPUT);

    expect(order.indexOf('promote')).toBeGreaterThan(order.indexOf('updateDraft'));
    expect(order.indexOf('promote')).toBeGreaterThan(order.indexOf('setMilestones'));
    expect(order.indexOf('promote')).toBeGreaterThan(order.indexOf('setInstallments'));
  });

  it('maps a TOCTOU updateDraft (ProposalNotDraftError) to stale copy', async () => {
    // A concurrent submit flips the row out of `draft` between findById and the
    // sanitise→persist updateDraft → the repo throws ProposalNotDraftError.
    mockUpdateDraft.mockRejectedValue(new ProposalNotDraftError('submitted'));
    expect(await submitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be submitted.',
    });
    // Never reached promotion.
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('maps a stale promote (proposal transition) to stale copy', async () => {
    mockPromote.mockRejectedValue(new InvalidProposalTransitionError());
    expect(await submitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be submitted.',
    });
  });

  it('maps a stale promote (relationship transition) to stale copy', async () => {
    mockPromote.mockRejectedValue(new InvalidRelationshipTransitionError());
    expect(await submitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal can no longer be submitted.',
    });
  });

  it('maps a repo coherence rejection to generic copy + an analytics coherence payload', async () => {
    // The @balo/db guard (defence-in-depth) throws on incoherent committed terms.
    mockPromote.mockRejectedValue(new ProposalCoherenceError('installments_not_100'));
    const result = await submitProposalAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      error:
        "This proposal's pricing is incomplete or inconsistent. Refresh and re-check the pricing details before submitting.",
      coherence: {
        rule: 'installments_not_100',
        pricingMethod: 'fixed',
        proposalId: PROPOSAL_ID,
        relationshipId: REL_ID,
      },
    });
    // The raw rule must NEVER leak into the user-facing `error` string.
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).not.toContain('installments_not_100');
    expect(log.warn).toHaveBeenCalledWith('Proposal coherence rejected', {
      rule: 'installments_not_100',
      pricingMethod: 'fixed',
      proposalId: PROPOSAL_ID,
      relationshipId: REL_ID,
    });
  });

  it('tolerates a benign request-aggregate race (InvalidStatusTransitionError)', async () => {
    mockTransitionRequest.mockRejectedValue(new InvalidStatusTransitionError());
    const result = await submitProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Proposal submit request transition skipped (already advanced)',
      expect.any(Object)
    );
  });

  it('does not advance the request aggregate when it is already past proposal_requested', async () => {
    mockResolveAccess.mockResolvedValue(
      accessOk({ request: { status: 'proposal_submitted', title: 'CPQ implementation' } })
    );
    const result = await submitProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.transitioned).toBe(false);
    expect(mockTransitionRequest).not.toHaveBeenCalled();
  });

  it('publishes the client notification with recipientId + expertName + title', async () => {
    await submitProposalAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith('project.proposal_submitted', {
      correlationId: PROPOSAL_ID,
      projectRequestId: REQUEST_ID,
      relationshipId: REL_ID,
      recipientId: CLIENT_USER_ID,
      expertName: 'Ada Lovelace',
      title: 'CPQ implementation',
    });
  });

  it('rejects when the overview is emptied by the sanitiser', async () => {
    mockSanitizeOverview.mockReturnValue('');
    const result = await submitProposalAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'Add an overview before submitting.' });
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('logs the business event after promotion', async () => {
    await submitProposalAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith('Proposal submitted', expect.any(Object));
  });
});
