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
// composer + review + submitted views are stubbed below so we assert the props
// the page hands them, not their (separately-tested) internals.
vi.mock('server-only', () => ({}));

// ── Seams the page composes (mirrors the BAL-247/251 RSC page-test precedent) ──
const {
  mockFindByIdWithRelations,
  mockFindCurrentByRelationship,
  mockListMilestones,
  mockListInstallments,
  mockListDocuments,
  mockListChangeRequests,
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
  mockListChangeRequests: vi.fn(),
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
  proposalChangeRequestsRepository: { listByProposal: mockListChangeRequests },
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

// Stub the three leaf surfaces so we assert the *props* the loader serialises,
// never their own (separately-tested) internals.
const mockComposer = vi.hoisted(() => vi.fn());
const mockReview = vi.hoisted(() => vi.fn());
const mockSubmitted = vi.hoisted(() => vi.fn());
vi.mock('@/components/balo/project-request/proposal/proposal-composer', () => ({
  ProposalComposer: (props: unknown) => {
    mockComposer(props);
    return <div data-testid="composer-stub" />;
  },
}));
vi.mock('@/components/balo/project-request/proposal/proposal-review', () => ({
  ProposalReview: (props: unknown) => {
    mockReview(props);
    return <div data-testid="review-stub" />;
  },
}));
vi.mock('@/components/balo/project-request/proposal/submitted-view', () => ({
  SubmittedView: (props: unknown) => {
    mockSubmitted(props);
    return <div data-testid="submitted-stub" />;
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

/** A hydrated relationship row as `findByIdWithRelations` shapes it. */
function relationship(
  overrides: Partial<ProjectRequestWithRelations['relationships'][number]> = {}
): ProjectRequestWithRelations['relationships'][number] {
  return {
    id: RELATIONSHIP_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'proposal_requested',
    expertProfile: {
      id: EXPERT_PROFILE_ID,
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
    ...overrides,
  } as ProjectRequestWithRelations['relationships'][number];
}

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
    relationships: [relationship()],
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

/** The expert lens that opens the composer / submitted view. */
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

/** The client lens (owns the request). */
function clientCtx(): unknown {
  return {
    lens: 'client',
    archetype: 'participant',
    isOwner: true,
    isInvitedExpert: false,
    relationshipId: null,
    canSeeContact: false,
  };
}

/** The admin observer lens. */
function adminCtx(): unknown {
  return {
    lens: 'admin',
    archetype: 'observer',
    isOwner: false,
    isInvitedExpert: false,
    relationshipId: null,
    canSeeContact: true,
  };
}

function draft(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL_ID,
    relationshipId: RELATIONSHIP_ID,
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overview: '<p>Overview</p>',
    exclusions: null,
    priceCents: 1_200_000,
    currency: 'aud',
    baloFeeBps: 2500,
    timeframeWeeks: 6,
    depositCents: null,
    rateCents: null,
    cadence: null,
    ...overrides,
  } as Proposal;
}

function milestone(overrides: Partial<ProposalMilestone> = {}): ProposalMilestone {
  return {
    id: 'ms-1',
    proposalId: PROPOSAL_ID,
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
  return {
    id: 'in-1',
    proposalId: PROPOSAL_ID,
    label: 'Upfront',
    pct: 30,
    ...overrides,
  } as ProposalPaymentInstallment;
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

/** Seed the child-load mocks (used by every review/submitted branch). */
function seedChildren(): void {
  mockListMilestones.mockResolvedValue([milestone()]);
  mockListInstallments.mockResolvedValue([
    installment({ id: 'in-1', label: 'Upfront', pct: 30 }),
    installment({ id: 'in-2', label: 'On delivery', pct: 70 }),
  ]);
  mockListDocuments.mockResolvedValue([document()]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListChangeRequests.mockResolvedValue([]);
  mockNotFound.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
  mockRedirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
});

describe('ProposalSurfacePage (RSC) — auth + dispatch gating', () => {
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
      'Failed to load request for proposal surface',
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

  it('redirects when the viewer is unauthorised (resolveRequestLens → null)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    mockResolveRequestLens.mockReturnValue(null);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(mockFindCurrentByRelationship).not.toHaveBeenCalled();
  });

  it('redirects when the relationship is missing from the request', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request({ relationships: [] }));
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(mockFindCurrentByRelationship).not.toHaveBeenCalled();
  });
});

describe('ProposalSurfacePage (RSC) — expert composer branch', () => {
  it('redirects when the expert is on a DIFFERENT relationship than the URL', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    mockResolveRequestLens.mockReturnValue(expertCtx(OTHER_RELATIONSHIP_ID));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    // Never loads a proposal for a mismatched relationship.
    expect(mockFindCurrentByRelationship).not.toHaveBeenCalled();
  });

  it('redirects when the expert opens a non-(requested/submitted/accepted) relationship', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({ relationships: [relationship({ status: 'eoi_submitted' })] })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('hydrates an existing draft (+ children via Promise.all) and renders the composer', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(request());
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'draft' }));
    mockListMilestones.mockResolvedValue([milestone()]);
    mockListInstallments.mockResolvedValue([
      installment({ label: 'Upfront', pct: 30 }),
      installment({ id: 'in-2', label: 'On delivery', pct: 70 }),
    ]);
    mockListDocuments.mockResolvedValue([document()]);

    await renderPage();

    expect(mockListMilestones).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(mockListInstallments).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(mockListDocuments).toHaveBeenCalledWith(PROPOSAL_ID);

    expect(screen.getByTestId('composer-stub')).toBeInTheDocument();
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
    expect(initialState.milestones as unknown[]).toHaveLength(1);
    expect(initialState.installments as unknown[]).toHaveLength(2);
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
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'draft' }));
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
    expect(initialState.proposalId).toBeNull();
    expect(initialState.pricingMethod).toBe('fixed');
    expect(initialState.overview).toBe('');
  });
});

describe('ProposalSurfacePage (RSC) — expert submitted view branch', () => {
  it('renders the SubmittedView (expert lens) once a proposal is submitted', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({ relationships: [relationship({ status: 'proposal_submitted' })] })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'submitted' }));
    seedChildren();

    await renderPage();

    expect(screen.getByTestId('submitted-stub')).toBeInTheDocument();
    const props = mockSubmitted.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({ lens: 'expert', clientName: 'Dana', otherProposalCount: 0 });
    const doc = props.doc as Record<string, unknown>;
    expect(doc).toMatchObject({
      id: PROPOSAL_ID,
      relationshipId: RELATIONSHIP_ID,
      status: 'submitted',
      pricingMethod: 'fixed',
      overviewHtml: '<p>Overview</p>',
      priceCents: 1_200_000,
      currency: 'aud',
    });
    // Expert identity derived from the hydrated user; ungiven fields → null.
    expect(doc.expert).toEqual({
      name: 'Priya Nair',
      initials: 'PN',
      company: null,
      headline: null,
      rating: null,
    });
    expect(doc.milestones as unknown[]).toHaveLength(1);
    expect(doc.installments as unknown[]).toHaveLength(2);
    expect((doc.attachments as Array<{ fileName: string }>)[0]?.fileName).toBe('case-study.pdf');
  });

  it('counts OTHER submitted/accepted relationships for the "alongside N" framing', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({
        relationships: [
          relationship({ status: 'proposal_submitted' }),
          relationship({ id: OTHER_RELATIONSHIP_ID, status: 'accepted' }),
          relationship({ id: 'rel-3', status: 'eoi_submitted' }),
        ],
      })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'submitted' }));
    seedChildren();

    await renderPage();

    const props = mockSubmitted.mock.calls[0]?.[0] as Record<string, unknown>;
    // rel-2 (accepted) counts; rel-3 (eoi_submitted) does not; self excluded.
    expect(props.otherProposalCount).toBe(1);
  });

  it('redirects when the expert relationship is submitted but no current proposal exists', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({ relationships: [relationship({ status: 'proposal_submitted' })] })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(undefined);

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });
});

describe('ProposalSurfacePage (RSC) — expert revise composer branch (A6.4)', () => {
  it('renders the composer in REVISE mode when the relationship is submitted but the current proposal is changes_requested', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({ relationships: [relationship({ status: 'proposal_submitted' })] })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(
      draft({ status: 'changes_requested', version: 1 })
    );
    mockListMilestones.mockResolvedValue([milestone()]);
    mockListInstallments.mockResolvedValue([installment()]);
    mockListDocuments.mockResolvedValue([]);
    mockListChangeRequests.mockResolvedValue([
      { id: 'cr-1', note: 'Lower the price, please.', section: 'pricing' },
    ]);

    await renderPage();

    // Loads the latest change-request note against the CURRENT proposal.
    expect(mockListChangeRequests).toHaveBeenCalledWith(PROPOSAL_ID);
    expect(screen.getByTestId('composer-stub')).toBeInTheDocument();
    // The revise framing (heading copy) — not the draft "Build your proposal".
    expect(screen.getByText(/Revise your proposal/i)).toBeInTheDocument();

    const props = mockComposer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      clientFirstName: 'Dana',
      fromProposalId: PROPOSAL_ID,
      currentVersion: 1,
    });
    expect(props.changeRequest).toEqual({ note: 'Lower the price, please.', section: 'pricing' });
    // Hydrated from the CURRENT (changes_requested) proposal + its children.
    const initialState = props.initialState as Record<string, unknown>;
    expect(initialState).toMatchObject({ proposalId: PROPOSAL_ID, pricingMethod: 'fixed' });
    expect(initialState.milestones as unknown[]).toHaveLength(1);
  });

  it('passes no changeRequest (undefined) when the proposal has no change-request rows', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindByIdWithRelations.mockResolvedValue(
      request({ relationships: [relationship({ status: 'proposal_submitted' })] })
    );
    mockResolveRequestLens.mockReturnValue(expertCtx(RELATIONSHIP_ID));
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'changes_requested' }));
    mockListMilestones.mockResolvedValue([]);
    mockListInstallments.mockResolvedValue([]);
    mockListDocuments.mockResolvedValue([]);
    mockListChangeRequests.mockResolvedValue([]);

    await renderPage();

    const props = mockComposer.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.changeRequest).toBeUndefined();
  });
});

describe('ProposalSurfacePage (RSC) — client review branch', () => {
  it('renders ProposalReview across every reviewable proposal on the request', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ platformRole: 'user', expertProfileId: undefined })
    );
    mockFindByIdWithRelations.mockResolvedValue(
      request({
        relationships: [
          relationship({ status: 'proposal_submitted' }),
          relationship({
            id: OTHER_RELATIONSHIP_ID,
            status: 'proposal_submitted',
            expertProfile: {
              id: 'expert-2',
              user: { id: 'user-expert-2', firstName: 'Sam', lastName: 'Lee' },
            },
          }),
        ] as ProjectRequestWithRelations['relationships'],
      })
    );
    mockResolveRequestLens.mockReturnValue(clientCtx());
    // Both relationships carry a current, reviewable proposal.
    mockFindCurrentByRelationship
      .mockResolvedValueOnce(draft({ status: 'submitted', relationshipId: RELATIONSHIP_ID }))
      .mockResolvedValueOnce(
        draft({ id: 'prop-2', status: 'submitted', relationshipId: OTHER_RELATIONSHIP_ID })
      );
    mockListMilestones.mockResolvedValue([]);
    mockListInstallments.mockResolvedValue([]);
    mockListDocuments.mockResolvedValue([]);

    await renderPage();

    expect(screen.getByTestId('review-stub')).toBeInTheDocument();
    const props = mockReview.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({
      requestId: REQUEST_ID,
      activeRelationshipId: RELATIONSHIP_ID,
      clientCompanyName: 'Northwind Industrial',
      clientFirstName: 'Dana',
    });
    const proposals = props.proposals as Array<{ priceCents: number; adminPricing?: unknown }>;
    expect(proposals).toHaveLength(2);
    // audience='client' → hydrateReviewDoc grosses up: 1_200_000 @ 2500 bps → 1_500_000.
    const [firstDoc] = proposals;
    expect(firstDoc?.priceCents).toBe(1_500_000);
    // The fee/margin breakdown must NEVER reach the client audience.
    expect(firstDoc?.adminPricing).toBeUndefined();
  });

  it('filters out relationships with no reviewable current proposal', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ expertProfileId: undefined }));
    mockFindByIdWithRelations.mockResolvedValue(
      request({
        relationships: [
          relationship({ status: 'proposal_submitted' }),
          relationship({ id: OTHER_RELATIONSHIP_ID, status: 'eoi_submitted' }),
        ] as ProjectRequestWithRelations['relationships'],
      })
    );
    mockResolveRequestLens.mockReturnValue(clientCtx());
    // First relationship: a withdrawn proposal (not reviewable). Second: none.
    mockFindCurrentByRelationship
      .mockResolvedValueOnce(draft({ status: 'withdrawn' }))
      .mockResolvedValueOnce(undefined);
    mockListMilestones.mockResolvedValue([]);
    mockListInstallments.mockResolvedValue([]);
    mockListDocuments.mockResolvedValue([]);

    // No reviewable docs → redirect (no empty review surface).
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });

  it('falls back to "your company" when the request has no company name', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ expertProfileId: undefined }));
    mockFindByIdWithRelations.mockResolvedValue(
      request({
        company: undefined,
        relationships: [relationship({ status: 'proposal_submitted' })],
      })
    );
    mockResolveRequestLens.mockReturnValue(clientCtx());
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'submitted' }));
    mockListMilestones.mockResolvedValue([]);
    mockListInstallments.mockResolvedValue([]);
    mockListDocuments.mockResolvedValue([]);

    await renderPage();

    const props = mockReview.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.clientCompanyName).toBe('your company');
  });

  it('redirects a client viewing a relationship not yet at proposal_submitted', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ expertProfileId: undefined }));
    mockFindByIdWithRelations.mockResolvedValue(request()); // default rel: proposal_requested
    mockResolveRequestLens.mockReturnValue(clientCtx());

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Proposal surface access denied',
      expect.objectContaining({ lens: 'client' })
    );
  });
});

describe('ProposalSurfacePage (RSC) — admin observer branch', () => {
  it('renders the SubmittedView (admin lens) for a submitted relationship', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockFindByIdWithRelations.mockResolvedValue(
      request({ relationships: [relationship({ status: 'proposal_submitted' })] })
    );
    mockResolveRequestLens.mockReturnValue(adminCtx());
    mockFindCurrentByRelationship.mockResolvedValue(draft({ status: 'submitted' }));
    seedChildren();

    await renderPage();

    expect(screen.getByTestId('submitted-stub')).toBeInTheDocument();
    const props = mockSubmitted.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props).toMatchObject({ lens: 'admin', clientName: 'Dana' });
    // audience='admin' → the fee/margin breakdown is attached and populated.
    const doc = props.doc as { adminPricing?: { clientPriceCents: number; marginCents: number } };
    expect(doc.adminPricing).toBeDefined();
    // 1_200_000 @ 2500 bps → client 1_500_000; margin = 1_500_000 − 1_200_000.
    expect(doc.adminPricing?.clientPriceCents).toBe(1_500_000);
    expect(doc.adminPricing?.marginCents).toBe(300_000);
  });

  it('redirects an admin viewing a relationship not yet at proposal_submitted', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ platformRole: 'admin' }));
    mockFindByIdWithRelations.mockResolvedValue(request()); // default rel: proposal_requested
    mockResolveRequestLens.mockReturnValue(adminCtx());

    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith(`/projects/${REQUEST_ID}`);
  });
});
