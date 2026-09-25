import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetMemberRole = vi.fn();
const mockListForCompany = vi.fn();
const mockListCalendarForExpert = vi.fn();
const mockFindTitles = vi.fn();
const mockFindExpertPartyNames = vi.fn();
const mockFindLivePendingByMeetingIds = vi.fn();

vi.mock('@balo/db', () => ({
  partyMembershipsRepository: { getMemberRole: (...a: unknown[]) => mockGetMemberRole(...a) },
  upcomingMeetingsRepository: {
    listForCompany: (...a: unknown[]) => mockListForCompany(...a),
    findTitles: (...a: unknown[]) => mockFindTitles(...a),
    findExpertPartyNames: (...a: unknown[]) => mockFindExpertPartyNames(...a),
  },
  meetingsRepository: {
    listCalendarForExpert: (...a: unknown[]) => mockListCalendarForExpert(...a),
  },
  rescheduleProposalsRepository: {
    findLivePendingByMeetingIds: (...a: unknown[]) => mockFindLivePendingByMeetingIds(...a),
  },
}));

vi.mock('@/lib/logging', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  loadCompanyUpNext,
  loadExpertUpNext,
  companyRowToEnrichable,
  expertRowToEnrichable,
} from './load-up-next';
import { log } from '@/lib/logging';
import { UP_NEXT_ROW_VIEW_KEYS } from './up-next-view-types';

/** `packages/db/src/repositories/meetings.ts`'s `MAX_CALENDAR_RANGE_DAYS` — mirrored here rather
 *  than imported, since `@balo/db` is mocked whole in this file. */
const MAX_CALENDAR_RANGE_DAYS = 35;

const NOW = new Date('2026-09-17T12:00:00.000Z');
const COMPANY_ID = 'company-1';
const ACTOR_ID = 'user-1';

const EMPTY_TITLES = {
  caseTitleByEngagementId: new Map(),
  kickoffRequestTitleByEngagementId: new Map(),
  requestTitleById: new Map(),
};

function companyMeeting(overrides: Record<string, unknown> = {}) {
  return {
    meetingId: 'm-1',
    scheduledStart: new Date(NOW.getTime() + 30 * 60_000),
    scheduledEnd: new Date(NOW.getTime() + 60 * 60_000),
    status: 'scheduled',
    contextType: 'case',
    contextId: 'eng-1',
    projectRequestId: null,
    expertProfileId: 'profile-1',
    owningRowFound: true,
    roomReady: true,
    ...overrides,
  };
}

function expertMeeting(overrides: Record<string, unknown> = {}) {
  return {
    meetingId: 'm-2',
    scheduledStart: new Date(NOW.getTime() + 30 * 60_000),
    scheduledEnd: new Date(NOW.getTime() + 60 * 60_000),
    status: 'scheduled',
    contextType: 'case',
    contextId: 'eng-2',
    engagementType: 'case',
    projectRequestId: null,
    counterpartyCompanyName: 'Northwind Industrial',
    owningRowFound: true,
    roomReady: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListForCompany.mockResolvedValue([]);
  mockListCalendarForExpert.mockResolvedValue([]);
  mockFindTitles.mockResolvedValue(EMPTY_TITLES);
  mockFindExpertPartyNames.mockResolvedValue([]);
  mockFindLivePendingByMeetingIds.mockResolvedValue([]);
});

describe('loadCompanyUpNext — R1 participation gate', () => {
  it('a non-participant gets null, listForCompany is never called, and a warning is logged', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    const result = await loadCompanyUpNext({
      actorUserId: ACTOR_ID,
      companyId: COMPANY_ID,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(mockListForCompany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Dashboard up next omitted: viewer does not participate in the workspace company',
      expect.objectContaining({
        userId: ACTOR_ID,
        companyId: COMPANY_ID,
        participation: 'not_a_member',
      })
    );
  });

  it('a member without PARTICIPATE also gets null', async () => {
    mockGetMemberRole.mockResolvedValue('spectator');
    const result = await loadCompanyUpNext({
      actorUserId: ACTOR_ID,
      companyId: COMPANY_ID,
      now: NOW,
    });
    expect(result).toBeNull();
    expect(mockListForCompany).not.toHaveBeenCalled();
  });

  it('a participant reaches listForCompany with the right window', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockListForCompany.mockResolvedValue([companyMeeting()]);
    const result = await loadCompanyUpNext({
      actorUserId: ACTOR_ID,
      companyId: COMPANY_ID,
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(mockListForCompany).toHaveBeenCalledTimes(1);
    const [args] = mockListForCompany.mock.calls[0] as [
      { companyId: string; rangeStart: Date; rangeEnd: Date },
    ];
    expect(args.companyId).toBe(COMPANY_ID);
    expect(args.rangeStart.getTime()).toBe(NOW.getTime() - 2 * 60 * 60 * 1000);
    expect(args.rangeEnd.getTime()).toBe(NOW.getTime() + 14 * 24 * 60 * 60 * 1000);
  });

  it('[] rows -> [] (Empty state), not null', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockListForCompany.mockResolvedValue([]);
    const result = await loadCompanyUpNext({
      actorUserId: ACTOR_ID,
      companyId: COMPANY_ID,
      now: NOW,
    });
    expect(result).toEqual([]);
  });
});

describe('loadExpertUpNext', () => {
  it('reaches listCalendarForExpert with a window under MAX_CALENDAR_RANGE_DAYS', async () => {
    mockListCalendarForExpert.mockResolvedValue([expertMeeting()]);
    const result = await loadExpertUpNext({ expertProfileId: 'profile-1', now: NOW });
    expect(result).toHaveLength(1);
    const [args] = mockListCalendarForExpert.mock.calls[0] as [
      { expertProfileId: string; rangeStart: Date; rangeEnd: Date },
    ];
    expect(args.expertProfileId).toBe('profile-1');
    const spanDays = (args.rangeEnd.getTime() - args.rangeStart.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeLessThan(MAX_CALENDAR_RANGE_DAYS);
  });

  it('never returns null, even with zero rows', async () => {
    mockListCalendarForExpert.mockResolvedValue([]);
    const result = await loadExpertUpNext({ expertProfileId: 'profile-1', now: NOW });
    expect(result).toEqual([]);
  });
});

describe('companyRowToEnrichable / expertRowToEnrichable — explicit projection', () => {
  it('companyRowToEnrichable nulls counterpartyCompanyName and carries the parent expertProfileId', () => {
    const enrichable = companyRowToEnrichable(
      companyMeeting({ expertProfileId: 'profile-9' }) as never
    );
    expect(enrichable.counterpartyCompanyName).toBeNull();
    expect(enrichable.expertProfileId).toBe('profile-9');
  });

  it('expertRowToEnrichable uses the SESSION profile id, never a field off the row', () => {
    const enrichable = expertRowToEnrichable(expertMeeting() as never, 'session-profile');
    expect(enrichable.expertProfileId).toBe('session-profile');
    expect(enrichable.counterpartyCompanyName).toBe('Northwind Industrial');
  });

  it('BAL-581 — both projections copy roomReady through, true and false', () => {
    expect(companyRowToEnrichable(companyMeeting({ roomReady: true }) as never).roomReady).toBe(
      true
    );
    expect(companyRowToEnrichable(companyMeeting({ roomReady: false }) as never).roomReady).toBe(
      false
    );
    expect(
      expertRowToEnrichable(expertMeeting({ roomReady: true }) as never, 'session-profile')
        .roomReady
    ).toBe(true);
    expect(
      expertRowToEnrichable(expertMeeting({ roomReady: false }) as never, 'session-profile')
        .roomReady
    ).toBe(false);
  });
});

describe('view-model key set through the loaders (BAL-566 §11)', () => {
  it('loadCompanyUpNext never leaks a smuggled field, even when the repository returns one', async () => {
    mockGetMemberRole.mockResolvedValue('member');
    mockListForCompany.mockResolvedValue([
      { ...companyMeeting(), rateCents: 31300, email: 'client@example.com' },
    ]);
    const rows = await loadCompanyUpNext({
      actorUserId: ACTOR_ID,
      companyId: COMPANY_ID,
      now: NOW,
    });
    const [row] = rows ?? [];
    const keys = Object.keys(row ?? {}).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual([...UP_NEXT_ROW_VIEW_KEYS].sort((a, b) => a.localeCompare(b)));
  });

  it('loadExpertUpNext never leaks a smuggled field either', async () => {
    mockListCalendarForExpert.mockResolvedValue([
      { ...expertMeeting(), dailyRoomName: 'room-1', joinUrl: 'https://daily.example/room-1' },
    ]);
    const rows = await loadExpertUpNext({ expertProfileId: 'profile-1', now: NOW });
    const [row] = rows;
    const keys = Object.keys(row ?? {}).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual([...UP_NEXT_ROW_VIEW_KEYS].sort((a, b) => a.localeCompare(b)));
  });
});
