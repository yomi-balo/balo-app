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
  loadNavCalls,
  navCallsWindow,
  NAV_CALLS_HORIZON_MS,
  NAV_CALLS_ROW_LIMIT,
} from './load-nav-calls';
import { log } from '@/lib/logging';
import { NAV_CALL_VIEW_KEYS } from './nav-call-view-types';
import { UP_NEXT_LOOKBACK_MS } from './select-up-next-rows';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const COMPANY_ID = 'company-1';
const ACTOR_ID = 'user-1';
const PROFILE_ID = 'profile-1';

const EMPTY_TITLES = {
  caseTitleByEngagementId: new Map(),
  kickoffRequestTitleByEngagementId: new Map(),
  requestTitleById: new Map(),
};

function minutesFromNow(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function companyMeeting(overrides: Record<string, unknown> = {}) {
  return {
    meetingId: 'm-company',
    scheduledStart: minutesFromNow(2),
    scheduledEnd: minutesFromNow(32),
    status: 'scheduled',
    contextType: 'case',
    contextId: 'eng-1',
    projectRequestId: null,
    expertProfileId: 'profile-9',
    owningRowFound: true,
    roomReady: true,
    ...overrides,
  };
}

function expertMeeting(overrides: Record<string, unknown> = {}) {
  return {
    meetingId: 'm-expert',
    scheduledStart: minutesFromNow(2),
    scheduledEnd: minutesFromNow(32),
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

function input(overrides: Partial<Parameters<typeof loadNavCalls>[0]> = {}) {
  return {
    actorUserId: ACTOR_ID,
    workspaceType: 'company' as const,
    companyId: COMPANY_ID,
    expertProfileId: null,
    now: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMemberRole.mockResolvedValue('member');
  mockListForCompany.mockResolvedValue([]);
  mockListCalendarForExpert.mockResolvedValue([]);
  mockFindTitles.mockResolvedValue(EMPTY_TITLES);
  mockFindExpertPartyNames.mockResolvedValue([]);
  mockFindLivePendingByMeetingIds.mockResolvedValue([]);
});

describe('navCallsWindow', () => {
  it('spans now − lookback .. now + 24h', () => {
    const { rangeStart, rangeEnd } = navCallsWindow(NOW);
    expect(rangeStart.getTime()).toBe(NOW.getTime() - UP_NEXT_LOOKBACK_MS);
    expect(rangeEnd.getTime()).toBe(NOW.getTime() + NAV_CALLS_HORIZON_MS);
    expect(NAV_CALLS_HORIZON_MS).toBe(24 * 60 * 60 * 1000);
    expect(NAV_CALLS_ROW_LIMIT).toBe(10);
  });
});

describe('loadNavCalls — company arm', () => {
  it('reads the company window and tags rows otherWorkspace: false', async () => {
    mockListForCompany.mockResolvedValue([companyMeeting()]);

    const calls = await loadNavCalls(input());

    expect(mockListForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      ...navCallsWindow(NOW),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ meetingId: 'm-company', otherWorkspace: false });
    expect(mockListCalendarForExpert).not.toHaveBeenCalled();
  });

  it('a non-participant skips the company read, warns, and still runs the expert arm', async () => {
    mockGetMemberRole.mockResolvedValue(undefined);
    mockListCalendarForExpert.mockResolvedValue([expertMeeting()]);

    const calls = await loadNavCalls(input({ expertProfileId: PROFILE_ID }));

    expect(mockListForCompany).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Nav calls company read skipped: viewer does not participate in the workspace company',
      expect.objectContaining({ userId: ACTOR_ID, companyId: COMPANY_ID })
    );
    expect(calls.map((c) => c.meetingId)).toEqual(['m-expert']);
  });

  it('skips the company arm without a companyId', async () => {
    const calls = await loadNavCalls(input({ companyId: null }));

    expect(calls).toEqual([]);
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockListForCompany).not.toHaveBeenCalled();
  });
});

describe('loadNavCalls — expert arm', () => {
  it('in the company workspace, the expert read runs and its rows carry otherWorkspace: true', async () => {
    mockListCalendarForExpert.mockResolvedValue([expertMeeting()]);

    const calls = await loadNavCalls(input({ expertProfileId: PROFILE_ID }));

    expect(mockListCalendarForExpert).toHaveBeenCalledWith({
      expertProfileId: PROFILE_ID,
      ...navCallsWindow(NOW),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ meetingId: 'm-expert', otherWorkspace: true });
  });

  it('in the expert workspace there is no company read and otherWorkspace is always false', async () => {
    mockListCalendarForExpert.mockResolvedValue([expertMeeting()]);

    const calls = await loadNavCalls(
      input({ workspaceType: 'expert', expertProfileId: PROFILE_ID })
    );

    expect(mockListForCompany).not.toHaveBeenCalled();
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ meetingId: 'm-expert', otherWorkspace: false });
  });

  it('does not run the expert arm without an expertProfileId', async () => {
    await loadNavCalls(input());
    expect(mockListCalendarForExpert).not.toHaveBeenCalled();
  });
});

describe('loadNavCalls — merge', () => {
  it('a meeting in both reads appears once, as the company row', async () => {
    mockListForCompany.mockResolvedValue([companyMeeting({ meetingId: 'm-both' })]);
    mockListCalendarForExpert.mockResolvedValue([expertMeeting({ meetingId: 'm-both' })]);

    const calls = await loadNavCalls(input({ expertProfileId: PROFILE_ID }));

    expect(calls).toHaveLength(1);
    // The company row names the delivering expert ("An expert" with no party names); the expert
    // row's name would be the client company, "Northwind Industrial".
    expect(calls[0]).toMatchObject({
      meetingId: 'm-both',
      otherWorkspace: false,
      counterpartyName: 'An expert',
    });
  });

  it('sorts the merged list by start then meeting id', async () => {
    mockListForCompany.mockResolvedValue([
      companyMeeting({ meetingId: 'm-b', scheduledStart: minutesFromNow(5) }),
      companyMeeting({ meetingId: 'm-z', scheduledStart: minutesFromNow(2) }),
    ]);
    mockListCalendarForExpert.mockResolvedValue([
      expertMeeting({ meetingId: 'm-a', scheduledStart: minutesFromNow(5) }),
      expertMeeting({ meetingId: 'm-c', scheduledStart: minutesFromNow(1) }),
    ]);

    const calls = await loadNavCalls(input({ expertProfileId: PROFILE_ID }));

    expect(calls.map((c) => c.meetingId)).toEqual(['m-c', 'm-z', 'm-a', 'm-b']);
    expect(calls.map((c) => c.otherWorkspace)).toEqual([true, false, true, false]);
  });

  it('drops rows whose join window has closed and caps at the row limit', async () => {
    const many = Array.from({ length: NAV_CALLS_ROW_LIMIT + 3 }, (_, i) =>
      companyMeeting({
        meetingId: `m-${String(i).padStart(2, '0')}`,
        scheduledStart: minutesFromNow(i + 1),
        scheduledEnd: minutesFromNow(i + 31),
      })
    );
    const closed = companyMeeting({
      meetingId: 'm-closed',
      scheduledStart: minutesFromNow(-180),
      scheduledEnd: minutesFromNow(-150),
    });
    mockListForCompany.mockResolvedValue([closed, ...many]);

    const calls = await loadNavCalls(input());

    expect(calls).toHaveLength(NAV_CALLS_ROW_LIMIT);
    expect(calls.map((c) => c.meetingId)).not.toContain('m-closed');
  });

  it('returns [] with no enrichment reads when nothing is selected', async () => {
    const calls = await loadNavCalls(input({ expertProfileId: PROFILE_ID }));

    expect(calls).toEqual([]);
    expect(mockFindTitles).not.toHaveBeenCalled();
  });
});

describe('loadNavCalls — wire shape', () => {
  it('projects exactly NAV_CALL_VIEW_KEYS and no other field', async () => {
    mockListForCompany.mockResolvedValue([companyMeeting()]);

    const [call] = await loadNavCalls(input());

    expect(call).toBeDefined();
    expect(Object.keys(call ?? {}).sort()).toEqual([...NAV_CALL_VIEW_KEYS].sort());
    expect(call?.joinPath).toBe('/meetings/m-company/call');
  });
});
