import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type {
  ProjectRequestWithRelations,
  Proposal,
  ProposalMilestone,
  ProposalPaymentInstallment,
  ProposalDocument,
} from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

// `proposal-composer-state` (reached through the real module graph) is pure; the
// composer itself is stubbed below so we assert the props the page hands it, not
// the composer internals.
vi.mock('server-only', () => ({}));

// ── Seams the page composes (mirrors the BAL-247/251 RSC page-test precedent) ──
const {
  mockFindByIdWithRelations,
  mockFindCurrentByRelationship,
  mockListMilestones,
  mockListInstallments,
  mockListDocuments,
  mockGetCurrentUser,
  mockNotFound,
  mockRedirect,
  mockResolveRequestLens,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockFindByIdWithRelations: vi.fn(),
  mockFindCurrentByRelationship: vi.fn(),
  mockListMilestones: vi.fn(),
  mockListInstallments: vi.fn(),
  mockListDocuments: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  // notFound()/redirect() must THROW so control flow stops, exactly like Next.
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockResolveRequestLens: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectRequestsRepository: { findByIdWithRelations: mockFindByIdWithRelations },
  proposalsRepository: { findCurrentByRelationship: mockFindCurrentByRelationship },
  proposalMilestonesRepository: { listByProposal: mockListMilestones },
  proposalPaymentInstallmentsRepository: { listByProposal: mockListInstallments },
  proposalDocumentsRepository: { listByProposal: mockListDocuments },
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/logging', () => ({ log: { warn: mockLogWarn, error: mockLogError } }));
vi.mock('@/lib/project-request/resolve-request-lens', () => ({
  resolveRequestLens: (...args: unknown[]) => mockResolveRequestLens(...args),
}));

// Stub the composer so we assert the *props* the loader serialises, never the
// composer's own (separately-tested) internals.
const mockComposer = vi.hoisted(() => vi.fn());
vi.mock('@/components/balo/project-request/proposal/proposal-composer', () => ({
  ProposalComposer: (props: unknown) => {
    mockComposer(props);
    return <div data-testid="composer-stub" />;
  },
}));

import ProposalComposerPage from './page';

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-1';
const OTHER_RELATIONSHIP_ID = 'rel-2';
const COMPANY_ID = 'company-1';
const EXPERT_PROFILE_ID = 'expert-1';
const PROPOSAL_ID = 'prop-1';
const REQUEST_TITLE = 'CPQ implementation';

function request(
  overrides: Partial<ProjectRequestWithRelations> = {}
): ProjectRequestWithRelations {
  return {
    id: REQUEST_ID,
    companyId: COMPANY_ID,
    expertProfileId: null,
    createdByUserId: 'user-client',
    sendTo: 'match',
    status: 'proposal_requested',
    source: 'manual',
    title: REQUEST_TITLE,
    description: '<p>Brief</p>',
    budgetMinCents: null,
    budgetMaxCents: null,
    budgetCurrency: 'aud',
    timeline: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    createdByUser: {
      id: 'user-client',
      firstName: 'Dana',
      lastName: 'Whitfield',
      email: 'dana@northwind.test',
    },
    tags: [],
    products: [],
    documents: [],
    relationships: [
      {
        id: RELATIONSHIP_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        status: 'proposal_requested',
      },
    ],
    ...overrides,
  } as ProjectRequestWithRelations;
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-expert',
    email: 'expert@example.com',
    firstName: 'Priya',
    lastName: 'Nair',
    avatarUrl: null,
    activeMode: 'expert',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-2',
    companyName: null,
    companyRole: null,
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  } as SessionUser;
}

/** The expert lens that opens the composer. */
function expertCtx(relationshipId: string | null = RELATIONSHIP_ID): unknown {
  return {
    lens: 'expert',
    archetype: 'participant',
    isOwner: false,
    isInvitedExpert: true,
    relationshipId,
    canSeeContact: true,
  };
}

function draft(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL_ID,
    pricingMethod: 'fixed',
    overview: '<p>Overview</p>',
    currency: 'aud',
    timeframeWeeks: 6,
    exclusions: null,
    depositCents: null,
    rateCents: null,
    cadence: null,
    ...overrides,
  } as Proposal;
}

function milestone(overrides: Partial<ProposalMilestone> = {}): ProposalMilestone {
  return {
    title: 'Discovery',
    descriptionHtml: '<p>Map current state</p>',
    acceptanceCriteria: 'Signed off',
    valueCents: 500_000,
    ...overrides,
  } as ProposalMilestone;
}

function installment(
  overrides: Partial<ProposalPaymentInstallment> = {}
): ProposalPaymentInstallment {
  return { label: 'Upfront', pct: 30, ...overrides } as ProposalPaymentInstallment;
}

function document(overrides: Partial<ProposalDocument> = {}): ProposalDocument {
  return {
    id: 'doc-1',
    proposalId: PROPOSAL_ID,
    kind: 'ref',
    fileName: 'case-study.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    uploadedByUserId: 'user-expert',
    createdAt: new Date('2025-02-01T00:00:00Z'),
    ...overrides,
  } as ProposalDocument;
}

async function renderPage(
  ids: { requestId?: string; relationshipId?: string } = {}
): Promise<void> {
  const ui = await ProposalComposerPage({
    params: Promise.resolve({
      requestId: ids.requestId ?? REQUEST_ID,
      relationshipId: ids.relationshipId ?? RELATIONSHIP_ID,
    }),
  });
  render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
});

describe('ProposalComposerPage (RSC) — auth + lens gating', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockFindByIdWithRelations).not.toHaveBeenCalled();
  });

  it('logs an error and rethrows (to error.tsx) when the request load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockRejectedValue(new Error('db down'));

    await expect(renderPage()).rejects.toThrow('db down');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load request for proposal composer',
      expect.objectContaining({ requestId: REQUEST_ID, relationshipId: RELATIONSHIP_ID })
    );
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('calls notFound() when the request is missing', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('redirects to the request detail for a non-expert lens (client/admin/stranger)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    // Client lens (or null) is not allowed here.
    mockResolveRequestLens.mockReturnValue({ lens: 'client', relationshipId: null });

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Proposal composer access denied',
      expect.objectContaining({ requestId: REQUEST_ID, lens: 'client' })
    );
    // Never loads a draft for a denied viewer.
    expect(mockFindCurrentByRelationship).not.toHaveBeenCalled();
  });

  it('redirects when the expert is on a DIFFERENT relationship than the URL', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    // Expert lens, but their relationshipId mismatches the URL relationshipId.
    mockResolveRequestLens.mockReturnValue(expertCtx(OTHER_RELATIONSHIP_ID));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Proposal composer access denied',
      expect.objectContaining({ lens: 'expert' })
    );
  });

  it('redirects when the relationship is missing from the request', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    // Lens resolves to the URL relationship id, but the request carries no such row.
    mockFindByIdWithRelations.mockResolvedValue(request({ relationships: [] }));
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(mockFindCurrentByRelationship).not.toHaveBeenCalled();
  });

  it('redirects when the relationship is not at proposal_requested', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({
        relationships: [
          {
            id: RELATIONSHIP_ID,
            expertProfileId: EXPERT_PROFILE_ID,
            status: 'eoi_submitted',
          },
        ] as ProjectRequestWithRelations['relationships'],
      })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });
});

describe('ProposalComposerPage (RSC) — happy path', () => {
  it('hydrates an existing draft (+ children via Promise.all) and renders the composer', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(draft());
    mockListMilestones.mockResolvedValue([milestone()]);
    mockListInstallments.mockResolvedValue([
      installment({ label: 'Upfront', pct: 30 }),
      installment({ label: 'On delivery', pct: 70 }),
    ]);
    mockListDocuments.mockResolvedValue([document()]);

    await renderPage();

    // The child loads ran for the existing draft.
    expect(mockListMilestones).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(mockListInstallments).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(mockListDocuments).toHaveBeenCalledWith(PROPOSAL_ID);

    expect(screen.getByTestId('composer-stub')).toBeInTheDocument();
    // Header surfaces the client first name + the request title (back link).
    expect(screen.getByText(/Back to CPQ implementation/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Draft your scope, milestones, and pricing for Dana\./i)
    ).toBeInTheDocument();

    const props = mockComposer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      clientFirstName: 'Dana',
    });
    const initialState = props.initialState as Record<string, unknown>;
    expect(initialState).toMatchObject({
      proposalId: PROPOSAL_ID,
      overview: '<p>Overview</p>',
      pricingMethod: 'fixed',
      timeframeWeeks: 6,
    });
    expect((initialState.milestones as unknown[]).length).toBe(1);
    expect((initialState.installments as unknown[]).length).toBe(2);
    expect((initialState.documents as Array<{ fileName: string }>)[0]?.fileName).toBe(
      'case-study.pdf'
    );
  });

  it('falls back to "the client" when the client has no first name', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({
        createdByUser: {
          id: 'user-client',
          firstName: '   ',
          lastName: 'Whitfield',
          email: 'dana@northwind.test',
        },
      })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(draft());
    mockListMilestones.mockResolvedValue([]);
    mockListInstallments.mockResolvedValue([]);
    mockListDocuments.mockResolvedValue([]);

    await renderPage();

    const props = mockComposer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.clientFirstName).toBe('the client');
  });

  it('skips the child loads entirely when no draft exists yet (empty initial state)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(undefined);

    await renderPage();

    expect(mockListMilestones).not.toHaveBeenCalled();
    expect(mockListInstallments).not.toHaveBeenCalled();
    expect(mockListDocuments).not.toHaveBeenCalled();

    const props = mockComposer.mock.calls[0]?.[0] as Record<string, unknown>;
    const initialState = props.initialState as Record<string, unknown>;
    // emptyDraftState(): no proposalId, fixed default, blank overview.
    expect(initialState.proposalId).toBeNull();
    expect(initialState.pricingMethod).toBe('fixed');
    expect(initialState.overview).toBe('');
  });
});
