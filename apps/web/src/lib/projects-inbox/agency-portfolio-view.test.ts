import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockListPortfolio, mockMemberIds, mockLiveCounts } = vi.hoisted(() => ({
  mockListPortfolio: vi.fn(),
  mockMemberIds: vi.fn(),
  mockLiveCounts: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  projectEngagementsRepository: {
    listPortfolio: (...args: unknown[]) => mockListPortfolio(...args),
    countLiveByAgency: (...args: unknown[]) => mockLiveCounts(...args),
  },
  partyMembershipsRepository: {
    listMemberUserIds: (...args: unknown[]) => mockMemberIds(...args),
  },
  AUTO_ACCEPT_DAYS: 7,
}));

import { loadAgencyPortfolio } from './agency-portfolio-view';
import type { SessionUser } from '@/lib/auth/session';

const NOW = new Date('2026-06-16T12:00:00.000Z');
const day = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

const USER = { id: 'owner-1', expertProfileId: 'prof-owner' } as SessionUser;
const CLOUDLINE = { id: 'ag-1', name: 'Cloudline Partners' };
const AGENCIES = [CLOUDLINE, { id: 'ag-2', name: 'Zenith' }];

interface EngOverrides {
  id?: string;
  status?: string;
  changeRequestNote?: string | null;
  profileId?: string;
  userId?: string;
  lastActivityAt?: Date | null;
  completionRequestedAt?: Date | null;
  projectRequest?: { id: string; title: string } | null;
}

function eng(o: EngOverrides = {}): unknown {
  return {
    id: o.id ?? 'eng-1',
    status: o.status ?? 'active',
    changeRequestNote: o.changeRequestNote ?? null,
    completionRequestedAt: o.completionRequestedAt ?? null,
    createdAt: day(30),
    lastActivityAt: o.lastActivityAt === undefined ? day(1) : o.lastActivityAt,
    totalMilestones: 5,
    completedMilestones: 3,
    company: { id: 'c1', name: 'Northwind Industrial' },
    projectRequest:
      o.projectRequest === undefined
        ? { id: 'pr1', title: 'CPQ implementation' }
        : o.projectRequest,
    expertProfile: {
      id: o.profileId ?? 'prof-priya',
      user: {
        id: o.userId ?? 'user-priya',
        firstName: 'Priya',
        lastName: 'Shah',
        avatarUrl: null,
      },
    },
  };
}

describe('loadAgencyPortfolio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMemberIds.mockResolvedValue(['user-priya', 'owner-1']);
    mockLiveCounts.mockResolvedValue(new Map([['ag-1', 2]]));
  });

  it('falls back to the first agency for an unknown id', async () => {
    mockListPortfolio.mockResolvedValue([]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, 'ag-other', ['client', 'agency'], NOW);
    expect(dto.agency).toEqual({ id: 'ag-1', name: 'Cloudline Partners' });
    expect(mockListPortfolio).toHaveBeenCalledWith({ agencyId: 'ag-1' });
  });

  it('honours a requested agency the viewer oversees', async () => {
    mockListPortfolio.mockResolvedValue([]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, 'ag-2', ['client', 'agency'], NOW);
    expect(dto.agency.id).toBe('ag-2');
    expect(dto.agencies).toEqual([
      { id: 'ag-1', name: 'Cloudline Partners', liveCount: 2 },
      { id: 'ag-2', name: 'Zenith', liveCount: 0 },
    ]);
  });

  it('skips the picker count query for a single agency', async () => {
    mockListPortfolio.mockResolvedValue([]);
    const dto = await loadAgencyPortfolio(USER, [CLOUDLINE], undefined, ['agency'], NOW);
    expect(mockLiveCounts).not.toHaveBeenCalled();
    expect(dto.agencies).toEqual([{ id: 'ag-1', name: 'Cloudline Partners', liveCount: 0 }]);
  });

  it('marks a departed expert as a former member', async () => {
    mockMemberIds.mockResolvedValue(['owner-1']);
    mockListPortfolio.mockResolvedValue([eng()]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, undefined, ['agency'], NOW);
    expect(dto.rows[0]?.deliverer.isFormerMember).toBe(true);
  });

  it('flags the viewer own engagement as isViewer', async () => {
    mockListPortfolio.mockResolvedValue([eng({ profileId: 'prof-owner', userId: 'owner-1' })]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, undefined, ['agency'], NOW);
    expect(dto.rows[0]?.deliverer).toMatchObject({ isViewer: true, isFormerMember: false });
  });

  it('changes requested carries the note, a ?from=agency href and no needs-you field', async () => {
    mockListPortfolio.mockResolvedValue([
      eng({ changeRequestNote: 'Please rework the quote flow' }),
    ]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, undefined, ['agency'], NOW);
    const [row] = dto.rows;
    expect(row).toMatchObject({
      deliveryState: 'changes_requested',
      changeRequestNote: 'Please rework the quote flow',
      href: '/engagements/eng-1?from=agency',
      detailLabel: '3 of 5 milestones',
    });
    expect(row).not.toHaveProperty('needsYou');
  });

  it('orders changes requested, awaiting review, then in delivery by recency; finished apart', async () => {
    mockListPortfolio.mockResolvedValue([
      eng({ id: 'old-delivery', lastActivityAt: day(5) }),
      eng({ id: 'new-delivery', lastActivityAt: day(1) }),
      eng({ id: 'review', status: 'pending_acceptance', completionRequestedAt: day(2) }),
      eng({ id: 'changes', changeRequestNote: 'Rework', lastActivityAt: day(9) }),
      eng({ id: 'done', status: 'completed' }),
      eng({ id: 'gone', status: 'cancelled', projectRequest: null }),
    ]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, undefined, ['agency'], NOW);
    expect(dto.rows.map((r) => r.id)).toEqual([
      'changes',
      'review',
      'new-delivery',
      'old-delivery',
    ]);
    expect(dto.finishedRows.map((r) => r.id).sort()).toEqual(['done', 'gone']);
    expect(dto.rows.find((r) => r.id === 'review')?.detailLabel).toBe('Auto-accepts 21 Jun');
    expect(dto.finishedRows.find((r) => r.id === 'gone')?.title).toBe('Ongoing engagement');
    expect(dto.tiles).toEqual({
      changesRequested: 1,
      inDelivery: 2,
      pendingAcceptance: 1,
      live: 4,
      expertCount: 1,
    });
    expect(dto.isEmpty).toBe(false);
  });

  it('is empty only when there are no rows at all', async () => {
    mockListPortfolio.mockResolvedValue([]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, undefined, ['agency'], NOW);
    expect(dto.isEmpty).toBe(true);
  });

  it('is not empty when only finished work exists', async () => {
    mockListPortfolio.mockResolvedValue([eng({ status: 'completed' })]);
    const dto = await loadAgencyPortfolio(USER, AGENCIES, undefined, ['agency'], NOW);
    expect(dto.isEmpty).toBe(false);
    expect(dto.rows).toEqual([]);
  });

  it('throws for an empty agency list', async () => {
    await expect(loadAgencyPortfolio(USER, [], undefined, ['agency'], NOW)).rejects.toThrow();
  });
});
