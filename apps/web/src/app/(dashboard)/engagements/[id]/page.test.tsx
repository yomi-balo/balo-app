import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ProjectEngagementWithMilestones } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

// `rich-text.tsx` (reached through the workspace → milestone rail) imports
// `server-only`; the vitest alias stubs it, but keep the mock explicit for parity
// with the sibling projects page test.
vi.mock('server-only', () => ({}));

// A `completed` + client-lens render reaches `EngagementRatingCard` → `RatingBlock`
// (`StateSwap`'s `AnimatePresence mode="wait"`), so stub `motion/react` and the write
// action the same way `rating-block.test.tsx` does, keeping this composition test out
// of that Server Action's `@balo/db` module graph.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: vi.fn(),
}));

// ── Seams the page composes (mirrors the projects RSC page-test precedent) ──
const {
  mockFindWithMilestones,
  mockFindIdByProjectRequestId,
  mockListActionItems,
  mockGetCurrentUser,
  mockNotFound,
  mockRedirect,
  mockLogWarn,
  mockLogError,
  mockTrackServerAndFlush,
  mockReadRatingCard,
  mockListChangeOrders,
  mockListContentEdits,
  mockLoadProjectSettlement,
  mockHasCapability,
  mockHasDeliveryCapability,
} = vi.hoisted(() => ({
  mockFindWithMilestones: vi.fn(),
  mockFindIdByProjectRequestId: vi.fn(),
  mockListActionItems: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  // notFound()/redirect() must THROW so control flow stops, exactly like Next.
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockRedirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockTrackServerAndFlush: vi.fn(),
  mockReadRatingCard: vi.fn(),
  mockListChangeOrders: vi.fn(),
  mockListContentEdits: vi.fn(),
  mockLoadProjectSettlement: vi.fn(),
  mockHasCapability: vi.fn(),
  mockHasDeliveryCapability: vi.fn(),
}));

// `engagement-view.ts` value-imports `AUTO_ACCEPT_DAYS` from `@balo/db`; provide it
// so the real view mapper (unmocked) derives copy without a NaN/undefined leak.
vi.mock('@balo/db', () => ({
  AUTO_ACCEPT_DAYS: 7,
  blocksMarkReady: () => false,
  engagementChangeOrdersRepository: { listForEngagement: mockListChangeOrders },
  engagementMilestonesRepository: { listProposalContentEdits: mockListContentEdits },
  projectEngagementsRepository: {
    findWithMilestones: mockFindWithMilestones,
    findByProjectRequestId: mockFindIdByProjectRequestId,
  },
  // BAL-391: the page loads live action items as a separate read and maps them
  // into the panel view (real, unmocked mapper) — default to an empty list.
  actionItemsRepository: {
    listByEngagement: mockListActionItems,
  },
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz')>()),
  hasCapability: mockHasCapability,
}));
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: mockHasDeliveryCapability,
}));
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
  // BAL-499 — the page now renders <EntityCrumb>, which calls usePathname(). Not asserted on
  // here (that lives in breadcrumbs.test.tsx); this mock only needs to exist so the render
  // doesn't throw.
  usePathname: () => '/engagements/eng-1',
}));
vi.mock('@/lib/logging', () => ({ log: { warn: mockLogWarn, error: mockLogError } }));
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: mockTrackServerAndFlush,
  ENGAGEMENT_SERVER_EVENTS: { WORKSPACE_VIEWED: 'engagement_workspace_viewed' },
}));
vi.mock('@/lib/reviews/read-rating-card', () => ({ readRatingCard: mockReadRatingCard }));
vi.mock('@/lib/engagement/change-order-settlement', () => ({
  loadProjectSettlement: mockLoadProjectSettlement,
}));

import { deriveProjectSettlement } from '@balo/shared/engagements';
import { makeOrder } from '@/test/change-order-fixtures';
import { buildReviewCaptureSeeds } from '@/test/fixtures/review-capture-seeds';
import EngagementWorkspacePage, { generateMetadata } from './page';

const ENGAGEMENT_ID = 'eng-1';
const COMPANY_ID = 'company-1';
const OTHER_COMPANY_ID = 'company-2';
const EXPERT_PROFILE_ID = 'expert-1';
const ENGAGEMENT_TITLE = 'CPQ implementation';

function engagement(
  overrides: Partial<ProjectEngagementWithMilestones> = {}
): ProjectEngagementWithMilestones {
  return {
    id: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    projectRequestId: 'req-1',
    status: 'active',
    pricingMethod: 'fixed',
    priceCents: 5_800_000,
    currency: 'aud',
    depositCents: null,
    rateCents: null,
    cadence: null,
    billingModel: 'fixed',
    approvalModel: 'client',
    activatedAt: new Date('2026-06-01T00:00:00Z'),
    completionRequestedByUserId: null,
    completionRequestedAt: null,
    acceptedByUserId: null,
    acceptedAt: null,
    acceptanceMethod: null,
    changeRequestNote: null,
    changeRequestedByUserId: null,
    changeRequestedAt: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    milestones: [],
    expertProfile: {
      id: EXPERT_PROFILE_ID,
      agencyId: null,
      type: 'independent',
      headline: 'Salesforce CPQ specialist',
      user: {
        id: 'user-expert',
        firstName: 'Priya',
        lastName: 'Sharma',
        avatarUrl: null,
      },
      agency: null,
    },
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: ENGAGEMENT_TITLE },
    acceptedBy: null,
    changeRequestedBy: null,
    completionRequestedBy: null,
    changeRequestRounds: [],
    latestChangeRequest: null,
    changeRequestRoundCount: 0,
    ...overrides,
  } as ProjectEngagementWithMilestones;
}

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-x',
    email: 'x@example.com',
    firstName: 'X',
    lastName: 'Y',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: COMPANY_ID,
    companyName: 'Northwind Industrial',
    companyRole: 'owner',
    ...overrides,
  };
}

async function renderPage(from?: string, id = ENGAGEMENT_ID) {
  const ui = await EngagementWorkspacePage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve(from === undefined ? {} : { from }),
  });
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListActionItems.mockResolvedValue([]);
  mockReadRatingCard.mockResolvedValue(null);
  mockListChangeOrders.mockResolvedValue([]);
  mockListContentEdits.mockResolvedValue([]);
  mockHasCapability.mockResolvedValue(true);
  mockHasDeliveryCapability.mockResolvedValue(false);
  mockLoadProjectSettlement.mockResolvedValue(
    deriveProjectSettlement({
      acceptedPriceCents: 5_800_000,
      approvedDeltasInOrder: [],
      baloFeeBps: 2500,
      upfrontDueClientCents: 2_900_000,
    })
  );
});

describe('EngagementWorkspacePage (RSC) — auth + lens gating', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockFindWithMilestones).not.toHaveBeenCalled();
  });

  it('calls notFound() when the engagement is missing (undefined)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindWithMilestones.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('logs a warning and notFound()s for an authenticated stranger (no leak)', async () => {
    // Different company, not the delivering expert, not admin → resolver null.
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Engagement access denied',
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: 'user-x',
        companyId: OTHER_COMPANY_ID,
      })
    );
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('admits an agency owner/admin (no lens, manage_engagement held) with the expert-side view and no staff money', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ id: 'user-agency-admin', companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());
    mockHasDeliveryCapability.mockResolvedValue(true);

    await renderPage('request_detail');

    expect(mockHasDeliveryCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-agency-admin' }),
      'manage_engagement',
      EXPERT_PROFILE_ID,
      { contextType: 'project', contextId: ENGAGEMENT_ID }
    );
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ lens: 'expert', acting_as: 'agency_admin' })
    );
    expect(mockLoadProjectSettlement).not.toHaveBeenCalled();
    expect(screen.queryByText('Balo staff only')).not.toBeInTheDocument();
  });

  it('logs an error and rethrows (to error.tsx) when the load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindWithMilestones.mockRejectedValue(new Error('db down'));

    await expect(renderPage()).rejects.toThrow('db down');
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to load engagement workspace',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID })
    );
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });
});

describe('EngagementWorkspacePage (RSC) — authorised lenses render the header title', () => {
  it('renders the client-owner view with the engagement title', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(
      screen.getByRole('heading', { name: new RegExp(ENGAGEMENT_TITLE, 'i') })
    ).toBeInTheDocument();
  });

  it('renders the delivering-expert view', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({
        companyId: OTHER_COMPANY_ID,
        expertProfileId: EXPERT_PROFILE_ID,
        activeMode: 'expert',
      })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(
      screen.getByRole('heading', { name: new RegExp(ENGAGEMENT_TITLE, 'i') })
    ).toBeInTheDocument();
  });

  it('renders the admin observer view', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, platformRole: 'admin' })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(
      screen.getByRole('heading', { name: new RegExp(ENGAGEMENT_TITLE, 'i') })
    ).toBeInTheDocument();
  });
});

describe('EngagementWorkspacePage (RSC) — analytics wiring', () => {
  it('fires engagement_workspace_viewed once with the resolved lens + status', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage('request_detail');
    expect(mockTrackServerAndFlush).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith('engagement_workspace_viewed', {
      engagement_id: ENGAGEMENT_ID,
      lens: 'client',
      entry: 'request_detail',
      engagement_status: 'active',
      distinct_id: 'user-x',
    });
  });

  it('records acting_as delivering_expert for the delivering expert', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ id: 'user-expert', companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ lens: 'expert', acting_as: 'delivering_expert' })
    );
  });

  it('omits acting_as for a platform admin observer', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ platformRole: 'admin', companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    const [, props] = mockTrackServerAndFlush.mock.calls[0] ?? [];
    expect(props).not.toHaveProperty('acting_as');
  });

  it('whitelists the entry: ?from=inbox passes through', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage('inbox');
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ entry: 'inbox' })
    );
  });

  it('collapses an unknown ?from to direct', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage('bogus');
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ entry: 'direct' })
    );
  });

  it('defaults to direct when ?from is absent', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ entry: 'direct' })
    );
  });
});

describe('EngagementWorkspacePage — generateMetadata (no existence/title leak)', () => {
  async function meta(id = ENGAGEMENT_ID) {
    return generateMetadata({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({}),
    });
  }

  it('returns the GENERIC title for a null user (never echoes the title)', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await meta();
    expect(result.title).toBe('Delivery workspace — Balo');
    expect(result.robots).toMatchObject({ index: false, follow: false });
    expect(mockFindWithMilestones).not.toHaveBeenCalled();
  });

  it('returns the GENERIC title for an authenticated stranger (existence not confirmed)', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    const result = await meta();
    expect(result.title).toBe('Delivery workspace — Balo');
    expect(result.title).not.toContain(ENGAGEMENT_TITLE);
  });

  it('returns the REAL title for an agency owner/admin who holds manage_engagement', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());
    mockHasDeliveryCapability.mockResolvedValue(true);

    expect((await meta()).title).toBe(`${ENGAGEMENT_TITLE} — Balo`);
  });

  it('returns the GENERIC title when the engagement is missing', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindWithMilestones.mockResolvedValue(undefined);
    expect((await meta()).title).toBe('Delivery workspace — Balo');
  });

  it('returns the REAL title only for an authorised participant', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    const result = await meta();
    expect(result.title).toBe(`${ENGAGEMENT_TITLE} — Balo`);
    expect(result.robots).toMatchObject({ index: false, follow: false });
  });

  it('falls back to the GENERIC title (leak-free) when the load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockRejectedValue(new Error('db down'));
    expect((await meta()).title).toBe('Delivery workspace — Balo');
  });
});

describe('EngagementWorkspacePage (RSC) — readRatingCard wiring', () => {
  it('client + completed calls readRatingCard with the viewer id, no consultation required', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement({ status: 'completed' }));
    mockReadRatingCard.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      state: { kind: 'none' },
      existingBody: null,
      capture: buildReviewCaptureSeeds(),
    });

    await renderPage();

    expect(mockReadRatingCard).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      viewerUserId: 'user-x',
      requireHeldConsultation: false,
      now: expect.any(Date),
    });
    expect(screen.getByText(/How was working with/)).toBeInTheDocument();
  });

  it('expert + completed never calls readRatingCard', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID })
    );
    mockFindWithMilestones.mockResolvedValue(engagement({ status: 'completed' }));

    await renderPage();

    expect(mockReadRatingCard).not.toHaveBeenCalled();
  });

  it('admin + completed never calls readRatingCard', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, platformRole: 'admin' })
    );
    mockFindWithMilestones.mockResolvedValue(engagement({ status: 'completed' }));

    await renderPage();

    expect(mockReadRatingCard).not.toHaveBeenCalled();
  });

  it('client + active never calls readRatingCard', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement({ status: 'active' }));

    await renderPage();

    expect(mockReadRatingCard).not.toHaveBeenCalled();
  });
});

describe('EngagementWorkspacePage (RSC) — change orders and the staff money view', () => {
  it('loads the engagement change orders alongside the other reads', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();

    expect(mockListChangeOrders).toHaveBeenCalledWith(ENGAGEMENT_ID);
  });

  it('reads the wording edits only for milestones carrying the content-edited stamp', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    const milestone = (id: string, contentEditedAt: Date | null): unknown => ({
      id,
      engagementId: ENGAGEMENT_ID,
      sourceProposalMilestoneId: null,
      sortOrder: 0,
      title: id,
      descriptionHtml: null,
      acceptanceCriteria: null,
      valueCents: null,
      status: 'pending',
      completedAt: null,
      completedBy: null,
      contentEditedAt,
    });
    mockFindWithMilestones.mockResolvedValue(
      engagement({
        milestones: [
          milestone('ms-edited', new Date('2026-06-30T00:00:00Z')),
          milestone('ms-plain', null),
        ] as ProjectEngagementWithMilestones['milestones'],
      })
    );

    await renderPage();

    expect(mockListContentEdits).toHaveBeenCalledWith(['ms-edited']);
  });

  describe('deciding on a sent change', () => {
    const NOTICE =
      'Anyone who can approve proposals for Northwind Industrial can approve or decline this.';

    beforeEach(() => {
      mockFindWithMilestones.mockResolvedValue(engagement());
      mockListChangeOrders.mockResolvedValue([
        makeOrder({
          status: 'sent',
          sentAt: new Date('2026-10-18T00:00:00Z'),
          note: 'Adds a report',
        }),
      ]);
    });

    it('shows the decide buttons to a client who holds approve_own_proposals', async () => {
      mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));

      await renderPage();

      expect(mockHasCapability).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: COMPANY_ID }),
        'approve_own_proposals',
        { companyId: COMPANY_ID }
      );
      expect(screen.getByRole('button', { name: 'Approve change' })).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(NOTICE))).not.toBeInTheDocument();
    });

    it('shows no buttons and names the party to a participant who cannot approve', async () => {
      mockHasCapability.mockResolvedValue(false);
      mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID, companyRole: 'member' }));

      await renderPage();

      expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
      expect(screen.getByText(new RegExp(NOTICE))).toBeInTheDocument();
    });
  });

  it.each([
    ['client owner', user({ companyId: COMPANY_ID })],
    [
      'delivering expert',
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID }),
    ],
  ])('never loads the settlement or renders the staff panel for the %s', async (_name, viewer) => {
    mockGetCurrentUser.mockResolvedValue(viewer);
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();

    expect(mockLoadProjectSettlement).not.toHaveBeenCalled();
    expect(screen.queryByText('Balo staff only')).not.toBeInTheDocument();
  });

  it('loads the settlement and renders the staff panel for a platform admin', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, platformRole: 'admin' })
    );
    mockFindWithMilestones.mockResolvedValue(engagement());

    await renderPage();

    expect(mockLoadProjectSettlement).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(screen.getByText('Balo staff only')).toBeInTheDocument();
  });
});
