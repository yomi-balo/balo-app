import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindDisplayProfile,
  mockAgencySummary,
  mockFindUser,
  mockListContexts,
  mockResolveOwner,
  mockWarn,
} = vi.hoisted(() => ({
  mockFindDisplayProfile: vi.fn(),
  mockAgencySummary: vi.fn(),
  mockFindUser: vi.fn(),
  mockListContexts: vi.fn(),
  mockResolveOwner: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: { findDisplayProfileById: mockFindDisplayProfile },
  agenciesRepository: { getSummaryById: mockAgencySummary },
  usersRepository: { findById: mockFindUser },
  meetingContextsRepository: { listByMeeting: mockListContexts },
  resolveMeetingContextOwner: mockResolveOwner,
}));
// ⚠ `@balo/shared/meetings` is NOT mocked — `selectPrimaryMeetingContext` is the SAME precedence
// rule the participation gate applies, and mocking it would let this module resolve a different
// context from the one that gate resolved, which is exactly the drift these tests exist to deny.

import {
  deliveringAgencyIdForOwner,
  deliveringContextOwnerForMeeting,
  deliveringExpertProfileIdForMeeting,
  deliveringExpertUserId,
  deliveringPartyName,
} from './delivering-party.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const EXPERT_PROFILE_ID = '77777777-7777-4777-8777-777777777777';
const EXPERT_USER_ID = '99999999-9999-4999-8999-999999999999';
const AGENCY_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_AGENCY_ID = '66666666-6666-4666-8666-666666666666';

/** A request-grain owner: the agency is read from the expert profile's current link. */
function profileOwner(): NonNullable<Parameters<typeof deliveringPartyName>[0]> {
  return { expertProfileId: EXPERT_PROFILE_ID, deliveringAgency: { from: 'expert_profile' } };
}

/** An engagement-grain owner carrying the engagement's pin. */
function pinnedOwner(
  deliveringAgencyId: string | null
): NonNullable<Parameters<typeof deliveringPartyName>[0]> {
  return {
    expertProfileId: EXPERT_PROFILE_ID,
    deliveringAgency: { from: 'engagement', deliveringAgencyId },
  };
}

describe('deliveringExpertUserId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the consultant the booking names', async () => {
    mockFindDisplayProfile.mockResolvedValue({
      id: EXPERT_PROFILE_ID,
      userId: EXPERT_USER_ID,
      agencyId: null,
    });

    await expect(deliveringExpertUserId(EXPERT_PROFILE_ID)).resolves.toBe(EXPERT_USER_ID);
    expect(mockFindDisplayProfile).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });

  /**
   * ⚠ A CONTEXT THAT NAMES NOBODY IS A REAL ANSWER, NOT A LOOKUP FAILURE — a `match`-routed
   * `project_discovery` and an `admin` meeting both have no delivering expert. Answering `null`
   * without a query is what keeps the presence writer's `delivering === userId` test false for
   * everybody rather than accidentally true for somebody.
   */
  it('⚠ answers null WITHOUT a query when the context names no expert', async () => {
    await expect(deliveringExpertUserId(null)).resolves.toBeNull();
    expect(mockFindDisplayProfile).not.toHaveBeenCalled();
  });

  it('⚠ warns and answers null when the named profile is not there — an integrity signal', async () => {
    mockFindDisplayProfile.mockResolvedValue(undefined);

    await expect(deliveringExpertUserId(EXPERT_PROFILE_ID)).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: EXPERT_PROFILE_ID }),
      expect.stringContaining('not there')
    );
  });

  /**
   * ⚠ THE DISPLAY READ, NOT `findProfileById`. It projects eight columns and structurally cannot
   * carry `rateCents` — the UN-MARKED-UP consultant rate — nor `stripeConnectId`. Nothing here
   * renders, but the narrow read keeps those columns off a path that feeds a notification
   * payload.
   */
  it('⚠ uses the DISPLAY projection, which cannot carry rateCents', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });

    await deliveringExpertUserId(EXPERT_PROFILE_ID);

    expect(mockFindDisplayProfile).toHaveBeenCalledTimes(1);
  });
});

describe('deliveringExpertProfileIdForMeeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListContexts.mockResolvedValue([
      { meetingId: MEETING_ID, contextType: 'case', contextId: 'ctx-1' },
    ]);
    mockResolveOwner.mockResolvedValue({
      companyId: 'company-1',
      expertProfileId: EXPERT_PROFILE_ID,
      deliveringAgency: { from: 'expert_profile' },
    });
  });

  it('resolves through the meeting’s PRIMARY context', async () => {
    await expect(deliveringExpertProfileIdForMeeting(MEETING_ID)).resolves.toBe(EXPERT_PROFILE_ID);
    expect(mockListContexts).toHaveBeenCalledWith(MEETING_ID);
  });

  it('answers null when the meeting has no resolvable primary context', async () => {
    mockListContexts.mockResolvedValue([]);

    await expect(deliveringExpertProfileIdForMeeting(MEETING_ID)).resolves.toBeNull();
    expect(mockResolveOwner).not.toHaveBeenCalled();
  });

  it('answers null when the owning party cannot be resolved', async () => {
    mockResolveOwner.mockResolvedValue(undefined);

    await expect(deliveringExpertProfileIdForMeeting(MEETING_ID)).resolves.toBeNull();
  });

  it('answers null for a context whose owner names no expert (a match-routed discovery)', async () => {
    mockResolveOwner.mockResolvedValue({
      companyId: 'company-1',
      expertProfileId: null,
      deliveringAgency: { from: 'expert_profile' },
    });

    await expect(deliveringExpertProfileIdForMeeting(MEETING_ID)).resolves.toBeNull();
  });
});

/**
 * ⚠⚠ CLAUDE.md'S PROSPECTIVE-ATTRIBUTION RULE, EXECUTED. Copy about who is WAITING is
 * prospective, so it names the PARTY: an agency-based expert's agency, an independent expert's
 * own name. Naming the individual consultant on behalf of an agency would be the wrong
 * attribution grain, and inventing a name at all would be a lie on a delivery surface.
 */
describe('deliveringPartyName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('⚠ names the AGENCY for an agency-based expert — never the individual', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: AGENCY_ID });
    mockAgencySummary.mockResolvedValue({ id: AGENCY_ID, name: 'CloudPeak', memberCount: 4 });

    await expect(deliveringPartyName(profileOwner())).resolves.toBe('CloudPeak');
    expect(mockFindUser).not.toHaveBeenCalled();
  });

  it('⚠ an INDEPENDENT expert is their own party and keeps their own name', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });
    mockFindUser.mockResolvedValue({ id: EXPERT_USER_ID, firstName: 'Sam', lastName: 'Okafor' });

    await expect(deliveringPartyName(profileOwner())).resolves.toBe('Sam Okafor');
    expect(mockAgencySummary).not.toHaveBeenCalled();
  });

  it('uses whichever half of the name exists', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });
    mockFindUser.mockResolvedValue({ id: EXPERT_USER_ID, firstName: 'Sam', lastName: null });

    await expect(deliveringPartyName(profileOwner())).resolves.toBe('Sam');
  });

  /** ⚠ `null` IS A FIRST-CLASS ANSWER — the templates render party-neutral copy for it. */
  const NULL_CASES: ReadonlyArray<{ label: string; arrange: () => void }> = [
    {
      label: 'the context names no expert',
      arrange: () => {
        /* expertProfileId is null — no arrangement needed */
      },
    },
    {
      label: 'the expert profile is gone',
      arrange: () => mockFindDisplayProfile.mockResolvedValue(undefined),
    },
    {
      label: 'the agency row is gone',
      arrange: () => {
        mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: AGENCY_ID });
        mockAgencySummary.mockResolvedValue(undefined);
      },
    },
    {
      label: 'the agency has a blank name',
      arrange: () => {
        mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: AGENCY_ID });
        mockAgencySummary.mockResolvedValue({ id: AGENCY_ID, name: '   ', memberCount: 1 });
      },
    },
    {
      label: 'the user row is gone',
      arrange: () => {
        mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });
        mockFindUser.mockResolvedValue(undefined);
      },
    },
    {
      label: 'the user has no name at all',
      arrange: () => {
        mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: null });
        mockFindUser.mockResolvedValue({ id: EXPERT_USER_ID, firstName: null, lastName: null });
      },
    },
  ];

  it.each(NULL_CASES)(
    '⚠ answers null rather than guessing when $label',
    async ({ label, arrange }) => {
      arrange();
      const owner =
        label === 'the context names no expert'
          ? { expertProfileId: null, deliveringAgency: { from: 'expert_profile' as const } }
          : profileOwner();

      await expect(deliveringPartyName(owner)).resolves.toBeNull();
    }
  );
});

describe('deliveringPartyName — engagement pin', () => {
  beforeEach(() => vi.clearAllMocks());

  it('⚠ names the PINNED agency, not the profile’s current agency', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: OTHER_AGENCY_ID });
    mockAgencySummary.mockResolvedValue({ id: AGENCY_ID, name: 'CloudPeak', memberCount: 4 });

    await expect(deliveringPartyName(pinnedOwner(AGENCY_ID))).resolves.toBe('CloudPeak');
    expect(mockAgencySummary).toHaveBeenCalledWith(AGENCY_ID);
    expect(mockAgencySummary).not.toHaveBeenCalledWith(OTHER_AGENCY_ID);
  });

  it('⚠ a NULL pin names the person and never falls back to the profile’s agency', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: OTHER_AGENCY_ID });
    mockFindUser.mockResolvedValue({ id: EXPERT_USER_ID, firstName: 'Sam', lastName: 'Okafor' });

    await expect(deliveringPartyName(pinnedOwner(null))).resolves.toBe('Sam Okafor');
    expect(mockAgencySummary).not.toHaveBeenCalled();
  });

  it('answers null for a null owner', async () => {
    await expect(deliveringPartyName(null)).resolves.toBeNull();
  });
});

describe('deliveringAgencyIdForOwner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the pin with no profile read for an engagement-grain owner', async () => {
    await expect(deliveringAgencyIdForOwner(pinnedOwner(AGENCY_ID))).resolves.toBe(AGENCY_ID);
    await expect(deliveringAgencyIdForOwner(pinnedOwner(null))).resolves.toBeNull();
    expect(mockFindDisplayProfile).not.toHaveBeenCalled();
  });

  it('reads the profile’s current agency for a request-grain owner', async () => {
    mockFindDisplayProfile.mockResolvedValue({ userId: EXPERT_USER_ID, agencyId: OTHER_AGENCY_ID });

    await expect(deliveringAgencyIdForOwner(profileOwner())).resolves.toBe(OTHER_AGENCY_ID);
  });

  it('is null for a request-grain owner naming no expert, or a missing profile', async () => {
    await expect(
      deliveringAgencyIdForOwner({
        expertProfileId: null,
        deliveringAgency: { from: 'expert_profile' },
      })
    ).resolves.toBeNull();
    mockFindDisplayProfile.mockResolvedValue(undefined);
    await expect(deliveringAgencyIdForOwner(profileOwner())).resolves.toBeNull();
  });
});

describe('deliveringContextOwnerForMeeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListContexts.mockResolvedValue([
      { meetingId: MEETING_ID, contextType: 'case', contextId: 'ctx-1' },
    ]);
  });

  it('returns the resolved owner', async () => {
    const owner = pinnedOwner(AGENCY_ID);
    mockResolveOwner.mockResolvedValue({ companyId: 'company-1', ...owner });

    await expect(deliveringContextOwnerForMeeting(MEETING_ID)).resolves.toEqual({
      companyId: 'company-1',
      ...owner,
    });
  });

  it('is null with no primary context or no resolvable owner', async () => {
    mockResolveOwner.mockResolvedValue(undefined);
    await expect(deliveringContextOwnerForMeeting(MEETING_ID)).resolves.toBeNull();
    mockListContexts.mockResolvedValue([]);
    await expect(deliveringContextOwnerForMeeting(MEETING_ID)).resolves.toBeNull();
  });
});
