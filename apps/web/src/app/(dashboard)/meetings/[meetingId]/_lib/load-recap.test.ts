import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_ID = 'b0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'd0000000-0000-4000-8000-000000000004';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';
const NOW = new Date('2026-08-12T12:00:00Z');

vi.mock('server-only', () => ({}));

const m = {
  listFiles: vi.fn(),
  listActionItems: vi.fn(),
  findTranscript: vi.fn(),
  findSession: vi.fn(),
  findCompany: vi.fn(),
  findProfile: vi.fn(),
  findCase: vi.fn(),
  listSiblings: vi.fn(),
  findArtifact: vi.fn(),
  findUser: vi.fn(),
  findNames: vi.fn(),
  findAgency: vi.fn(),
  findRequest: vi.fn(),
  findRelationship: vi.fn(),
  findLiveReview: vi.fn(),
};

vi.mock('@balo/db', () => ({
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
  meetingFilesRepository: { listByMeeting: (...a: unknown[]) => m.listFiles(...a) },
  actionItemsRepository: { listByMeeting: (...a: unknown[]) => m.listActionItems(...a) },
  transcriptsRepository: { findByMeetingId: (...a: unknown[]) => m.findTranscript(...a) },
  creditSessionsRepository: { findIdByMeetingId: (...a: unknown[]) => m.findSession(...a) },
  companiesRepository: { findNameById: (...a: unknown[]) => m.findCompany(...a) },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => m.findProfile(...a) },
  reviewsRepository: { findLive: (...a: unknown[]) => m.findLiveReview(...a) },
  caseEngagementsRepository: { findByEngagementId: (...a: unknown[]) => m.findCase(...a) },
  meetingContextsRepository: { listMeetingsForContext: (...a: unknown[]) => m.listSiblings(...a) },
  transcriptArtifactsRepository: {
    findByTranscriptAndKind: (...a: unknown[]) => m.findArtifact(...a),
  },
  usersRepository: {
    findDisplayById: (...a: unknown[]) => m.findUser(...a),
    findNamesByIds: (...a: unknown[]) => m.findNames(...a),
  },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => m.findAgency(...a) },
  projectRequestsRepository: { findById: (...a: unknown[]) => m.findRequest(...a) },
  requestExpertRelationshipsRepository: { findById: (...a: unknown[]) => m.findRelationship(...a) },
}));

const mockFetchMoneyBlock = vi.fn();
vi.mock('@/lib/api/session-money-block', () => ({
  fetchSessionMoneyBlock: (...a: unknown[]) => mockFetchMoneyBlock(...a),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/meetings/resolve-recap-access', () => ({
  resolveRecapAccess: (...a: unknown[]) => mockResolveAccess(...a),
}));

import { loadRecap } from './load-recap';

const MEETING = {
  id: MEETING_ID,
  status: 'ended',
  outcome: 'completed',
  scheduledStart: new Date('2026-07-29T04:00:00Z'),
  startedAt: new Date('2026-07-29T04:14:00Z'),
  endedAt: new Date('2026-07-29T04:59:00Z'),
  dailyRoomName: 'room-secret',
  joinUrl: 'https://daily.co/room-secret',
};

const CASE_ACCESS = {
  lens: 'client',
  meeting: MEETING,
  subject: { contextType: 'case', contextId: ENGAGEMENT_ID },
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
};

/**
 * The fixture deliberately seeds the columns a BARE relational hydrate would return, so the
 * concealment assertions cannot pass vacuously. `rateCents` is the load-bearing one: it is the
 * UN-MARKED-UP consultant rate, and the client lens already carries the all-in charge, so
 * exposing it would hand the client the Balo margin.
 */
const FAT_PROFILE = {
  userId: 'u-expert',
  agencyId: null,
  type: 'freelancer',
  headline: 'Salesforce CPQ specialist',
  username: 'amara',
  rateCents: 33_700,
  stripeConnectId: 'acct_secret_connect',
  cronofyUserId: 'cro_secret',
};

const AGENCY_PROFILE = {
  userId: 'u-expert',
  agencyId: 'agency-1',
  type: 'agency',
  headline: null,
  username: null,
};

const FAT_USER = {
  firstName: 'Amara',
  lastName: 'Okafor',
  avatarUrl: null,
  email: 'amara@cloudpeak.example',
  workosId: 'user_secret',
};

const OPEN_CASE = {
  engagementId: ENGAGEMENT_ID,
  title: 'Flow interview loop',
  closedAt: null,
  closeReason: null,
  resolutionRequestedAt: null,
  resolutionRequestedByUserId: null,
};

/**
 * ⚠ THE UNPROJECTED `credit_sessions` ROW — what `findIdByMeetingId` would hand back if its
 * `.select({ id })` were ever widened to a bare `.select()`. Seeded ONLY into the concealment
 * test: every other assertion here wants the projected `{ id }` the repository really returns.
 * Without a fat row anywhere, the JSON.stringify concealment assertions would pass on a payload
 * that never had anything to leak.
 */
const FAT_SESSION = {
  id: 'sess-1',
  walletId: 'wal-1',
  status: 'ended',
  baloFeeBps: 2500,
  expertRateMinorPerMinute: 41_250,
  expertAccruedMinor: 123_456,
  clientRateMinorPerMinute: 51_562,
  stripePaymentIntentId: 'pi_secret_intent',
};

interface RecapMockSeed {
  profile?: unknown;
  user?: unknown;
  names?: unknown[];
  agency?: unknown;
}

/**
 * ONE seed for every `beforeEach` in this file. Hoisted because the two blocks below had
 * drifted into near-identical 14-line copies — close enough to SonarJS's S4144 threshold that
 * one more shared line would have tripped the duplication gate.
 */
function seedRecapMocks(seed: RecapMockSeed = {}): void {
  vi.clearAllMocks();
  mockResolveAccess.mockResolvedValue(CASE_ACCESS);
  m.listFiles.mockResolvedValue([]);
  m.listActionItems.mockResolvedValue([]);
  m.findTranscript.mockResolvedValue(undefined);
  m.findSession.mockResolvedValue(undefined);
  m.findCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  m.findProfile.mockResolvedValue(seed.profile ?? FAT_PROFILE);
  m.findCase.mockResolvedValue(OPEN_CASE);
  m.listSiblings.mockResolvedValue([MEETING]);
  m.findArtifact.mockResolvedValue(undefined);
  m.findUser.mockResolvedValue(seed.user ?? FAT_USER);
  m.findNames.mockResolvedValue(seed.names ?? []);
  m.findAgency.mockResolvedValue(seed.agency);
  m.findLiveReview.mockResolvedValue(undefined);
  mockFetchMoneyBlock.mockResolvedValue(null);
}

describe('loadRecap', () => {
  beforeEach(() => {
    seedRecapMocks();
  });

  it('returns null for every gate denial', async () => {
    mockResolveAccess.mockResolvedValue(null);
    await expect(loadRecap(MEETING_ID, USER_ID, NOW)).resolves.toBeNull();
    expect(m.listFiles).not.toHaveBeenCalled();
  });

  it('builds the CLIENT arm with a resolve field', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens).toBe('client');
    expect(view && 'resolve' in view).toBe(true);
  });

  it('builds the EXPERT arm WITHOUT any resolve field at all', async () => {
    mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, lens: 'expert' });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens).toBe('expert');
    expect(view && 'resolve' in view).toBe(false);
  });

  it('NEVER lets a meeting row reach the view — no room name, no join URL', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('room-secret');
    expect(serialised).not.toContain('daily.co');
    expect(serialised).not.toContain('dailyRoomName');
  });

  it('NEVER lets the counterparty email or workosId reach the view', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('amara@cloudpeak.example');
    expect(serialised).not.toContain('user_secret');
    expect(serialised).not.toContain('@');
  });

  it('NEVER lets the UN-MARKED-UP expert rate or a vendor id reach the view', async () => {
    // A FAT session row is seeded on purpose: `findIdByMeetingId` projects to `{ id }`, so
    // without this the concealment assertions would run against a payload that never held a
    // margin figure to leak. A widened `.select()` upstream, or a `...session` spread here,
    // must fail LOUDLY on this test.
    m.findSession.mockResolvedValue(FAT_SESSION);
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    const serialised = JSON.stringify(view);
    // `expert_profiles.rate_cents` is the consultant's own rate BEFORE the Balo markup. The
    // client lens already carries `money.block.amountAudMinor` (the all-in charge), so a
    // payload holding both is the Balo margin, published to the client.
    expect(serialised).not.toContain('33700');
    expect(serialised).not.toContain('rateCents');
    expect(serialised).not.toContain('acct_secret_connect');
    expect(serialised).not.toContain('stripeConnectId');
    expect(serialised).not.toContain('cro_secret');
    // The SAME rule on the money row: `balo_fee_bps` IS the literal margin,
    // `expert_rate_minor_per_minute` is the un-marked-up expert rate, and the payment intent is
    // a vendor id. None of them may cross to the client lens.
    expect(serialised).not.toContain('baloFeeBps');
    expect(serialised).not.toContain('expertRateMinorPerMinute');
    expect(serialised).not.toContain('expertAccruedMinor');
    expect(serialised).not.toContain('41250');
    expect(serialised).not.toContain('123456');
    expect(serialised).not.toContain('pi_secret_intent');
    // …and the money block itself is unchanged: the id is still what the api is asked about.
    expect(mockFetchMoneyBlock).toHaveBeenCalledWith('sess-1');
  });

  it('computes the duration from the two stamps', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.header.durationMinutes).toBe(45);
  });

  it('OMITS the duration when either stamp is missing — never a bare zero', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      meeting: { ...MEETING, endedAt: null },
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.header.durationMinutes).toBeNull();
  });

  it("renders Rule M's ABSENT branch when no credit session exists", async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.money).toEqual({ kind: 'absent' });
    expect(mockFetchMoneyBlock).not.toHaveBeenCalled();
  });

  it('fetches the fee-concealed block when a session row exists', async () => {
    m.findSession.mockResolvedValue({ id: 'sess-1' });
    mockFetchMoneyBlock.mockResolvedValue({
      lens: 'client',
      state: 'pending',
      sessionId: 'sess-1',
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(mockFetchMoneyBlock).toHaveBeenCalledWith('sess-1');
    expect(view?.money).toMatchObject({ kind: 'session' });
  });

  it("degrades a money-block fetch failure to the fragment's own null fallback", async () => {
    m.findSession.mockResolvedValue({ id: 'sess-1' });
    mockFetchMoneyBlock.mockRejectedValue(new Error('api down'));
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.money).toEqual({ kind: 'session', block: null, elapsedMinutes: 45 });
  });

  it('carries NO money at all on a non-case context', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'project_kickoff', contextId: ENGAGEMENT_ID },
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.money).toBeNull();
    expect(m.findSession).not.toHaveBeenCalled();
  });

  it('renders the ordinal line only for a case', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.party.ordinalLine).toBe('1st consultation on this case');

    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'package_session', contextId: ENGAGEMENT_ID },
    });
    const other = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(other?.party.ordinalLine).toBeNull();
  });

  it('renders the CLIENT-lens party card around the EXPERT', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.party.name).toBe('Amara Okafor');
    expect(view?.party.headline).toBe('Salesforce CPQ specialist');
    expect(view?.party.bookAgainHref).toBe('/experts/amara');
  });

  it('OMITS the Book again href when the expert username is null', async () => {
    m.findProfile.mockResolvedValue({
      userId: 'u-expert',
      agencyId: null,
      type: 'freelancer',
      headline: null,
      username: null,
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.party.bookAgainHref).toBeNull();
  });

  it('renders the EXPERT-lens party card around the client COMPANY, with no CTA', async () => {
    mockResolveAccess.mockResolvedValue({ ...CASE_ACCESS, lens: 'expert' });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.party.name).toBe('Northwind Industrial');
    expect(view?.party.bookAgainHref).toBeNull();
    expect(view?.party.headline).toBeNull();
  });
});

describe('loadRecap — resolve prompt, artefacts and status', () => {
  beforeEach(() => {
    seedRecapMocks({
      profile: AGENCY_PROFILE,
      user: { firstName: 'Amara', lastName: 'Okafor', avatarUrl: null },
      names: [{ id: 'u-expert', firstName: 'Amara', lastName: 'Okafor' }],
      agency: { id: 'agency-1', name: 'CloudPeak', memberCount: 4 },
    });
  });

  it('OFFERS the resolve prompt on an open case with no pending request', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.variant).toBe('offered');
  });

  it('switches to the REQUESTED variant, attributing the person @ agency', async () => {
    m.findCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      closedAt: null,
      closeReason: null,
      resolutionRequestedAt: new Date('2026-08-01T00:00:00Z'),
      resolutionRequestedByUserId: 'u-expert',
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.variant).toBe('requested');
    expect(view?.lens === 'client' && view.resolve.requesterLabel).toBe('Amara Okafor @ CloudPeak');
  });

  it('keeps the wrap-up slot alive once the case is CLOSED, as the success state', async () => {
    m.findCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      closedAt: new Date('2026-07-30T00:00:00Z'),
      closeReason: 'resolved',
      resolutionRequestedAt: null,
      resolutionRequestedByUserId: null,
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.resolved).toEqual({ reviewLinkSent: true });
  });

  it('promises NO review email when this reviewer already rated this expert', async () => {
    m.findLiveReview.mockResolvedValue({ id: 'rev-1' });
    m.findCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      closedAt: new Date('2026-07-30T00:00:00Z'),
      closeReason: 'resolved',
      resolutionRequestedAt: null,
      resolutionRequestedByUserId: null,
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    // `resolveReviewAsk` SKIPS the token in exactly this case, so the copy must not promise one.
    expect(view?.lens === 'client' && view.resolve.resolved).toEqual({ reviewLinkSent: false });
    expect(view?.lens === 'client' && view.resolve.reviewWillBeAsked).toBe(false);
  });

  it('promises NO review email for an AUTO-INACTIVE close - no token is minted at all', async () => {
    m.findCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      closedAt: new Date('2026-07-30T00:00:00Z'),
      closeReason: 'auto_inactive',
      resolutionRequestedAt: null,
      resolutionRequestedByUserId: null,
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.resolved).toEqual({ reviewLinkSent: false });
  });

  it('carries NO resolved state while the case is still open', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.resolved).toBeNull();
  });

  it('offers NOTHING once the case is closed, and states the closed note', async () => {
    m.findCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      closedAt: new Date('2026-07-30T00:00:00Z'),
      closeReason: 'resolved',
      resolutionRequestedAt: null,
      resolutionRequestedByUserId: null,
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.variant).toBe('none');
    expect(view?.header.status.label).toBe('Resolved');
    expect(view?.header.closedNote).toContain('Everything here stays available');
  });

  it('states the auto-inactive close differently, and never as resolved', async () => {
    m.findCase.mockResolvedValue({
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      closedAt: new Date('2026-07-30T00:00:00Z'),
      closeReason: 'auto_inactive',
      resolutionRequestedAt: null,
      resolutionRequestedByUserId: null,
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.header.status.label).toBe('Closed — inactive');
    expect(view?.header.closedNote).toContain('without activity');
  });

  it('offers NOTHING on a non-case context', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'retainer_checkin', contextId: ENGAGEMENT_ID },
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.lens === 'client' && view.resolve.variant).toBe('none');
  });

  it('renders READY artefacts and a Completed chip when both artefacts have content', async () => {
    m.findTranscript.mockResolvedValue({ id: 't1', status: 'ready' });
    m.findArtifact.mockImplementation(async (_id: string, kind: string) => ({
      content: kind === 'summary' ? 'We agreed to rebuild.' : 'Amara: hello.',
    }));
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.artifacts.summary.state).toBe('ready');
    expect(view?.state).toBe('ready');
    expect(view?.header.status.label).toBe('Completed');
  });

  it('renders a Wrapping up chip while the pipeline is still processing', async () => {
    m.findTranscript.mockResolvedValue({ id: 't1', status: 'processing' });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.state).toBe('processing');
    expect(view?.header.status.label).toBe('Wrapping up');
  });

  it('renders the ABSENT branch once the pipeline grace window has passed', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.state).toBe('artifacts_absent');
    expect(view?.artifacts.collapsed).toBe(true);
  });

  it('renders PROCESSING inside the grace window right after the meeting ends', async () => {
    const justAfter = new Date(MEETING.endedAt.getTime() + 60_000);
    const view = await loadRecap(MEETING_ID, USER_ID, justAfter);
    expect(view?.state).toBe('processing');
  });

  it('renders the not-held panel and a Not held chip for a no-show', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      meeting: { ...MEETING, outcome: 'no_show_client' },
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.state).toBe('not_held');
    expect(view?.header.status.label).toBe('Not held');
    expect(view?.notHeld?.body).toBe('Amara Okafor @ CloudPeak joined and waited.');
  });

  it('renders the cancelled arm', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      meeting: { ...MEETING, status: 'cancelled', outcome: null },
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.state).toBe('cancelled');
    expect(view?.header.status.label).toBe('Cancelled');
    // A cancelled meeting DID reach a terminal state, so it renders - as the R11 not-held panel.
    expect(view?.notHeld?.reason).toBe('cancelled');
  });

  /**
   * THE READ GATE DOES NOT DISCHARGE LIFECYCLE, so a participant can open this URL before the
   * call. Without an explicit arm the page rendered a green "Completed" chip over a FUTURE
   * date, "No consultation charge for this one", "This call wasn't written up" and a resolve
   * offer for a consultation nobody has had.
   */
  it.each(['scheduled', 'waiting_for_participants', 'in_progress'] as const)(
    'returns null for a %s meeting - a recap of a call that has not happened is not a recap',
    async (status) => {
      mockResolveAccess.mockResolvedValue({
        ...CASE_ACCESS,
        meeting: {
          ...MEETING,
          status,
          outcome: null,
          startedAt: null,
          endedAt: null,
          scheduledStart: new Date('2026-09-01T04:00:00Z'),
        },
      });
      await expect(loadRecap(MEETING_ID, USER_ID, NOW)).resolves.toBeNull();
      // And it costs NOTHING: the guard sits above every read.
      expect(m.listFiles).not.toHaveBeenCalled();
      expect(m.findTranscript).not.toHaveBeenCalled();
    }
  );

  it('never renders a FUTURE date under a Completed chip', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      meeting: {
        ...MEETING,
        status: 'scheduled',
        outcome: null,
        startedAt: null,
        endedAt: null,
        scheduledStart: new Date('2026-09-01T04:00:00Z'),
      },
    });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view).toBeNull();
  });

  it('RENDERS an ended meeting - the guard is not swallowing the happy path', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view).not.toBeNull();
    expect(view?.header.status.label).toBe('Completed');
  });

  it('builds the action-items panel ONLY for engagement-grain contexts, READ-ONLY', async () => {
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    // Every action-item MUTATION gates through `projectEngagementsRepository.findWithMilestones`,
    // which filters engagement_type = 'project' - so a CASE id can never resolve and every
    // control would toast "This engagement could not be found". A read-only panel is honest.
    expect(view?.actionItems?.canWrite).toBe(false);
    expect(view?.actionItems?.engagementId).toBe(ENGAGEMENT_ID);

    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'request_interaction', contextId: 'rel-1' },
    });
    m.findRelationship.mockResolvedValue({ projectRequestId: 'req-1' });
    m.findRequest.mockResolvedValue({ title: 'Intro about CPQ' });
    const requestView = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(requestView?.actionItems).toBeNull();
    expect(requestView?.header.title).toBe('Intro about CPQ');
    expect(requestView?.header.eyebrow).toBe('Intro call');
  });

  it('titles a project_discovery from its request', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'project_discovery', contextId: 'req-1' },
    });
    m.findRequest.mockResolvedValue({ title: 'Migrate the CPQ stack' });
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.header.title).toBe('Migrate the CPQ stack');
  });

  it('falls back to a humane title when the subject read comes back empty', async () => {
    mockResolveAccess.mockResolvedValue({
      ...CASE_ACCESS,
      subject: { contextType: 'project_discovery', contextId: 'req-1' },
    });
    m.findRequest.mockResolvedValue(undefined);
    const view = await loadRecap(MEETING_ID, USER_ID, NOW);
    expect(view?.header.title).toBe('Discovery call');
  });
});
