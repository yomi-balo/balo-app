import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthorizeParticipation,
  mockDeliveringUserId,
  mockDeliveringProfileForMeeting,
  mockFindLiveGuest,
  mockOpen,
  mockClose,
  mockListOpen,
  mockMarkWaiting,
  mockMarkInProgress,
  mockCancelScheduled,
  mockTrackServer,
  mockWarn,
  mockError,
  mockFindIdByMeetingId,
  mockConnectSessionAsSystem,
} = vi.hoisted(() => ({
  mockAuthorizeParticipation: vi.fn(),
  mockDeliveringUserId: vi.fn(),
  mockDeliveringProfileForMeeting: vi.fn(),
  mockFindLiveGuest: vi.fn(),
  mockOpen: vi.fn(),
  mockClose: vi.fn(),
  mockListOpen: vi.fn(),
  mockMarkWaiting: vi.fn(),
  mockMarkInProgress: vi.fn(),
  mockCancelScheduled: vi.fn(),
  mockTrackServer: vi.fn(),
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  /** BAL-466 — the co-presence connect seam. */
  mockFindIdByMeetingId: vi.fn(),
  mockConnectSessionAsSystem: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: mockError }),
}));
vi.mock('@balo/db', () => ({
  meetingGuestsRepository: { findLiveById: mockFindLiveGuest },
  meetingPresenceRepository: { open: mockOpen, close: mockClose, listOpen: mockListOpen },
  meetingsRepository: {
    markWaitingForParticipants: mockMarkWaiting,
    markInProgress: mockMarkInProgress,
  },
  creditSessionsRepository: { findIdByMeetingId: mockFindIdByMeetingId },
}));
vi.mock('./delivering-party.js', () => ({
  deliveringExpertUserId: mockDeliveringUserId,
  deliveringExpertProfileIdForMeeting: mockDeliveringProfileForMeeting,
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  MEETING_SERVER_EVENTS: { MEETING_STARTED: 'meeting_started' },
  SESSION_SERVER_EVENTS: { SESSION_STARTED: 'session_started' },
}));
vi.mock('./authorize-meeting-participation.js', () => ({
  authorizeMeetingParticipation: mockAuthorizeParticipation,
}));
vi.mock('../../notifications/scheduling/schedule.js', () => ({
  cancelScheduledNotification: mockCancelScheduled,
}));
vi.mock('../credit-session/connect-session.js', () => ({
  connectSessionAsSystem: mockConnectSessionAsSystem,
}));
// ⚠ `@balo/shared/meetings` is NOT mocked: `parseDailyParticipantId` and
// `presencePartyForGuest` (THE MONEY RULE) are precisely what the party-derivation rows assert.

import { dailyParticipantIdFor } from '@balo/shared/meetings';
import {
  applyPresenceEffect,
  closePresenceEffectForRow,
  presenceWindowFor,
  reconcileMeetingStatus,
  resolvePresenceEffect,
} from './presence-writer.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '55555555-5555-4555-8555-555555555555';
const EXPERT_PROFILE_ID = '77777777-7777-4777-8777-777777777777';
/** The consultant the booking names — deliberately NOT {@link USER_ID}. */
const DELIVERING_USER_ID = '99999999-9999-4999-8999-999999999999';
const START = new Date('2026-08-14T10:00:00.000Z');
const END = new Date('2026-08-14T11:00:00.000Z');

const MEETING = {
  id: MEETING_ID,
  status: 'scheduled',
  scheduledStart: START,
  scheduledEnd: END,
  dailyRoomName: 'balo-22222222222242228222222222222222',
} as never;

/** A stand-in executor. The repository is mocked, so it only has to be PASSED THROUGH. */
const EXEC = {} as never;

describe('presenceWindowFor — the R10 clamp (BAL-134)', () => {
  it('lower bound is the scheduled start — early arrival earns nothing', () => {
    expect(presenceWindowFor(MEETING).notBefore).toEqual(START);
  });

  /**
   * ⚠ THE UPPER BOUND IS **GENEROUS ON PURPOSE**. It exists to stop a nonsense timestamp (a
   * `left_at` a day late), NOT to cap a long call: a legitimately over-running consultation must
   * not be truncated into an UNDER-bill, and nothing terminates on `scheduled_end`.
   */
  it('⚠ upper bound is scheduled_end + 24h — it bounds nonsense, not a long call', () => {
    expect(presenceWindowFor(MEETING).notAfter).toEqual(
      new Date(END.getTime() + 24 * 60 * 60 * 1000)
    );
  });
});

describe('resolvePresenceEffect — identity and PARTY DERIVATION (the money rule)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'client',
      expertProfileId: EXPERT_PROFILE_ID,
    });
    // By default the actor is NOT the delivering consultant.
    mockDeliveringUserId.mockResolvedValue(DELIVERING_USER_ID);
    mockDeliveringProfileForMeeting.mockResolvedValue(EXPERT_PROFILE_ID);
  });

  it('a client-side member is recorded `client`', async () => {
    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: START,
    });

    expect(effect).toMatchObject({
      userId: USER_ID,
      meetingGuestId: null,
      party: 'client',
      identityKind: 'user',
    });
    expect(mockAuthorizeParticipation).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
  });

  /**
   * ⚠⚠ S3 — `party: 'expert'` IS THE DELIVERING CONSULTANT, RESOLVED FROM
   * `engagements.expert_profile_id → expert_profiles.userId`, NOT FROM THE PARTICIPATION GATE.
   */
  it('⚠⚠ the DELIVERING expert is recorded `expert`', async () => {
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'expert',
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockDeliveringUserId.mockResolvedValue(USER_ID);

    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: START,
    });

    expect(effect).toMatchObject({ userId: USER_ID, party: 'expert' });
    expect(mockDeliveringUserId).toHaveBeenCalledWith(EXPERT_PROFILE_ID);
  });

  /**
   * ⚠⚠ S3, THE OTHER DIRECTION — AND THIS IS A DIRECT ACCEPTANCE-CRITERION LINE: "an expert-side
   * guest **or agency colleague** joining does not" start billing.
   *
   * `authorizeMeetingParticipation`'s expert arm is `MANAGE_ENGAGEMENT`, whose holder set is the
   * delivering expert PLUS their agency `owner`/`admin`. Taking its `side` verbatim wrote
   * `party: 'expert'` for an agency owner who is not the consultant — which anchors
   * `expertPresentMs`, disarms `missedCallApplies` via `expertEverPresent`, and starts
   * `billableMs` the moment any client joins, with nobody delivering. `presencePartyForGuest`
   * already maps every expert-side GUEST to `observer`; this is the authenticated path finally
   * agreeing with it.
   */
  it('⚠⚠ an agency owner/admin who is NOT the delivering expert is `observer`, never `expert`', async () => {
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'expert',
      expertProfileId: EXPERT_PROFILE_ID,
    });
    mockDeliveringUserId.mockResolvedValue(DELIVERING_USER_ID);

    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: START,
    });

    expect(effect).toMatchObject({ userId: USER_ID, party: 'observer' });
  });

  /**
   * ⚠ A DENIAL IS `observer`, NOT AN ERROR (edge case 25). A Balo staffer really can be in the
   * room — present, never billable. Refusing to record them would lose a real attendance fact;
   * recording them as a party would make them billable.
   */
  it('⚠ a user the gate DENIES is recorded as `observer`, still with their user id', async () => {
    mockAuthorizeParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    mockDeliveringUserId.mockResolvedValue(DELIVERING_USER_ID);

    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: START,
    });

    expect(effect).toMatchObject({ userId: USER_ID, party: 'observer' });
  });

  /**
   * ⚠⚠ S4 — THE MIRROR CASE, AND THE ONE THAT DELETES A ROOM MID-CALL.
   *
   * `relationshipDeniesHosting` strips BOTH engagement tokens from the delivering expert of a
   * DECLINED request-grain relationship, so the participation gate denies them. They can still
   * be physically hosting a `project_discovery` / `request_interaction` call booked BEFORE that
   * decline. Recorded `observer`, `expertEverPresent` stays false, `missedCallApplies` fires at
   * `scheduledStart + 10min`, and `tearDownRoom` deletes the Daily room while both parties are
   * talking — with nothing billable recorded either.
   *
   * The BOOKING is what says who delivers, so the booking wins, and the disagreement is logged
   * at `error` (not `warn`) because it is a contradiction, not a routine deny.
   */
  it('⚠⚠ a DENIED user whom the meeting still NAMES as its expert is `expert`, and logs at error', async () => {
    mockAuthorizeParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });
    mockDeliveringProfileForMeeting.mockResolvedValue(EXPERT_PROFILE_ID);
    mockDeliveringUserId.mockResolvedValue(USER_ID);

    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: START,
    });

    expect(effect).toMatchObject({ userId: USER_ID, party: 'expert' });
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, userId: USER_ID }),
      expect.stringContaining('DELIVERING expert')
    );
  });

  /** A meeting whose context names nobody (a `match`-routed discovery) has no delivering id. */
  it('a meeting that names no expert cannot promote anybody to `expert`', async () => {
    mockAuthorizeParticipation.mockResolvedValue({
      ok: true,
      side: 'expert',
      expertProfileId: null,
    });
    mockDeliveringUserId.mockResolvedValue(null);

    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: START,
    });

    expect(effect).toMatchObject({ party: 'observer' });
  });

  /**
   * ⚠⚠ THE MONEY RULE, END TO END. A `link`-channel guest's stored `party` is a NOT-NULL
   * PLACEHOLDER (`claimLobbyPlace` writes `'client'` because the column demands something), and
   * an expert-side guest is a COLLEAGUE rather than the delivering expert. Both are `observer`,
   * so neither can anchor the billable span. Deriving from `guest.party` directly is the
   * over-bill this table exists to prevent.
   */
  const GUEST_ROWS: ReadonlyArray<{
    party: 'client' | 'expert';
    inviteChannel: 'email' | 'link';
    expected: 'client' | 'observer';
  }> = [
    { party: 'client', inviteChannel: 'email', expected: 'client' },
    { party: 'expert', inviteChannel: 'email', expected: 'observer' },
    { party: 'client', inviteChannel: 'link', expected: 'observer' },
    { party: 'expert', inviteChannel: 'link', expected: 'observer' },
  ];

  it.each(GUEST_ROWS)(
    '⚠ a $inviteChannel-channel guest stored as $party is presence `$expected`',
    async ({ party, inviteChannel, expected }) => {
      mockFindLiveGuest.mockResolvedValue({ id: GUEST_ID, party, inviteChannel });

      const effect = await resolvePresenceEffect({
        action: 'open',
        meeting: MEETING,
        participantId: dailyParticipantIdFor('guest', GUEST_ID),
        at: START,
      });

      expect(effect).toMatchObject({
        userId: null,
        meetingGuestId: GUEST_ID,
        party: expected,
        identityKind: 'guest',
      });
    }
  );

  it('a guest row that is gone (revoked / expired) is `observer`', async () => {
    mockFindLiveGuest.mockResolvedValue(undefined);

    const effect = await resolvePresenceEffect({
      action: 'open',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('guest', GUEST_ID),
      at: START,
    });

    expect(effect).toMatchObject({ meetingGuestId: GUEST_ID, party: 'observer' });
  });

  /**
   * ⚠ `null` IS A REAL ANSWER, NOT A FAILURE (edge case 9). `parseDailyParticipantId` refuses a
   * bare uuid by design, and `meeting_presence` permits a NULL identity beside a KNOWN `party`
   * rather than forcing the writer to guess — a guess anchors a billing clock on the wrong
   * person.
   */
  it.each([
    ['a bare uuid', USER_ID],
    ['an unknown tag', `x${'a'.repeat(32)}`],
    ['uppercase hex', `u${'A'.repeat(32)}`],
    ['nothing at all', null],
  ])(
    '⚠ %s is an UNMAPPED observer with BOTH identity columns null, logged at warn',
    async (_label, participantId) => {
      const effect = await resolvePresenceEffect({
        action: 'open',
        meeting: MEETING,
        participantId,
        at: START,
      });

      expect(effect).toMatchObject({
        userId: null,
        meetingGuestId: null,
        party: 'observer',
        identityKind: 'unknown',
      });
      expect(mockWarn).toHaveBeenCalled();
    }
  );

  it('carries the R10 window on every effect', async () => {
    const effect = await resolvePresenceEffect({
      action: 'close',
      meeting: MEETING,
      participantId: dailyParticipantIdFor('user', USER_ID),
      at: END,
    });

    expect(effect.window.notBefore).toEqual(START);
    expect(effect.action).toBe('close');
  });
});

/**
 * ⚠⚠ A CLOSE MATCHES ON IDENTITY ONLY, so re-deriving `party` is work that changes no write and
 * can only introduce disagreement. The reconciler runs this per open interval, per candidate,
 * per MINUTE, over a batch of up to 200 — a full party derivation there is the participation
 * gate plus a delivery-identity read, several queries each, all discarded.
 */
describe('closePresenceEffectForRow — the reconciler close path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('⚠⚠ derives NOTHING — no gate, no delivery-identity read', () => {
    closePresenceEffectForRow(
      MEETING,
      { userId: USER_ID, meetingGuestId: null, party: 'expert' },
      END
    );

    expect(mockAuthorizeParticipation).not.toHaveBeenCalled();
    expect(mockDeliveringUserId).not.toHaveBeenCalled();
  });

  it('carries the STORED identity and party, plus the R10 window', () => {
    expect(
      closePresenceEffectForRow(
        MEETING,
        { userId: USER_ID, meetingGuestId: null, party: 'client' },
        END
      )
    ).toEqual({
      action: 'close',
      meetingId: MEETING_ID,
      userId: USER_ID,
      meetingGuestId: null,
      party: 'client',
      at: END,
      window: { notBefore: START, notAfter: new Date(END.getTime() + 24 * 60 * 60 * 1000) },
      identityKind: 'user',
    });
  });

  it.each([
    ['a guest row', null, GUEST_ID, 'guest'],
    ['an unmapped row', null, null, 'unknown'],
  ])('reports %s as identityKind `%s`', (_label, userId, meetingGuestId, kind) => {
    expect(
      closePresenceEffectForRow(MEETING, { userId, meetingGuestId, party: 'observer' }, END)
        .identityKind
    ).toBe(kind);
  });
});

describe('applyPresenceEffect', () => {
  const EFFECT = {
    action: 'open' as const,
    meetingId: MEETING_ID,
    userId: USER_ID,
    meetingGuestId: null,
    party: 'client' as const,
    at: START,
    window: { notBefore: START, notAfter: END },
    identityKind: 'user' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockResolvedValue({ id: 'row-1', joinedAt: START, leftAt: null });
    mockClose.mockResolvedValue({ id: 'row-1', joinedAt: START, leftAt: END });
  });

  it('opens on the CALLER-SUPPLIED executor, with the identity routed to one column', async () => {
    await expect(applyPresenceEffect(EXEC, EFFECT)).resolves.toBe('opened');

    expect(mockOpen).toHaveBeenCalledWith(
      {
        meetingId: MEETING_ID,
        userId: USER_ID,
        meetingGuestId: null,
        party: 'client',
        joinedAt: START,
        window: { notBefore: START, notAfter: END },
      },
      EXEC
    );
  });

  it('closes, passing the window so the upper clamp applies', async () => {
    await expect(applyPresenceEffect(EXEC, { ...EFFECT, action: 'close', at: END })).resolves.toBe(
      'closed'
    );
    expect(mockClose).toHaveBeenCalledWith(expect.objectContaining({ leftAt: END }), EXEC);
  });

  /**
   * ⚠ FIRST-CLOSE-WINS. A duplicate `participant.left` matches zero rows, and a `left` arriving
   * BEFORE its `joined` finds nothing open. Both are expected transport conditions — never
   * errors — and a later write must never extend `left_at`, which would extend a billable span.
   */
  it('⚠ a close with nothing open is `noop`, not an error', async () => {
    mockClose.mockResolvedValue(undefined);

    await expect(applyPresenceEffect(EXEC, { ...EFFECT, action: 'close' })).resolves.toBe('noop');
  });

  /**
   * ⚠⚠ AN INVALID TIMESTAMP IS ANSWERED, NOT THROWN (edge case 22). Letting it escape would roll
   * back the webhook's transaction INCLUDING THE MARKER, so Daily would retry the same
   * un-writable body forever. Answering lets the marker commit with no effect and the route ack.
   */
  it('⚠⚠ an InvalidPresenceTimestampError is caught and reported, so the marker can commit', async () => {
    const invalid = new Error('meeting_presence.joined_at must be a finite timestamp');
    invalid.name = 'InvalidPresenceTimestampError';
    mockOpen.mockRejectedValue(invalid);

    await expect(applyPresenceEffect(EXEC, EFFECT)).resolves.toBe('invalid_timestamp');
    expect(mockError).toHaveBeenCalled();
  });

  it('any OTHER error propagates — a DB outage must not be swallowed as a no-op', async () => {
    mockOpen.mockRejectedValue(new Error('connection reset'));

    await expect(applyPresenceEffect(EXEC, EFFECT)).rejects.toThrow('connection reset');
  });
});

describe('reconcileMeetingStatus — the transitions presence implies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelScheduled.mockResolvedValue(1);
    mockMarkWaiting.mockResolvedValue({ id: MEETING_ID, status: 'waiting_for_participants' });
    mockMarkInProgress.mockResolvedValue({ id: MEETING_ID, status: 'in_progress' });
    // BAL-466 — no session by default; a test that wants the connect seam opts in.
    mockFindIdByMeetingId.mockResolvedValue(undefined);
    mockConnectSessionAsSystem.mockResolvedValue({
      id: 'sess-1',
      companyId: 'company-1',
      expertProfileId: EXPERT_PROFILE_ID,
      clientRateMinorPerMinute: 450,
      status: 'active',
    });
  });

  it('the FIRST interval on a `scheduled` meeting moves it to waiting_for_participants', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }]);

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBe('waiting_for_participants');
    expect(mockMarkInProgress).not.toHaveBeenCalled();
  });

  it('expert ∧ client both present moves it to in_progress and emits `meeting_started`', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBe('in_progress');
    expect(mockMarkInProgress).toHaveBeenCalledWith(MEETING_ID, END);
    expect(mockTrackServer).toHaveBeenCalledWith('meeting_started', {
      meeting_id: MEETING_ID,
      seconds_from_scheduled_start: 3600,
      participant_count: 2,
      // ⚠ THE MEETING ID — no acting human on a system-observed transition.
      distinct_id: MEETING_ID,
    });
  });

  /**
   * ⚠ `observer` COUNTS TOWARDS NEITHER SIDE. A Balo staffer joining a room the expert is
   * already in must not start the consultation clock.
   */
  it('⚠ an `observer` beside the expert does NOT start the meeting', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'observer' }]);

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBe('waiting_for_participants');
    expect(mockMarkInProgress).not.toHaveBeenCalled();
  });

  it('a lost CAS race answers null — a normal outcome, never an error', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockMarkInProgress.mockResolvedValue(undefined);

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBeNull();
    expect(mockTrackServer).not.toHaveBeenCalled();
  });

  it('an empty room transitions nothing', async () => {
    mockListOpen.mockResolvedValue([]);

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBeNull();
    expect(mockMarkWaiting).not.toHaveBeenCalled();
    expect(mockCancelScheduled).not.toHaveBeenCalled();
  });

  it('disarms the matching absence promise for whoever is now present', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);

    await reconcileMeetingStatus(MEETING, END);

    expect(mockCancelScheduled).toHaveBeenCalledWith(`meeting_expert_absent:${MEETING_ID}`);
    expect(mockCancelScheduled).toHaveBeenCalledWith(`meeting_client_absent:${MEETING_ID}`);
  });

  /**
   * ⚠ CANCELLATION IS AN OPTIMISATION, NOT THE MECHANISM (R11). A `claimed` row is deliberately
   * uncancellable and a cancel can always be missed, so both promises carry a registered
   * fire-time recheck which is the authority. A cancel failure must NEVER fail a webhook that
   * correctly recorded presence.
   */
  it('⚠ a CANCEL FAILURE is non-fatal — the fire-time recheck is the authority', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockCancelScheduled.mockRejectedValue(new Error('redis down'));

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBe('in_progress');
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('reconcileMeetingStatus — BAL-466 (D6), the credit session connect seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelScheduled.mockResolvedValue(1);
    mockMarkWaiting.mockResolvedValue({ id: MEETING_ID, status: 'waiting_for_participants' });
    mockMarkInProgress.mockResolvedValue({ id: MEETING_ID, status: 'in_progress' });
    mockFindIdByMeetingId.mockResolvedValue(undefined);
    mockConnectSessionAsSystem.mockResolvedValue({
      id: 'sess-1',
      companyId: 'company-1',
      expertProfileId: EXPERT_PROFILE_ID,
      clientRateMinorPerMinute: 450,
      status: 'active',
    });
  });

  it('on co-presence, finds the session and connects it as system', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockFindIdByMeetingId.mockResolvedValue({ id: 'sess-1' });

    await reconcileMeetingStatus(MEETING, END);

    expect(mockFindIdByMeetingId).toHaveBeenCalledWith(MEETING_ID);
    expect(mockConnectSessionAsSystem).toHaveBeenCalledWith('sess-1', { now: END });
  });

  it('fires SESSION_SERVER_EVENTS.SESSION_STARTED with distinct_id = companyId and the CLIENT rate', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockFindIdByMeetingId.mockResolvedValue({ id: 'sess-1' });

    await reconcileMeetingStatus(MEETING, END);

    expect(mockTrackServer).toHaveBeenCalledWith('session_started', {
      session_id: 'sess-1',
      meeting_id: MEETING_ID,
      expert_profile_id: EXPERT_PROFILE_ID,
      rate_per_minute_minor: 450,
      distinct_id: 'company-1',
    });
  });

  it('no session for this meeting ⇒ neither findIdByMeetingId nor connect fires anything beyond the one indexed read', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockFindIdByMeetingId.mockResolvedValue(undefined);

    await reconcileMeetingStatus(MEETING, END);

    expect(mockFindIdByMeetingId).toHaveBeenCalledWith(MEETING_ID);
    expect(mockConnectSessionAsSystem).not.toHaveBeenCalled();
    expect(mockTrackServer).not.toHaveBeenCalledWith('session_started', expect.anything());
  });

  it('a throw from connect is caught, logged at error, and reconcileMeetingStatus still returns in_progress', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }, { party: 'client' }]);
    mockFindIdByMeetingId.mockResolvedValue({ id: 'sess-1' });
    mockConnectSessionAsSystem.mockRejectedValue(new Error('invalid transition'));

    await expect(reconcileMeetingStatus(MEETING, END)).resolves.toBe('in_progress');
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: MEETING_ID, error: 'invalid transition' }),
      'Credit session could not be connected at co-presence — the call is not metering'
    );
  });

  it('the waiting_for_participants arm never connects', async () => {
    mockListOpen.mockResolvedValue([{ party: 'expert' }]);

    await reconcileMeetingStatus(MEETING, END);

    expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
    expect(mockConnectSessionAsSystem).not.toHaveBeenCalled();
  });
});
