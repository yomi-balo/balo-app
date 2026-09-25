import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindTitles = vi.fn();
const mockFindExpertPartyNames = vi.fn();
const mockFindLivePendingByMeetingIds = vi.fn();

vi.mock('@balo/db', () => ({
  upcomingMeetingsRepository: {
    findTitles: (...args: unknown[]) => mockFindTitles(...args),
    findExpertPartyNames: (...args: unknown[]) => mockFindExpertPartyNames(...args),
  },
  rescheduleProposalsRepository: {
    findLivePendingByMeetingIds: (...args: unknown[]) => mockFindLivePendingByMeetingIds(...args),
  },
}));

import {
  buildUpNextRowViews,
  toUpNextRowView,
  type UpNextEnrichableRow,
} from './build-up-next-rows';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { UP_NEXT_ROW_VIEW_KEYS } from './up-next-view-types';

const EMPTY_TITLES = {
  caseTitleByEngagementId: new Map(),
  kickoffRequestTitleByEngagementId: new Map(),
  requestTitleById: new Map(),
};

function row(overrides: Partial<UpNextEnrichableRow> = {}): UpNextEnrichableRow {
  return {
    meetingId: 'meeting-1',
    scheduledStart: new Date('2026-09-17T14:00:00.000Z'),
    scheduledEnd: new Date('2026-09-17T14:30:00.000Z'),
    status: 'scheduled',
    contextType: 'case',
    contextId: 'engagement-1',
    projectRequestId: null,
    owningRowFound: true,
    expertProfileId: 'profile-1',
    counterpartyCompanyName: null,
    roomReady: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindTitles.mockResolvedValue(EMPTY_TITLES);
  mockFindExpertPartyNames.mockResolvedValue([]);
  mockFindLivePendingByMeetingIds.mockResolvedValue([]);
});

describe('buildUpNextRowViews — empty input', () => {
  it('[] in -> [] out with zero queries', async () => {
    const result = await buildUpNextRowViews([], 'company');
    expect(result).toEqual([]);
    expect(mockFindTitles).not.toHaveBeenCalled();
    expect(mockFindExpertPartyNames).not.toHaveBeenCalled();
    expect(mockFindLivePendingByMeetingIds).not.toHaveBeenCalled();
  });
});

describe('buildUpNextRowViews — titles', () => {
  it('resolves a case title', async () => {
    mockFindTitles.mockResolvedValue({
      ...EMPTY_TITLES,
      caseTitleByEngagementId: new Map([['engagement-1', 'Salesforce health check']]),
    });
    const [view] = await buildUpNextRowViews([row({ contextType: 'case' })], 'company');
    expect(view?.title).toBe('Salesforce health check');
    expect(mockFindTitles).toHaveBeenCalledWith({
      caseEngagementIds: ['engagement-1'],
      kickoffEngagementIds: [],
      projectRequestIds: [],
    });
  });

  it('resolves a discovery/intro request title via projectRequestId', async () => {
    mockFindTitles.mockResolvedValue({
      ...EMPTY_TITLES,
      requestTitleById: new Map([['req-1', 'CPQ rollout']]),
    });
    const [view] = await buildUpNextRowViews(
      [row({ contextType: 'project_discovery', contextId: 'req-1', projectRequestId: 'req-1' })],
      'company'
    );
    expect(view?.title).toBe('CPQ rollout');
  });

  it('kickoff fallback: agency expert with no request title -> "Delivery with {agency}"', async () => {
    mockFindTitles.mockResolvedValue({
      ...EMPTY_TITLES,
      kickoffRequestTitleByEngagementId: new Map([['eng-1', null]]),
    });
    mockFindExpertPartyNames.mockResolvedValue([
      {
        expertProfileId: 'profile-1',
        type: 'agency',
        firstName: 'Priya',
        lastName: 'Sharma',
        agencyName: 'CloudPeak',
      },
    ]);
    const [view] = await buildUpNextRowViews(
      [row({ contextType: 'project_kickoff', contextId: 'eng-1' })],
      'company'
    );
    expect(view?.title).toBe('Delivery with CloudPeak');
  });

  it('kickoff fallback: independent expert -> "Delivery with {person}"', async () => {
    mockFindTitles.mockResolvedValue({
      ...EMPTY_TITLES,
      kickoffRequestTitleByEngagementId: new Map([['eng-1', null]]),
    });
    mockFindExpertPartyNames.mockResolvedValue([
      {
        expertProfileId: 'profile-1',
        type: 'freelancer',
        firstName: 'Priya',
        lastName: 'Sharma',
        agencyName: null,
      },
    ]);
    const [view] = await buildUpNextRowViews(
      [row({ contextType: 'project_kickoff', contextId: 'eng-1' })],
      'company'
    );
    // Independent experts resolve the party to the SHORT (first-name) label, not the full name —
    // `deriveExpertPartyLabels`'s `expertPartyShort = expertPersonShort` when not agency-typed.
    expect(view?.title).toBe('Delivery with Priya');
  });

  it('kickoff fallback: names missing entirely -> "Delivery with the expert"', async () => {
    mockFindTitles.mockResolvedValue({
      ...EMPTY_TITLES,
      kickoffRequestTitleByEngagementId: new Map([['eng-1', null]]),
    });
    mockFindExpertPartyNames.mockResolvedValue([]);
    const [view] = await buildUpNextRowViews(
      [row({ contextType: 'project_kickoff', contextId: 'eng-1' })],
      'company'
    );
    expect(view?.title).toBe('Delivery with the expert');
  });

  it('an unverified expert-side row has a null title and its ids are NOT passed to findTitles', async () => {
    const unverified = row({
      contextType: 'case',
      owningRowFound: false,
      contextId: null,
      expertProfileId: null,
    });
    const [view] = await buildUpNextRowViews([unverified], 'expert');
    expect(view?.title).toBeNull();
    expect(mockFindTitles).toHaveBeenCalledWith({
      caseEngagementIds: [],
      kickoffEngagementIds: [],
      projectRequestIds: [],
    });
  });
});

describe('buildUpNextRowViews — counterparty (company workspace)', () => {
  it('an agency expert: person name + agency org label', async () => {
    mockFindExpertPartyNames.mockResolvedValue([
      {
        expertProfileId: 'profile-1',
        type: 'agency',
        firstName: 'Priya',
        lastName: 'Sharma',
        agencyName: 'CloudPeak',
      },
    ]);
    const [view] = await buildUpNextRowViews([row()], 'company');
    expect(view?.counterpartyName).toBe('Priya Sharma');
    expect(view?.counterpartyOrgLabel).toBe('CloudPeak');
  });

  it('an independent expert: org label is null', async () => {
    mockFindExpertPartyNames.mockResolvedValue([
      {
        expertProfileId: 'profile-1',
        type: 'freelancer',
        firstName: 'Priya',
        lastName: 'Sharma',
        agencyName: null,
      },
    ]);
    const [view] = await buildUpNextRowViews([row()], 'company');
    expect(view?.counterpartyOrgLabel).toBeNull();
  });

  it('a match-routed discovery request (no expert) shows "Balo"', async () => {
    const [view] = await buildUpNextRowViews(
      [
        row({
          contextType: 'project_discovery',
          contextId: 'req-1',
          projectRequestId: 'req-1',
          expertProfileId: null,
        }),
      ],
      'company'
    );
    expect(view?.counterpartyName).toBe('Balo');
    expect(view?.counterpartyOrgLabel).toBeNull();
  });

  it('names missing -> "An expert"', async () => {
    mockFindExpertPartyNames.mockResolvedValue([]);
    const [view] = await buildUpNextRowViews([row()], 'company');
    expect(view?.counterpartyName).toBe('An expert');
  });
});

describe('buildUpNextRowViews — counterparty (expert workspace)', () => {
  it('is the client company the calendar read already resolved', async () => {
    const [view] = await buildUpNextRowViews(
      [row({ counterpartyCompanyName: 'Northwind Industrial' })],
      'expert'
    );
    expect(view?.counterpartyName).toBe('Northwind Industrial');
    expect(view?.counterpartyOrgLabel).toBeNull();
  });
});

describe('buildUpNextRowViews — href and joinPath', () => {
  it('href resolves through hrefForMeeting and joinPath through memberCallPath (BAL-566 fix round 1, F1)', async () => {
    const [view] = await buildUpNextRowViews(
      [row({ meetingId: 'm-42', contextType: 'case', contextId: 'engagement-1' })],
      'company'
    );
    expect(view?.href).toBe('/cases/engagement-1');
    expect(view?.joinPath).toBe(memberCallPath('m-42'));
    expect(view?.joinPath).toBe('/meetings/m-42/call');
  });

  it('an unverified row has a null href but still carries a joinPath', async () => {
    const [view] = await buildUpNextRowViews(
      [row({ meetingId: 'm-9', owningRowFound: false, contextId: null })],
      'expert'
    );
    expect(view?.href).toBeNull();
    expect(view?.joinPath).toBe(memberCallPath('m-9'));
  });
});

describe('buildUpNextRowViews — reschedule proposals', () => {
  it('proposals are fetched only for case meeting ids', async () => {
    await buildUpNextRowViews(
      [
        row({ meetingId: 'case-1', contextType: 'case' }),
        row({ meetingId: 'kickoff-1', contextType: 'project_kickoff', contextId: 'eng-2' }),
      ],
      'company'
    );
    expect(mockFindLivePendingByMeetingIds).toHaveBeenCalledWith(['case-1']);
  });

  it('maps the expiry to an ISO string on the matching case row only', async () => {
    const expiresAt = new Date('2026-09-20T00:00:00.000Z');
    mockFindLivePendingByMeetingIds.mockResolvedValue([
      {
        proposalId: 'p-1',
        meetingId: 'case-1',
        originalScheduledStart: new Date(),
        expiresAt,
        optionCount: 2,
      },
    ]);
    const [caseView, kickoffView] = await buildUpNextRowViews(
      [
        row({ meetingId: 'case-1', contextType: 'case' }),
        row({ meetingId: 'kickoff-1', contextType: 'project_kickoff', contextId: 'eng-2' }),
      ],
      'company'
    );
    expect(caseView?.rescheduleProposalExpiresAt).toBe(expiresAt.toISOString());
    expect(kickoffView?.rescheduleProposalExpiresAt).toBeNull();
  });
});

describe('toUpNextRowView — view-model key set (BAL-566 §11)', () => {
  const NO_MONEY_PATTERN =
    /cents|rate|fee|price|amount|balance|email|joinurl|room|token|workos|phone/i;
  // BAL-581 — `roomReady` matches `/room/i` but is a readiness boolean, not a room locator.
  // Exempt it BY NAME rather than weakening the pattern, which must keep rejecting roomName,
  // roomUrl and dailyRoomName.
  const READINESS_BOOLEAN_KEYS: readonly string[] = ['roomReady'];
  const lookups = {
    titles: EMPTY_TITLES,
    partyNamesByProfileId: new Map(),
    proposalExpiryByMeetingId: new Map(),
  };

  it('the produced view carries exactly UP_NEXT_ROW_VIEW_KEYS, even when the input smuggles secrets', () => {
    // Smuggle extra fields through `unknown` to prove the projection is field-by-field, never a
    // spread of the enrichable row.
    const smuggled = {
      ...row(),
      dailyRoomName: 'room-xyz',
      joinUrl: 'https://daily.example/room-xyz',
      rateCents: 31300,
      priceCents: 5000,
      email: 'expert@example.com',
      workosId: 'workos_123',
    } as unknown as UpNextEnrichableRow;

    const view = toUpNextRowView(smuggled, lookups, 'company');
    const keys = Object.keys(view).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual([...UP_NEXT_ROW_VIEW_KEYS].sort((a, b) => a.localeCompare(b)));
    for (const key of keys.filter((k) => !READINESS_BOOLEAN_KEYS.includes(k))) {
      expect(key).not.toMatch(NO_MONEY_PATTERN);
    }
    expect(typeof view.roomReady).toBe('boolean');
    expect(view).not.toHaveProperty('dailyRoomName');
    expect(view).not.toHaveProperty('joinUrl');
    expect(JSON.stringify(view)).not.toContain('room-xyz');
    expect(JSON.stringify(view)).not.toContain('daily.example');
  });

  it('BAL-581 — roomReady is COPIED THROUGH, not recomputed', () => {
    expect(toUpNextRowView(row({ roomReady: false }), lookups, 'company').roomReady).toBe(false);
    expect(toUpNextRowView(row({ roomReady: true }), lookups, 'company').roomReady).toBe(true);
  });

  it('the same holds through buildUpNextRowViews with mocked repositories returning smuggled fields', async () => {
    mockFindExpertPartyNames.mockResolvedValue([
      {
        expertProfileId: 'profile-1',
        type: 'freelancer',
        firstName: 'Priya',
        lastName: 'Sharma',
        agencyName: null,
        rateCents: 31300,
        email: 'expert@example.com',
      },
    ]);
    const [view] = await buildUpNextRowViews([row()], 'company');
    const keys = Object.keys(view ?? {}).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual([...UP_NEXT_ROW_VIEW_KEYS].sort((a, b) => a.localeCompare(b)));
  });
});
