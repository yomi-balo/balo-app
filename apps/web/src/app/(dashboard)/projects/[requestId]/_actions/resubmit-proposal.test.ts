import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const V1_ID = 'c0000000-0000-4000-8000-000000000003';
const V2_ID = 'f0000000-0000-4000-8000-000000000006';
const EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';
const CLIENT_USER_ID = 'e0000000-0000-4000-8000-000000000005';
const UPLOADER_ID = 'a1000000-0000-4000-8000-000000000007';

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

const mockCopyObject = vi.fn();
const mockGenerateKey = vi.fn();
vi.mock('@/lib/storage/proposal-document', () => ({
  copyProposalDocumentObject: (...a: unknown[]) => mockCopyObject(...a),
  generateProposalDocumentKey: (...a: unknown[]) => mockGenerateKey(...a),
}));

const {
  mockFindCurrent,
  mockResubmit,
  mockSetMilestones,
  mockSetInstallments,
  mockListDocuments,
  mockAddDocument,
  mockTransitionRequest,
  mockAdvanceRelationship,
  mockInstallmentsSumTo100,
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  ProposalCoherenceError,
} = vi.hoisted(() => {
  class InvalidProposalTransitionError extends Error {}
  class InvalidRelationshipTransitionError extends Error {}
  class ProposalCoherenceError extends Error {
    public readonly rule: string;
    constructor(rule: string, message?: string) {
      super(message ?? rule);
      this.name = 'ProposalCoherenceError';
      this.rule = rule;
    }
  }
  return {
    mockFindCurrent: vi.fn(),
    mockResubmit: vi.fn(),
    // The action no longer calls the child `setForProposal` repos (children are now
    // written inside `resubmit`'s transaction). These mocks exist only to assert
    // they are NEVER called.
    mockSetMilestones: vi.fn(),
    mockSetInstallments: vi.fn(),
    mockListDocuments: vi.fn(),
    mockAddDocument: vi.fn(),
    mockTransitionRequest: vi.fn(),
    mockAdvanceRelationship: vi.fn(),
    mockInstallmentsSumTo100: vi.fn(),
    InvalidProposalTransitionError,
    InvalidRelationshipTransitionError,
    ProposalCoherenceError,
  };
});

vi.mock('@balo/db', () => ({
  proposalsRepository: {
    findCurrentByRelationship: (...a: unknown[]) => mockFindCurrent(...a),
    resubmit: (...a: unknown[]) => mockResubmit(...a),
  },
  proposalMilestonesRepository: {
    setForProposal: (...a: unknown[]) => mockSetMilestones(...a),
  },
  proposalPaymentInstallmentsRepository: {
    setForProposal: (...a: unknown[]) => mockSetInstallments(...a),
  },
  proposalDocumentsRepository: {
    listByProposal: (...a: unknown[]) => mockListDocuments(...a),
    addDocument: (...a: unknown[]) => mockAddDocument(...a),
  },
  projectRequestsRepository: {
    transitionStatus: (...a: unknown[]) => mockTransitionRequest(...a),
  },
  // The shared readiness helper imports installmentsSumTo100 from @balo/db.
  installmentsSumTo100: (...a: unknown[]) => mockInstallmentsSumTo100(...a),
  advanceRelationshipStatus: (...a: unknown[]) => mockAdvanceRelationship(...a),
  InvalidProposalTransitionError,
  InvalidRelationshipTransitionError,
  ProposalCoherenceError,
}));

import { resubmitProposalAction } from './resubmit-proposal';
import { log } from '@/lib/logging';

const USER = { id: 'user-expert', firstName: 'Ada', lastName: 'Lovelace' };

const VALID_INPUT = {
  requestId: REQUEST_ID,
  relationshipId: REL_ID,
  fromProposalId: V1_ID,
  overview: '<p>scope</p>',
  pricingMethod: 'fixed' as const,
  priceCents: 500000,
  currency: 'aud',
  timeframeWeeks: 6,
  milestones: [
    { title: 'M1', descriptionHtml: '<p>d</p>', acceptanceCriteria: 'done', valueCents: 500000 },
  ],
  installments: [{ label: 'Upfront', pct: 100 }],
};

const CURRENT_V1 = {
  id: V1_ID,
  status: 'changes_requested',
  relationshipId: REL_ID,
  isCurrent: true,
};

const V2_ROW = {
  id: V2_ID,
  version: 2,
  priceCents: 500000,
  currency: 'aud',
};

function accessOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    ctx: { lens: 'expert' },
    relationship: { expertProfileId: EXPERT_PROFILE_ID, status: 'proposal_submitted' },
    request: { status: 'proposal_submitted', title: 'CPQ implementation' },
    recipient: { role: 'client', userId: CLIENT_USER_ID },
    ...overrides,
  };
}

describe('resubmitProposalAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(accessOk());
    mockFindCurrent.mockResolvedValue({ ...CURRENT_V1 });
    mockInstallmentsSumTo100.mockReturnValue(true);
    mockSanitizeOverview.mockImplementation((html: string) => html);
    mockSanitizeProject.mockImplementation((html: string) => html);
    mockResubmit.mockResolvedValue({ ...V2_ROW });
    mockSetMilestones.mockResolvedValue([]);
    mockSetInstallments.mockResolvedValue([]);
    mockListDocuments.mockResolvedValue([]);
    mockGenerateKey.mockReturnValue('proposal-documents/v2/uploader/fresh-uuid');
    mockCopyObject.mockResolvedValue(undefined);
    mockAddDocument.mockResolvedValue({ id: 'doc-2' });
    mockTransitionRequest.mockResolvedValue({ id: REQUEST_ID });
    mockPublish.mockResolvedValue(undefined);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
  });

  it('rejects invalid input', async () => {
    expect(await resubmitProposalAction({ ...VALID_INPUT, fromProposalId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });

  it('blocks a non-expert (client) lens', async () => {
    mockResolveAccess.mockResolvedValue(accessOk({ ctx: { lens: 'client' } }));
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Only the expert can resubmit a proposal.',
    });
    expect(mockResubmit).not.toHaveBeenCalled();
  });

  it('bubbles the access guard error', async () => {
    mockResolveAccess.mockResolvedValue({
      ok: false,
      error: 'You do not have access to this conversation.',
    });
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(mockResubmit).not.toHaveBeenCalled();
  });

  it('rejects when there is no current proposal (stale)', async () => {
    mockFindCurrent.mockResolvedValue(undefined);
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
    expect(mockResubmit).not.toHaveBeenCalled();
  });

  it('rejects when the current proposal is not changes_requested (stale)', async () => {
    mockFindCurrent.mockResolvedValue({ ...CURRENT_V1, status: 'submitted' });
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
    expect(mockResubmit).not.toHaveBeenCalled();
  });

  it('rejects when the current proposal id differs from the claimed fromProposalId (stale)', async () => {
    mockFindCurrent.mockResolvedValue({ ...CURRENT_V1, id: 'a-different-id' });
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
    expect(mockResubmit).not.toHaveBeenCalled();
  });

  describe('readiness gates (server-side re-validation)', () => {
    it('rejects an empty overview (post-sanitise)', async () => {
      mockSanitizeOverview.mockReturnValue('');
      const result = await resubmitProposalAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'Add an overview before submitting.' });
      expect(mockResubmit).not.toHaveBeenCalled();
    });

    it('rejects when there are no milestones', async () => {
      const result = await resubmitProposalAction({ ...VALID_INPUT, milestones: [] });
      expect(result.success).toBe(false);
      expect(mockResubmit).not.toHaveBeenCalled();
    });

    it('rejects Fixed when installments do not sum to 100', async () => {
      mockInstallmentsSumTo100.mockReturnValue(false);
      const result = await resubmitProposalAction(VALID_INPUT);
      expect(result).toEqual({ success: false, error: 'Payment installments must total 100%.' });
      expect(mockResubmit).not.toHaveBeenCalled();
    });

    it('rejects T&M missing deposit/rate', async () => {
      const result = await resubmitProposalAction({
        ...VALID_INPUT,
        pricingMethod: 'tm',
        installments: [],
        milestones: [{ title: 'M1', valueCents: null }],
      });
      expect(result).toEqual({
        success: false,
        error: 'Add a deposit and an hourly rate before submitting.',
      });
      expect(mockResubmit).not.toHaveBeenCalled();
    });

    it('rejects T&M when a milestone is missing an effort estimate (BAL-294)', async () => {
      const result = await resubmitProposalAction({
        ...VALID_INPUT,
        pricingMethod: 'tm',
        depositCents: 100000,
        rateCents: 20000,
        installments: [],
        milestones: [{ title: 'M1', valueCents: null, estimatedMinutes: null }],
      });
      expect(result).toEqual({
        success: false,
        error: 'Every milestone needs an effort estimate.',
      });
      expect(mockResubmit).not.toHaveBeenCalled();
    });
  });

  it('sanitises overview + each milestone description before the version bump', async () => {
    mockSanitizeOverview.mockReturnValue('<p>clean</p>');
    mockSanitizeProject.mockReturnValue('<p>cleanm</p>');
    const result = await resubmitProposalAction(VALID_INPUT);

    expect(result).toEqual({
      success: true,
      proposalId: V2_ID,
      version: 2,
      expertProfileId: EXPERT_PROFILE_ID,
      analytics: { priceCents: 500000, currency: 'aud' },
    });

    expect(mockSanitizeOverview).toHaveBeenCalledWith('<p>scope</p>');
    expect(mockSanitizeProject).toHaveBeenCalledWith('<p>d</p>');

    // The cleaned overview AND the cleaned milestone/installment sets are passed to
    // `resubmit` (which writes the children atomically with the header). The action
    // no longer calls the child `setForProposal` repos.
    expect(mockResubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        relationshipId: REL_ID,
        overview: '<p>clean</p>',
        milestones: [
          {
            title: 'M1',
            descriptionHtml: '<p>cleanm</p>',
            acceptanceCriteria: 'done',
            valueCents: 500000,
            estimatedMinutes: null,
          },
        ],
        installments: [{ label: 'Upfront', pct: 100 }],
      })
    );
    expect(mockSetMilestones).not.toHaveBeenCalled();
    expect(mockSetInstallments).not.toHaveBeenCalled();
  });

  it('returns the relationship expert profile id (analytics expert_id) on success', async () => {
    const result = await resubmitProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.expertProfileId).toBe(EXPERT_PROFILE_ID);
    }
  });

  it('executes the repo calls in order: resubmit (children atomic) → doc carryover', async () => {
    mockListDocuments.mockResolvedValue([
      {
        id: 'doc-1',
        r2Key: 'proposal-documents/v1/uploader/old-uuid',
        fileName: 'spec.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        kind: 'attachment',
        uploadedByUserId: UPLOADER_ID,
      },
    ]);

    const order: string[] = [];
    mockResubmit.mockImplementation(async () => {
      order.push('resubmit');
      return { ...V2_ROW };
    });
    mockCopyObject.mockImplementation(async () => {
      order.push('copyObject');
    });
    mockAddDocument.mockImplementation(async () => {
      order.push('addDocument');
      return { id: 'doc-2' };
    });

    await resubmitProposalAction(VALID_INPUT);

    // Children are written inside resubmit's transaction; doc carryover runs after.
    expect(order).toEqual(['resubmit', 'copyObject', 'addDocument']);
    expect(mockSetMilestones).not.toHaveBeenCalled();
    expect(mockSetInstallments).not.toHaveBeenCalled();

    // Carryover copies the source object to a FRESH key, then registers it on v2.
    expect(mockGenerateKey).toHaveBeenCalledWith(V2_ID, UPLOADER_ID);
    expect(mockCopyObject).toHaveBeenCalledWith(
      'proposal-documents/v1/uploader/old-uuid',
      'proposal-documents/v2/uploader/fresh-uuid'
    );
    expect(mockAddDocument).toHaveBeenCalledWith({
      proposalId: V2_ID,
      r2Key: 'proposal-documents/v2/uploader/fresh-uuid',
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1234,
      kind: 'attachment',
      uploadedByUserId: UPLOADER_ID,
    });
  });

  it('continues (warn + skip) when a document copy fails — the resubmit still succeeds', async () => {
    mockListDocuments.mockResolvedValue([
      {
        id: 'doc-1',
        r2Key: 'proposal-documents/v1/uploader/old-uuid',
        fileName: 'spec.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        kind: 'attachment',
        uploadedByUserId: UPLOADER_ID,
      },
    ]);
    mockCopyObject.mockRejectedValue(new Error('R2 unreachable'));

    const result = await resubmitProposalAction(VALID_INPUT);

    // The action still succeeds — a missing attachment must not fail the resubmit.
    expect(result.success).toBe(true);
    // Header + children were already committed atomically by resubmit (the action
    // does not call the child setForProposal repos).
    expect(mockResubmit).toHaveBeenCalledTimes(1);
    expect(mockSetMilestones).not.toHaveBeenCalled();
    expect(mockSetInstallments).not.toHaveBeenCalled();
    // The failed copy was warn-logged and skipped (no addDocument).
    expect(mockAddDocument).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Proposal document carryover failed (skipped)',
      expect.any(Object)
    );
  });

  it('publishes the client notification with the versioned correlationId + recipientId', async () => {
    await resubmitProposalAction(VALID_INPUT);
    expect(mockPublish).toHaveBeenCalledWith('project.proposal_resubmitted', {
      correlationId: `${V2_ID}--v2`,
      projectRequestId: REQUEST_ID,
      relationshipId: REL_ID,
      recipientId: CLIENT_USER_ID,
      expertName: 'Ada Lovelace',
      projectTitle: 'CPQ implementation',
      version: 2,
      priceCents: 500000,
      currency: 'aud',
    });
  });

  it('does NOT advance the relationship or the request aggregate', async () => {
    await resubmitProposalAction(VALID_INPUT);
    expect(mockAdvanceRelationship).not.toHaveBeenCalled();
    expect(mockTransitionRequest).not.toHaveBeenCalled();
  });

  it('maps a stale resubmit (proposal transition) to stale copy', async () => {
    mockResubmit.mockRejectedValue(new InvalidProposalTransitionError());
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
  });

  it('maps a stale resubmit (relationship transition) to stale copy', async () => {
    mockResubmit.mockRejectedValue(new InvalidRelationshipTransitionError());
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'This proposal has already been resubmitted. Refresh to continue.',
    });
  });

  it('maps a repo coherence rejection to generic copy + an analytics coherence payload', async () => {
    mockResubmit.mockRejectedValue(new ProposalCoherenceError('installments_not_100'));
    const result = await resubmitProposalAction(VALID_INPUT);

    expect(result).toEqual({
      success: false,
      error:
        "This proposal's pricing is incomplete or inconsistent. Refresh and re-check the pricing details before resubmitting.",
      coherence: {
        rule: 'installments_not_100',
        pricingMethod: 'fixed',
        proposalId: V1_ID,
        relationshipId: REL_ID,
      },
    });
    if (!result.success) expect(result.error).not.toContain('installments_not_100');
    expect(log.warn).toHaveBeenCalledWith('Proposal coherence rejected', {
      rule: 'installments_not_100',
      pricingMethod: 'fixed',
      proposalId: V1_ID,
      relationshipId: REL_ID,
    });
  });

  it('maps an unexpected failure to the generic error and logs it (outer catch)', async () => {
    mockResubmit.mockRejectedValue(new Error('db down'));
    expect(await resubmitProposalAction(VALID_INPUT)).toEqual({
      success: false,
      error: 'Could not resubmit your proposal. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith('Resubmit proposal failed', expect.any(Object));
  });

  it('logs the business event after the version bump', async () => {
    await resubmitProposalAction(VALID_INPUT);
    expect(log.info).toHaveBeenCalledWith('Proposal resubmitted', expect.any(Object));
  });

  it('does not fail the action when the notification publish rejects', async () => {
    mockPublish.mockRejectedValue(new Error('engine down'));
    const result = await resubmitProposalAction(VALID_INPUT);
    expect(result.success).toBe(true);
  });
});
