import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import type { EngagementWithMilestones } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

// `rich-text.tsx` (reached through the workspace → milestone rail) imports
// `server-only`; the vitest alias stubs it, but keep the mock explicit for parity
// with the sibling projects page test.
vi.mock('server-only', () => ({}));

// ── Seams the page composes (mirrors the projects RSC page-test precedent) ──
const {
  mockFindEngagementWithMilestones,
  mockFindIdByProjectRequestId,
  mockGetCurrentUser,
  mockNotFound,
  mockRedirect,
  mockLogWarn,
  mockLogError,
  mockTrackServerAndFlush,
} = vi.hoisted(() => ({
  mockFindEngagementWithMilestones: vi.fn(),
  mockFindIdByProjectRequestId: vi.fn(),
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
}));

// `engagement-view.ts` value-imports `AUTO_ACCEPT_DAYS` from `@balo/db`; provide it
// so the real view mapper (unmocked) derives copy without a NaN/undefined leak.
vi.mock('@balo/db', () => ({
  AUTO_ACCEPT_DAYS: 7,
  engagementsRepository: {
    findEngagementWithMilestones: mockFindEngagementWithMilestones,
    findIdByProjectRequestId: mockFindIdByProjectRequestId,
  },
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/logging', () => ({ log: { warn: mockLogWarn, error: mockLogError } }));
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: mockTrackServerAndFlush,
  ENGAGEMENT_SERVER_EVENTS: { WORKSPACE_VIEWED: 'engagement_workspace_viewed' },
}));

import EngagementWorkspacePage, { generateMetadata } from './page';

const ENGAGEMENT_ID = 'eng-1';
const COMPANY_ID = 'company-1';
const OTHER_COMPANY_ID = 'company-2';
const EXPERT_PROFILE_ID = 'expert-1';
const ENGAGEMENT_TITLE = 'CPQ implementation';

function engagement(overrides: Partial<EngagementWithMilestones> = {}): EngagementWithMilestones {
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
    ...overrides,
  } as EngagementWithMilestones;
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
});

describe('EngagementWorkspacePage (RSC) — auth + lens gating', () => {
  it('redirects to /login when there is no current user', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockFindEngagementWithMilestones).not.toHaveBeenCalled();
  });

  it('calls notFound() when the engagement is missing (undefined)', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindEngagementWithMilestones.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockTrackServerAndFlush).not.toHaveBeenCalled();
  });

  it('logs a warning and notFound()s for an authenticated stranger (no leak)', async () => {
    // Different company, not the delivering expert, not admin → resolver null.
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

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

  it('logs an error and rethrows (to error.tsx) when the load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindEngagementWithMilestones.mockRejectedValue(new Error('db down'));

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
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

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
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(
      screen.getByRole('heading', { name: new RegExp(ENGAGEMENT_TITLE, 'i') })
    ).toBeInTheDocument();
  });

  it('renders the admin observer view', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, platformRole: 'admin' })
    );
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

    await renderPage();
    expect(
      screen.getByRole('heading', { name: new RegExp(ENGAGEMENT_TITLE, 'i') })
    ).toBeInTheDocument();
  });
});

describe('EngagementWorkspacePage (RSC) — analytics wiring', () => {
  it('fires engagement_workspace_viewed once with the resolved lens + status', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

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

  it('whitelists the entry: ?from=inbox passes through', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

    await renderPage('inbox');
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ entry: 'inbox' })
    );
  });

  it('collapses an unknown ?from to direct', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

    await renderPage('bogus');
    expect(mockTrackServerAndFlush).toHaveBeenCalledWith(
      'engagement_workspace_viewed',
      expect.objectContaining({ entry: 'direct' })
    );
  });

  it('defaults to direct when ?from is absent', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

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
    expect(mockFindEngagementWithMilestones).not.toHaveBeenCalled();
  });

  it('returns the GENERIC title for an authenticated stranger (existence not confirmed)', async () => {
    mockGetCurrentUser.mockResolvedValue(
      user({ companyId: OTHER_COMPANY_ID, expertProfileId: undefined })
    );
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

    const result = await meta();
    expect(result.title).toBe('Delivery workspace — Balo');
    expect(result.title).not.toContain(ENGAGEMENT_TITLE);
  });

  it('returns the GENERIC title when the engagement is missing', async () => {
    mockGetCurrentUser.mockResolvedValue(user());
    mockFindEngagementWithMilestones.mockResolvedValue(undefined);
    expect((await meta()).title).toBe('Delivery workspace — Balo');
  });

  it('returns the REAL title only for an authorised participant', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindEngagementWithMilestones.mockResolvedValue(engagement());

    const result = await meta();
    expect(result.title).toBe(`${ENGAGEMENT_TITLE} — Balo`);
    expect(result.robots).toMatchObject({ index: false, follow: false });
  });

  it('falls back to the GENERIC title (leak-free) when the load throws', async () => {
    mockGetCurrentUser.mockResolvedValue(user({ companyId: COMPANY_ID }));
    mockFindEngagementWithMilestones.mockRejectedValue(new Error('db down'));
    expect((await meta()).title).toBe('Delivery workspace — Balo');
  });
});
