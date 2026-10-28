import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectEngagementWithMilestones } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';

vi.mock('server-only', () => ({}));

const {
  mockFindWithMilestones,
  mockGetCurrentUser,
  mockListEntries,
  mockSums,
  mockHasDeliveryCapability,
  mockAdministers,
  mockHasPlatformCapability,
  mockListChangeOrders,
} = vi.hoisted(() => ({
  mockFindWithMilestones: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockListEntries: vi.fn(),
  mockSums: vi.fn(),
  mockHasDeliveryCapability: vi.fn(),
  mockAdministers: vi.fn(),
  mockHasPlatformCapability: vi.fn(),
  mockListChangeOrders: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  AUTO_ACCEPT_DAYS: 7,
  blocksMarkReady: () => false,
  engagementChangeOrdersRepository: { listForEngagement: mockListChangeOrders },
  engagementMilestonesRepository: { listProposalContentEdits: vi.fn().mockResolvedValue([]) },
  projectEngagementsRepository: { findWithMilestones: mockFindWithMilestones },
  actionItemsRepository: { listByEngagement: vi.fn().mockResolvedValue([]) },
  engagementTimeEntriesRepository: {
    listByEngagement: mockListEntries,
    sumsForEngagement: mockSums,
    listNotifiedAtCurrentEstimate: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/authz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/authz/engagement', () => ({
  hasExpertDeliveryCapability: mockHasDeliveryCapability,
  administersDeliveringAgency: mockAdministers,
}));
vi.mock('@/lib/authz/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/platform')>()),
  hasPlatformCapability: mockHasPlatformCapability,
}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: vi.fn() }));
vi.mock('@/lib/logging', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: vi.fn(),
  ENGAGEMENT_SERVER_EVENTS: { WORKSPACE_VIEWED: 'engagement_workspace_viewed' },
}));
vi.mock('@/lib/reviews/read-rating-card', () => ({ readRatingCard: vi.fn() }));
vi.mock('@/lib/engagement/change-order-settlement', () => ({ loadProjectSettlement: vi.fn() }));
vi.mock('@/components/layout/breadcrumb-context', () => ({ EntityCrumb: () => null }));
vi.mock('@/components/balo/engagement/engagement-workspace', () => ({
  EngagementWorkspace: () => null,
}));

import { HOST_ROLES } from '@balo/shared/authz';
import { makeLine, makeMilestone, makeOrder } from '@/test/change-order-fixtures';
import { capabilityOverTokenMap } from '@/test/engagement-capability-fake';
import EngagementWorkspacePage from './page';

const BUILD = makeMilestone({
  id: 'ms-1',
  title: 'Build',
  status: 'in_progress',
  estimatedMinutes: 480,
});

const ENGAGEMENT_ID = 'eng-1';

function engagement(
  over: Partial<ProjectEngagementWithMilestones>
): ProjectEngagementWithMilestones {
  return {
    id: ENGAGEMENT_ID,
    companyId: 'company-1',
    expertProfileId: 'expert-1',
    projectRequestId: 'req-1',
    status: 'active',
    pricingMethod: 'tm',
    priceCents: 0,
    currency: 'aud',
    rateCents: 15_000,
    cadence: 'monthly',
    activatedAt: new Date('2026-10-01T00:00:00Z'),
    completionRequestedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    milestones: [],
    expertProfile: {
      id: 'expert-1',
      agencyId: null,
      type: 'freelancer',
      headline: null,
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Sharma', avatarUrl: null },
      agency: null,
    },
    company: { id: 'company-1', name: 'Northwind' },
    projectRequest: { id: 'req-1', title: 'CPQ' },
    completionRequestedBy: null,
    changeRequestRounds: [],
    latestChangeRequest: null,
    changeRequestRoundCount: 0,
    acceptedBy: null,
    changeRequestedBy: null,
    ...over,
  } as unknown as ProjectEngagementWithMilestones;
}

const expert = {
  id: 'user-expert',
  platformRole: 'user',
  companyId: 'other',
  expertProfileId: 'expert-1',
} as unknown as SessionUser;

async function renderPage(): Promise<Record<string, unknown>> {
  const ui = await EngagementWorkspacePage({
    params: Promise.resolve({ id: ENGAGEMENT_ID }),
    searchParams: Promise.resolve({}),
  });
  const children = React.Children.toArray(ui.props.children) as React.ReactElement<
    Record<string, unknown>
  >[];
  const workspace = children.find((child) => child.props.view !== undefined);
  if (workspace === undefined) throw new Error('workspace not rendered');
  return workspace.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(expert);
  mockListEntries.mockResolvedValue([]);
  mockSums.mockResolvedValue({ totalMinutes: 0, periodMinutes: 0, byMilestone: {} });
  // `user-expert` delivers; any other caller holds the agency owner/admin bundle.
  mockHasDeliveryCapability.mockImplementation(
    capabilityOverTokenMap((id) =>
      id === 'user-expert' ? HOST_ROLES.DELIVERING_EXPERT : HOST_ROLES.AGENCY_ADMIN
    )
  );
  mockAdministers.mockResolvedValue(false);
  mockHasPlatformCapability.mockReturnValue(false);
  mockListChangeOrders.mockResolvedValue([]);
});

describe('EngagementWorkspacePage — time and materials wiring', () => {
  it('reads the entries and the current billing period only on a time and materials project', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    try {
      mockFindWithMilestones.mockResolvedValue(engagement({}));
      const props = await renderPage();
      expect(mockListEntries).toHaveBeenCalledWith(ENGAGEMENT_ID);
      expect(mockSums).toHaveBeenCalledWith(ENGAGEMENT_ID, {
        startOn: '2026-10-01',
        endOn: '2026-11-01',
        nextInvoiceOn: '2026-11-01',
      });
      expect(props.time).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['completed', 'cancelled'] as const)(
    'computes no billing period once the project is %s',
    async (status) => {
      mockFindWithMilestones.mockResolvedValue(engagement({ status }));
      await renderPage();
      expect(mockSums).toHaveBeenCalledWith(ENGAGEMENT_ID, null);
    }
  );

  it("dates the billing period in the delivering expert's time zone", async () => {
    // 20:00Z on 31 Oct is 07:00 on 1 Nov in Melbourne, so the November period has begun there.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T20:00:00Z'));
    try {
      const base = engagement({});
      mockFindWithMilestones.mockResolvedValue(
        engagement({
          expertProfile: { ...base.expertProfile, timezone: 'Australia/Melbourne' },
        } as Partial<ProjectEngagementWithMilestones>)
      );
      await renderPage();
      expect(mockSums).toHaveBeenCalledWith(ENGAGEMENT_ID, {
        startOn: '2026-11-01',
        endOn: '2026-12-01',
        nextInvoiceOn: '2026-12-01',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the latest logged time to the admin activity chip', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-30T12:00:00Z'));
    try {
      mockGetCurrentUser.mockResolvedValue({
        ...expert,
        id: 'user-admin',
        platformRole: 'admin',
        expertProfileId: null,
      });
      mockFindWithMilestones.mockResolvedValue(engagement({}));
      mockListEntries.mockResolvedValue([
        { id: 'te-1', createdAt: new Date('2026-11-10T09:00:00Z') },
        { id: 'te-2', createdAt: new Date('2026-11-29T09:00:00Z') },
      ]);
      const props = await renderPage();
      const view = props.view as { header: { terms: { label: string; value: string }[] } };
      expect(view.header.terms.find((t) => t.label === 'Last delivery activity')?.value).toBe(
        'Last delivery activity: 1d ago'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a sent change's estimate edit the hours already logged, from the loaded sums", async () => {
    mockFindWithMilestones.mockResolvedValue(engagement({ milestones: [BUILD] }));
    mockSums.mockResolvedValue({
      totalMinutes: 540,
      periodMinutes: 0,
      byMilestone: { 'ms-1': 540 },
    });
    mockListChangeOrders.mockResolvedValue([
      makeOrder({
        status: 'sent',
        note: 'Raises the build estimate.',
        sentAt: new Date('2026-10-20T00:00:00Z'),
        lines: [
          makeLine({
            op: 'edit',
            engagementMilestoneId: 'ms-1',
            title: 'Build',
            estimatedMinutes: 600,
            beforeTitle: 'Build',
            beforeEstimatedMinutes: 480,
          }),
        ],
      }),
    ]);
    const props = await renderPage();
    const changeOrders = props.changeOrders as {
      open: { lines: { loggedLabel: string | null }[] } | null;
    };
    expect(changeOrders.open?.lines[0]?.loggedLabel).toBe('9 hrs logged so far');
  });

  it('passes no time view and reads no entries for a fixed-price project', async () => {
    mockFindWithMilestones.mockResolvedValue(engagement({ pricingMethod: 'fixed' }));
    const props = await renderPage();
    expect(props.time).toBeNull();
    expect(mockListEntries).not.toHaveBeenCalled();
    expect(mockSums).not.toHaveBeenCalled();
    expect(mockHasDeliveryCapability).not.toHaveBeenCalled();
  });

  it('lets the viewer log time when they hold manage_engagement on an active project', async () => {
    mockFindWithMilestones.mockResolvedValue(
      engagement({
        milestones: [BUILD],
      })
    );
    const props = await renderPage();
    expect(mockHasDeliveryCapability).toHaveBeenCalledWith(
      expert,
      'manage_engagement',
      'expert-1',
      { contextType: 'project', contextId: ENGAGEMENT_ID }
    );
    const time = props.time as { byMilestoneId: Record<string, { canLog: boolean }> };
    expect(time.byMilestoneId['ms-1']?.canLog).toBe(true);
  });

  it.each([
    ['an agency owner/admin', 'agency-admin-1', null, true, false, true],
    ['a delivering expert who owns the agency', 'user-expert', 'expert-1', true, true, true],
    ['a delivering expert with agency role expert', 'user-expert', 'expert-1', false, true, false],
  ])(
    "for %s: Log time %s, edit and delete on another author's entry %s",
    async (_name, id, expertProfileId, administers, canLog, canChange) => {
      mockAdministers.mockResolvedValue(administers);
      mockGetCurrentUser.mockResolvedValue({ ...expert, id, expertProfileId });
      mockFindWithMilestones.mockResolvedValue(engagement({ milestones: [BUILD] }));
      mockListEntries.mockResolvedValue([
        {
          id: 'te-1',
          engagementMilestoneId: 'ms-1',
          userId: 'user-someone',
          authorFirstName: 'Sam',
          updatedByUserId: null,
          editorFirstName: null,
          editorLastName: null,
          workedOn: '2026-10-14',
          minutes: 60,
          note: '',
          createdAt: new Date('2026-10-14T10:00:00Z'),
        },
      ]);
      const props = await renderPage();
      const time = props.time as {
        byMilestoneId: Record<
          string,
          { canLog: boolean; entries: { canEdit: boolean; canDelete: boolean }[] }
        >;
      };
      expect(time.byMilestoneId['ms-1']?.canLog).toBe(canLog);
      expect(time.byMilestoneId['ms-1']?.entries[0]).toEqual(
        expect.objectContaining({ canEdit: canChange, canDelete: canChange })
      );
    }
  );

  it.each([
    ['the agency admin', 'agency-admin-1', null, 'Dana @ CloudPeak'],
    ['the delivering expert', 'user-expert', 'expert-1', 'Priya'],
  ])('names %s as the optimistic completer: %s', async (_name, id, expertProfileId, expected) => {
    mockGetCurrentUser.mockResolvedValue({
      ...expert,
      id,
      expertProfileId,
      firstName: 'Dana',
      lastName: 'Lee',
    });
    const base = engagement({});
    mockFindWithMilestones.mockResolvedValue(
      engagement({
        milestones: [BUILD],
        expertProfile: {
          ...base.expertProfile,
          agencyId: 'agency-1',
          type: 'agency',
          agency: { id: 'agency-1', name: 'CloudPeak' },
        },
      } as Partial<ProjectEngagementWithMilestones>)
    );
    const props = await renderPage();
    expect(props.viewerCompleterLabel).toBe(expected);
  });

  it('lets the role-expert deliverer change their own entry only', async () => {
    mockFindWithMilestones.mockResolvedValue(engagement({ milestones: [BUILD] }));
    const row = (id: string, userId: string) => ({
      id,
      engagementMilestoneId: 'ms-1',
      userId,
      authorFirstName: 'X',
      updatedByUserId: null,
      editorFirstName: null,
      editorLastName: null,
      workedOn: '2026-10-14',
      minutes: 60,
      note: '',
      createdAt: new Date('2026-10-14T10:00:00Z'),
    });
    mockListEntries.mockResolvedValue([row('mine', 'user-expert'), row('theirs', 'user-someone')]);
    const props = await renderPage();
    const time = props.time as {
      byMilestoneId: Record<string, { entries: { id: string; canEdit: boolean }[] }>;
    };
    expect(time.byMilestoneId['ms-1']?.entries.map((e) => [e.id, e.canEdit])).toEqual([
      ['mine', true],
      ['theirs', false],
    ]);
  });

  it('withholds logging without the capability, and never asks once the project is not active', async () => {
    const milestones = [BUILD];
    mockHasDeliveryCapability.mockResolvedValue(false);
    mockFindWithMilestones.mockResolvedValue(engagement({ milestones }));
    const denied = (await renderPage()).time as {
      byMilestoneId: Record<string, { canLog: boolean }>;
    };
    expect(denied.byMilestoneId['ms-1']?.canLog).toBe(false);

    mockHasDeliveryCapability.mockClear();
    mockFindWithMilestones.mockResolvedValue(
      engagement({ status: 'pending_acceptance', milestones })
    );
    await renderPage();
    expect(mockHasDeliveryCapability).not.toHaveBeenCalled();
  });
});

describe('EngagementWorkspacePage — cancel menu capability', () => {
  it.each([true, false])(
    'threads the platform capability (%s) as canCancelEngagement',
    async (held) => {
      mockHasPlatformCapability.mockImplementation(
        (_user: unknown, capability: string) => held && capability === 'cancel_any_engagement'
      );
      mockFindWithMilestones.mockResolvedValue(engagement({ pricingMethod: 'fixed' }));
      const props = await renderPage();
      expect(props.canCancelEngagement).toBe(held);
      expect(mockHasPlatformCapability).toHaveBeenCalledWith(expert, 'cancel_any_engagement');
    }
  );
});
