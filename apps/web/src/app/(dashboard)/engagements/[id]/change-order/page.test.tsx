import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeOrderWithLines, ProjectEngagementWithMilestones } from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';

import { render, screen } from '@/test/utils';
import type { SessionUser } from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

const {
  mockFindWithMilestones,
  mockListChangeOrders,
  mockGetCurrentUser,
  mockHasDeliveryCapability,
  mockNotFound,
  mockRedirect,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockFindWithMilestones: vi.fn(),
  mockListChangeOrders: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockHasDeliveryCapability: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockRedirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  mockLogWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: { findWithMilestones: mockFindWithMilestones },
  engagementChangeOrdersRepository: { listForEngagement: mockListChangeOrders },
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: mockHasDeliveryCapability,
}));
vi.mock('@/lib/logging', () => ({ log: { warn: mockLogWarn, error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/engagements/eng-1/change-order',
}));
// The composer is covered by its own test; here only the props the page hands it matter.
vi.mock('@/components/balo/engagement/change-orders/change-order-composer', () => ({
  ChangeOrderComposer: (props: Record<string, unknown>) => (
    <pre data-testid="composer">{JSON.stringify(props)}</pre>
  ),
}));

import ChangeOrderComposerPage from './page';

const NO_BEFORE = { beforeTitle: null, beforeDescriptionHtml: null, beforeEstimatedMinutes: null };
const ENGAGEMENT_ID = 'eng-1';
const COMPANY_ID = 'company-1';
const EXPERT_PROFILE_ID = 'expert-1';

function engagement(
  overrides: Partial<ProjectEngagementWithMilestones> = {}
): ProjectEngagementWithMilestones {
  return {
    id: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    status: 'active',
    pricingMethod: 'fixed',
    priceCents: 5_800_000,
    baloFeeBps: 2500,
    currency: 'aud',
    milestones: [
      {
        id: '3f1c2b4e-8a6d-4c1e-9f2a-5b7d8e9f0a1b',
        title: 'Discovery',
        sortOrder: 0,
        descriptionHtml: '<p>Workshops.</p>',
        status: 'completed',
        estimatedMinutes: 600,
      },
      {
        id: '4a2d3c5f-9b7e-4d2f-8a3b-6c8e9f0a1b2c',
        title: 'Build',
        sortOrder: 1,
        descriptionHtml: null,
        status: 'in_progress',
        estimatedMinutes: null,
      },
    ],
    expertProfile: {
      id: EXPERT_PROFILE_ID,
      agencyId: null,
      type: 'independent',
      headline: null,
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
      agency: null,
    },
    company: { id: COMPANY_ID, name: 'Northwind Industrial' },
    projectRequest: { id: 'req-1', title: 'CPQ implementation' },
    ...overrides,
  } as unknown as ProjectEngagementWithMilestones;
}

function expertUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-expert',
    email: 'priya@example.com',
    firstName: 'Priya',
    lastName: 'Sharma',
    avatarUrl: null,
    activeMode: 'expert',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: 'company-expert',
    companyName: 'Priya Consulting',
    companyRole: 'owner',
    expertProfileId: EXPERT_PROFILE_ID,
    ...overrides,
  };
}

function order(overrides: Record<string, unknown> = {}): ChangeOrderWithLines {
  return {
    id: 'o1',
    engagementId: ENGAGEMENT_ID,
    status: 'draft',
    requestNote: null,
    note: null,
    priceDeltaCents: null,
    requestedAt: null,
    requestedBy: null,
    sentAt: null,
    decidedAt: null,
    withdrawnAt: null,
    lines: [],
    ...overrides,
  } as unknown as ChangeOrderWithLines;
}

async function renderPage(search: Record<string, string> = {}): Promise<void> {
  const ui = await ChangeOrderComposerPage({
    params: Promise.resolve({ id: ENGAGEMENT_ID }),
    searchParams: Promise.resolve(search),
  });
  render(ui);
}

function composerProps(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('composer').textContent ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(expertUser());
  mockFindWithMilestones.mockResolvedValue(engagement());
  mockListChangeOrders.mockResolvedValue([]);
  mockHasDeliveryCapability.mockResolvedValue(true);
});

describe('change-order composer page · access', () => {
  it('redirects a signed-out visitor to login', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('404s when the engagement does not exist', async () => {
    mockFindWithMilestones.mockResolvedValue(undefined);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('404s a stranger without consulting the capability', async () => {
    mockGetCurrentUser.mockResolvedValue(
      expertUser({ companyId: 'company-other', expertProfileId: undefined })
    );
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockHasDeliveryCapability).not.toHaveBeenCalled();
  });

  it('404s the client company: the composer is expert-only', async () => {
    mockGetCurrentUser.mockResolvedValue(
      expertUser({ companyId: COMPANY_ID, expertProfileId: undefined, activeMode: 'client' })
    );
    mockHasDeliveryCapability.mockResolvedValue(false);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockListChangeOrders).not.toHaveBeenCalled();
  });

  it('404s a delivering-side member who lacks the manage_engagement capability', async () => {
    mockHasDeliveryCapability.mockResolvedValue(false);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockHasDeliveryCapability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-expert' }),
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      EXPERT_PROFILE_ID,
      { contextType: 'project', contextId: ENGAGEMENT_ID }
    );
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('404s Balo staff, who hold no delivery capability', async () => {
    mockGetCurrentUser.mockResolvedValue(expertUser({ platformRole: 'admin' }));
    mockHasDeliveryCapability.mockResolvedValue(false);
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('change-order composer page · redirects', () => {
  it('sends a project that is not active back to the workspace', async () => {
    mockFindWithMilestones.mockResolvedValue(engagement({ status: 'pending_acceptance' }));
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/engagements/eng-1');
  });

  it('sends the expert back when a change is already with the client', async () => {
    mockListChangeOrders.mockResolvedValue([order({ status: 'sent', sentAt: new Date() })]);
    await expect(renderPage()).rejects.toThrow('NEXT_REDIRECT:/engagements/eng-1');
  });
});

describe('change-order composer page · prefill', () => {
  it('turns a remove prefill for a live milestone into a line with its live title', async () => {
    await renderPage({ prefill: 'remove', milestone: '3f1c2b4e-8a6d-4c1e-9f2a-5b7d8e9f0a1b' });
    expect(composerProps().prefillLine).toEqual({
      op: 'remove',
      milestoneId: '3f1c2b4e-8a6d-4c1e-9f2a-5b7d8e9f0a1b',
      title: 'Discovery',
      descriptionText: null,
      estimatedMinutes: null,
    });
  });

  it('ignores a milestone id that is not part of this engagement', async () => {
    await renderPage({ prefill: 'remove', milestone: '11111111-1111-4111-8111-111111111111' });
    expect(composerProps().prefillLine).toBeNull();
  });

  it('turns an add prefill into a blank new-milestone line', async () => {
    await renderPage({ prefill: 'add', title: 'Reporting', description: 'Weekly pack.' });
    // A title or description in the link is ignored: an add opens blank.
    expect(composerProps().prefillLine).toEqual({
      op: 'add',
      milestoneId: null,
      title: '',
      descriptionText: null,
      estimatedMinutes: null,
    });
  });

  it('opens normally for a malformed prefill', async () => {
    await renderPage({ prefill: 'remove', milestone: 'not-a-uuid' });
    expect(composerProps().prefillLine).toBeNull();
  });
});

describe('change-order composer page · props', () => {
  it('hands the composer expert-side figures and the live plan for a fresh change', async () => {
    await renderPage();
    expect(composerProps()).toEqual({
      engagementId: ENGAGEMENT_ID,
      pricingMethod: 'fixed',
      clientCompanyName: 'Northwind Industrial',
      projectTitle: 'CPQ implementation',
      currency: 'aud',
      currentPriceCents: 5_800_000,
      milestones: [
        {
          id: '3f1c2b4e-8a6d-4c1e-9f2a-5b7d8e9f0a1b',
          title: 'Discovery',
          descriptionText: 'Workshops.',
          status: 'completed',
          estimatedMinutes: 600,
        },
        {
          id: '4a2d3c5f-9b7e-4d2f-8a3b-6c8e9f0a1b2c',
          title: 'Build',
          descriptionText: null,
          status: 'in_progress',
          estimatedMinutes: null,
        },
      ],
      order: null,
      prefillLine: null,
    });
  });

  it('starts from the effective price: the accepted price plus approved deltas', async () => {
    mockListChangeOrders.mockResolvedValue([
      order({ id: 'o0', status: 'approved', priceDeltaCents: 250_000, decidedAt: new Date() }),
      order({ id: 'o00', status: 'declined', priceDeltaCents: 900_000, decidedAt: new Date() }),
    ]);
    await renderPage();
    expect(composerProps().currentPriceCents).toBe(6_050_000);
  });

  it('hands the composer the hourly rate for the T&M cap check', async () => {
    mockFindWithMilestones.mockResolvedValue(
      engagement({ pricingMethod: 'tm', rateCents: 22_000 })
    );
    await renderPage();
    expect(composerProps().hourlyRateCents).toBe(22_000);
  });

  it('carries a client request into the composer with its heading and note', async () => {
    mockListChangeOrders.mockResolvedValue([
      order({
        status: 'requested',
        requestNote: 'Please add a dashboard.',
        requestedAt: new Date('2026-10-15T00:00:00Z'),
        requestedBy: { id: 'u-dana', firstName: 'Dana', lastName: 'Lee' },
      }),
    ]);
    await renderPage();
    expect(composerProps().order).toEqual({
      id: 'o1',
      status: 'requested',
      requestNote: 'Please add a dashboard.',
      requestedHeading: 'Dana @ Northwind Industrial asked for a change on 15 Oct',
      note: null,
      priceDeltaCents: null,
      lines: [],
    });
  });

  it('resumes a saved draft with its note, price delta and lines as plain text', async () => {
    mockListChangeOrders.mockResolvedValue([
      order({
        status: 'draft',
        note: 'Reprice and add a step',
        priceDeltaCents: 100_000,
        lines: [
          {
            op: 'add',
            engagementMilestoneId: null,
            title: 'Dashboard',
            descriptionHtml: '<p>KPI board.</p>',
            estimatedMinutes: 300,
            ...NO_BEFORE,
          },
          {
            op: 'remove',
            engagementMilestoneId: '4a2d3c5f-9b7e-4d2f-8a3b-6c8e9f0a1b2c',
            title: 'Build',
            descriptionHtml: null,
            estimatedMinutes: null,
            ...NO_BEFORE,
          },
        ],
      }),
    ]);
    await renderPage();
    expect(composerProps().order).toEqual({
      id: 'o1',
      status: 'draft',
      requestNote: null,
      requestedHeading: null,
      note: 'Reprice and add a step',
      priceDeltaCents: 100_000,
      lines: [
        {
          op: 'add',
          milestoneId: null,
          title: 'Dashboard',
          descriptionText: 'KPI board.',
          estimatedMinutes: 300,
        },
        {
          op: 'remove',
          milestoneId: '4a2d3c5f-9b7e-4d2f-8a3b-6c8e9f0a1b2c',
          title: 'Build',
          descriptionText: null,
          estimatedMinutes: null,
        },
      ],
    });
  });

  it('never hands the composer a client-side figure', async () => {
    await renderPage();
    expect(screen.getByTestId('composer').textContent).not.toContain('7250000');
  });
});
