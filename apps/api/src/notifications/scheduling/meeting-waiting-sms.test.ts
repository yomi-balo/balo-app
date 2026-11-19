import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  meetingFindById: vi.fn(),
  listPresence: vi.fn(),
  findRinging: vi.fn(),
  findBooker: vi.fn(),
  bookerParticipates: vi.fn(),
  findNames: vi.fn(),
  findTimezoneContext: vi.fn(),
  findConsent: vi.fn(),
  findCompanyName: vi.fn(),
  findByDedupeKey: vi.fn(),
  scheduleNotification: vi.fn(),
  resolveSubject: vi.fn(),
  deliveringExpertUserId: vi.fn(),
  deliveringOwner: vi.fn(),
  meetingOrigin: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: mocks.meetingFindById },
  meetingPresenceRepository: { listByMeeting: mocks.listPresence },
  meetingRingsRepository: { findRingingForMeeting: mocks.findRinging },
  clientPartyRecipientsRepository: {
    findMeetingBookerUserId: mocks.findBooker,
    bookerStillParticipatesInCompany: mocks.bookerParticipates,
  },
  usersRepository: {
    findNamesByIds: mocks.findNames,
    findTimezoneContext: mocks.findTimezoneContext,
    findClientSmsConsent: mocks.findConsent,
  },
  companiesRepository: { findNameById: mocks.findCompanyName },
  scheduledNotificationsRepository: { findByDedupeKey: mocks.findByDedupeKey },
}));
vi.mock('@balo/analytics/server', () => ({
  CALL_NOW_SERVER_EVENTS: {},
  MEETING_SERVER_EVENTS: {},
  trackServer: vi.fn(),
}));
vi.mock('../../lib/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../lib/rate-limiter.js', () => ({
  RATE_LIMIT_DEADLINE_MS: 2000,
  checkRateLimit: vi.fn(),
  releaseRateLimitSlot: vi.fn(),
}));
vi.mock('./schedule.js', () => ({ scheduleNotification: mocks.scheduleNotification }));
vi.mock('../../services/credit-session/case-billing-subject.js', () => ({
  resolveCaseBillingSubject: mocks.resolveSubject,
}));
vi.mock('../../services/meetings/delivering-party.js', () => ({
  deliveringExpertUserId: mocks.deliveringExpertUserId,
  deliveringContextOwnerForMeeting: mocks.deliveringOwner,
}));
vi.mock('../../services/call-now/meeting-origin.js', () => ({
  meetingOrigin: mocks.meetingOrigin,
}));

import type { ScheduledNotification } from '@balo/db';
import { WAITING_PARTY_SMS_DELAY_MS } from '../../config/meeting-timers.js';
import {
  MEETING_WAITING_SMS_RECHECK,
  meetingWaitingSmsKey,
  meetingWaitingSmsRecheck,
  scheduleWaitingPartySms,
  waitingSmsDirection,
  type WaitingSmsDirection,
} from './meeting-waiting-sms.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const BOOKER_ID = '55555555-5555-4555-8555-555555555555';
const EXPERT_USER_ID = '66666666-6666-4666-8666-666666666666';
const CORRELATION_ID = 'c0000000-0000-4000-8000-000000000000';
/** 23:00 UTC is 10:00 in Sydney. */
const START = new Date('2026-11-18T23:00:00.000Z');
/** A minute past the start: 10:01 in Sydney, inside call hours there. */
const NOW = new Date('2026-11-18T23:01:05.000Z');
const VERIFIED = new Date('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000;

function at(minutes: number): Date {
  return new Date(START.getTime() + minutes * MINUTE);
}

const EVENT_BY_DIRECTION: Record<WaitingSmsDirection, string> = {
  to_client: 'meeting.waiting_for_client',
  to_expert: 'meeting.waiting_for_expert',
};

function row(
  direction: WaitingSmsDirection,
  overrides: Record<string, unknown> = {}
): ScheduledNotification {
  return {
    id: 'row-1',
    event: EVENT_BY_DIRECTION[direction],
    attempts: 1,
    payload: {
      correlationId: CORRELATION_ID,
      meetingId: MEETING_ID,
      scheduledStartIso: START.toISOString(),
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      recipientUserId: null,
      recipientTimeZone: null,
      waitingPartyName: null,
      ...overrides,
    },
  } as unknown as ScheduledNotification;
}

const EXPERT_ALONE = [{ party: 'expert', joinedAt: START, leftAt: null }];
const CLIENT_ALONE = [{ party: 'client', joinedAt: START, leftAt: null }];
const CLIENT_CONSENT = {
  phone: '+61400000000',
  phoneVerifiedAt: VERIFIED,
  clientSmsOptedInAt: VERIFIED,
};
const EXPERT_CONSENT = {
  phone: '+61400000001',
  phoneVerifiedAt: VERIFIED,
  clientSmsOptedInAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.meetingFindById.mockResolvedValue({ id: MEETING_ID, status: 'waiting_for_participants' });
  mocks.listPresence.mockResolvedValue(EXPERT_ALONE);
  mocks.meetingOrigin.mockResolvedValue('booked');
  mocks.findRinging.mockResolvedValue(undefined);
  mocks.findByDedupeKey.mockResolvedValue([]);
  mocks.resolveSubject.mockResolvedValue({ isActive: true, closedAt: null });
  mocks.findBooker.mockResolvedValue(BOOKER_ID);
  mocks.bookerParticipates.mockResolvedValue(true);
  mocks.deliveringExpertUserId.mockResolvedValue(EXPERT_USER_ID);
  mocks.deliveringOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: PROFILE_ID });
  mocks.findNames.mockResolvedValue([{ id: EXPERT_USER_ID, firstName: 'Sandy', lastName: 'Lee' }]);
  mocks.findTimezoneContext.mockResolvedValue({
    savedTimezone: 'Australia/Sydney',
    expert: { timezone: 'Australia/Sydney' },
  });
  mocks.findCompanyName.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mocks.findConsent.mockResolvedValue(CLIENT_CONSENT);
  mocks.scheduleNotification.mockResolvedValue({ outcome: 'scheduled' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the key and the registry name', () => {
  it('is one promise per meeting, shared by both directions', () => {
    expect(meetingWaitingSmsKey(MEETING_ID)).toBe(`meeting_waiting_sms:${MEETING_ID}`);
    expect(MEETING_WAITING_SMS_RECHECK).toBe('meeting_waiting_sms');
  });
});

describe('waitingSmsDirection — the one trigger definition', () => {
  const facts = (overrides: Partial<Parameters<typeof waitingSmsDirection>[0]> = {}) => ({
    expertOpen: false,
    expertEverPresent: false,
    clientSideOpen: false,
    clientSideEverPresent: false,
    ...overrides,
  });

  it('is to_client when the expert is alone', () => {
    expect(waitingSmsDirection(facts({ expertOpen: true, expertEverPresent: true }))).toBe(
      'to_client'
    );
  });

  it('is to_expert when a client-side occupant is alone', () => {
    expect(waitingSmsDirection(facts({ clientSideOpen: true, clientSideEverPresent: true }))).toBe(
      'to_expert'
    );
  });

  it.each([
    ['an empty room', facts()],
    [
      'both sides in',
      facts({
        expertOpen: true,
        expertEverPresent: true,
        clientSideOpen: true,
        clientSideEverPresent: true,
      }),
    ],
    [
      'the expert alone after a client came and went',
      facts({ expertOpen: true, expertEverPresent: true, clientSideEverPresent: true }),
    ],
    [
      'a client alone after the expert came and went',
      facts({ clientSideOpen: true, clientSideEverPresent: true, expertEverPresent: true }),
    ],
  ])('is null for %s', (_label, input) => {
    expect(waitingSmsDirection(input)).toBeNull();
  });
});

describe('scheduleWaitingPartySms', () => {
  const input = {
    meetingId: MEETING_ID,
    scheduledStart: START,
    direction: 'to_client' as const,
    waiterFirstJoinedAt: at(5),
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
  };

  it('arms first_wins at max(start, join) + 60s with the recheck, and a seeded payload', async () => {
    await scheduleWaitingPartySms(input);

    const [event, payload, options] = mocks.scheduleNotification.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event).toBe('meeting.waiting_for_client');
    expect(options).toEqual({
      key: meetingWaitingSmsKey(MEETING_ID),
      at: new Date(at(5).getTime() + WAITING_PARTY_SMS_DELAY_MS),
      mode: 'first_wins',
      recheck: MEETING_WAITING_SMS_RECHECK,
    });
    expect(payload).toMatchObject({
      meetingId: MEETING_ID,
      scheduledStartIso: START.toISOString(),
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      recipientUserId: null,
      recipientTimeZone: null,
      waitingPartyName: null,
    });
    expect(payload.correlationId).not.toBe(MEETING_ID);
    expect(typeof payload.correlationId).toBe('string');
  });

  it('anchors on the scheduled start when the waiter joined early', async () => {
    await scheduleWaitingPartySms({ ...input, waiterFirstJoinedAt: at(-3) });

    const [, , options] = mocks.scheduleNotification.mock.calls[0] as [
      string,
      unknown,
      { at: Date },
    ];
    expect(options.at).toEqual(new Date(START.getTime() + WAITING_PARTY_SMS_DELAY_MS));
  });

  it('uses the expert event for the expert direction', async () => {
    await scheduleWaitingPartySms({ ...input, direction: 'to_expert' });

    expect(mocks.scheduleNotification.mock.calls[0]?.[0]).toBe('meeting.waiting_for_expert');
  });

  it('mints a fresh correlationId per promise', async () => {
    await scheduleWaitingPartySms(input);
    await scheduleWaitingPartySms(input);

    const ids = mocks.scheduleNotification.mock.calls.map(
      (call) => (call[1] as { correlationId: string }).correlationId
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('arms nothing without a waiter join to anchor on', async () => {
    await scheduleWaitingPartySms({ ...input, waiterFirstJoinedAt: null });

    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it.each(['published', 'claimed', 'failed'])(
    '⚠ ONCE — arms nothing once a %s row exists for the key',
    async (status) => {
      mocks.findByDedupeKey.mockResolvedValue([{ id: 'old', status, skipReason: null }]);

      await scheduleWaitingPartySms(input);

      expect(mocks.findByDedupeKey).toHaveBeenCalledWith(meetingWaitingSmsKey(MEETING_ID));
      expect(mocks.scheduleNotification).not.toHaveBeenCalled();
    }
  );

  it('arms nothing after a FINAL skip, and re-arms after waiter_left', async () => {
    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'old', status: 'skipped', skipReason: 'no_number' },
    ]);
    await scheduleWaitingPartySms(input);
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();

    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'old', status: 'skipped', skipReason: 'waiter_left' },
    ]);
    await scheduleWaitingPartySms(input);
    expect(mocks.scheduleNotification).toHaveBeenCalledOnce();
  });
});

describe('meetingWaitingSmsRecheck — publishing', () => {
  it('to_client: publishes to the booker with the expert first name and the booker zone', async () => {
    const result = await meetingWaitingSmsRecheck(row('to_client'));

    expect(result).toEqual({
      publish: true,
      payload: expect.objectContaining({
        correlationId: CORRELATION_ID,
        recipientUserId: BOOKER_ID,
        recipientTimeZone: 'Australia/Sydney',
        waitingPartyName: 'Sandy',
        companyId: COMPANY_ID,
      }),
    });
    expect(mocks.findTimezoneContext).toHaveBeenCalledWith(BOOKER_ID, undefined);
    expect(mocks.info).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, event: 'meeting.waiting_for_client' },
      'Waiting-party SMS publishing'
    );
  });

  it('to_expert: publishes to the delivering expert user with the client company name', async () => {
    mocks.listPresence.mockResolvedValue(CLIENT_ALONE);
    mocks.findConsent.mockResolvedValue(EXPERT_CONSENT);

    const result = await meetingWaitingSmsRecheck(row('to_expert'));

    expect(result).toEqual({
      publish: true,
      payload: expect.objectContaining({
        recipientUserId: EXPERT_USER_ID,
        recipientTimeZone: 'Australia/Sydney',
        waitingPartyName: 'Northwind Industrial',
      }),
    });
    expect(mocks.findBooker).not.toHaveBeenCalled();
  });

  it('to_expert needs no client opt-in, and a guest-only client side still triggers', async () => {
    mocks.listPresence.mockResolvedValue(CLIENT_ALONE);
    mocks.findConsent.mockResolvedValue({ ...EXPERT_CONSENT, clientSmsOptedInAt: null });

    const result = await meetingWaitingSmsRecheck(row('to_expert'));

    expect(result.publish).toBe(true);
  });

  it('prefers the expert profile zone, then the saved zone, then UTC', async () => {
    mocks.listPresence.mockResolvedValue(CLIENT_ALONE);
    mocks.findConsent.mockResolvedValue(EXPERT_CONSENT);
    mocks.findTimezoneContext.mockResolvedValue({
      savedTimezone: 'Australia/Perth',
      expert: { timezone: 'Australia/Sydney' },
    });
    const withProfile = await meetingWaitingSmsRecheck(row('to_expert'));
    mocks.findTimezoneContext.mockResolvedValue({
      savedTimezone: 'Australia/Sydney',
      expert: null,
    });
    const savedOnly = await meetingWaitingSmsRecheck(row('to_expert'));

    expect(withProfile.publish && withProfile.payload.recipientTimeZone).toBe('Australia/Sydney');
    expect(savedOnly.publish && savedOnly.payload.recipientTimeZone).toBe('Australia/Sydney');
    expect(mocks.findTimezoneContext).toHaveBeenCalledWith(EXPERT_USER_ID, PROFILE_ID);
  });

  it('⚠ publishes EXACTLY the payload keys — a stray userId on the row never reaches the dispatcher', async () => {
    const result = await meetingWaitingSmsRecheck(
      row('to_client', { userId: 'attacker-user', extra: 'x' })
    );

    expect(result).toEqual({
      publish: true,
      payload: {
        correlationId: CORRELATION_ID,
        meetingId: MEETING_ID,
        scheduledStartIso: START.toISOString(),
        companyId: COMPANY_ID,
        expertProfileId: PROFILE_ID,
        recipientUserId: BOOKER_ID,
        recipientTimeZone: 'Australia/Sydney',
        waitingPartyName: 'Sandy',
      },
    });
    expect(result.publish && 'userId' in result.payload).toBe(false);
  });

  it('degrades a missing name to null so the template falls back', async () => {
    mocks.findNames.mockResolvedValue([{ id: EXPERT_USER_ID, firstName: '  ', lastName: null }]);

    const result = await meetingWaitingSmsRecheck(row('to_client'));

    expect(result.publish && result.payload.waitingPartyName).toBeNull();
  });
});

describe('meetingWaitingSmsRecheck — skips', () => {
  async function reasonFor(direction: WaitingSmsDirection = 'to_client'): Promise<string> {
    const result = await meetingWaitingSmsRecheck(row(direction));
    expect(result.publish).toBe(false);
    return result.publish ? '' : result.reason;
  }

  it.each([
    ['no meeting id', { meetingId: undefined }],
    ['a blank company', { companyId: '' }],
    ['a missing company', { companyId: undefined }],
    ['no correlation id', { correlationId: undefined }],
    ['no scheduled start', { scheduledStartIso: undefined }],
  ])('skips malformed_payload for %s', async (_label, overrides) => {
    const result = await meetingWaitingSmsRecheck(row('to_client', overrides));

    expect(result).toEqual({ publish: false, reason: 'malformed_payload' });
  });

  it('skips malformed_payload for an event that is not one of the two', async () => {
    const stray = { ...row('to_client'), event: 'meeting.client_absent' } as ScheduledNotification;

    expect(await meetingWaitingSmsRecheck(stray)).toEqual({
      publish: false,
      reason: 'malformed_payload',
    });
  });

  it('skips meeting_missing', async () => {
    mocks.meetingFindById.mockResolvedValue(undefined);
    expect(await reasonFor()).toBe('meeting_missing');
  });

  it.each(['ended', 'cancelled'])('skips meeting_terminal for a %s meeting', async (status) => {
    mocks.meetingFindById.mockResolvedValue({ id: MEETING_ID, status });
    expect(await reasonFor()).toBe('meeting_terminal');
  });

  it('skips call_now for a Call now meeting, before any recipient read', async () => {
    mocks.meetingOrigin.mockResolvedValue('call_now');

    expect(await reasonFor()).toBe('call_now');
    expect(mocks.findBooker).not.toHaveBeenCalled();
  });

  it('skips call_ringing while a ring is live — the ring has its own SMS', async () => {
    mocks.findRinging.mockResolvedValue({ id: 'ring-1' });
    expect(await reasonFor()).toBe('call_ringing');
  });

  it('⚠ ONCE — skips already_decided when a sibling published, ignoring its own claimed row', async () => {
    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'row-1', status: 'claimed', skipReason: null },
      { id: 'old', status: 'published', skipReason: null },
    ]);
    expect(await reasonFor()).toBe('already_decided');
  });

  it('publishes when the only history is its own claim', async () => {
    mocks.findByDedupeKey.mockResolvedValue([{ id: 'row-1', status: 'claimed', skipReason: null }]);

    expect((await meetingWaitingSmsRecheck(row('to_client'))).publish).toBe(true);
  });

  it('re-arms after call_ringing, and not after a final skip', async () => {
    const input = {
      meetingId: MEETING_ID,
      scheduledStart: START,
      direction: 'to_client' as const,
      waiterFirstJoinedAt: at(1),
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
    };
    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'old', status: 'skipped', skipReason: 'call_ringing' },
    ]);
    await scheduleWaitingPartySms(input);
    expect(mocks.scheduleNotification).toHaveBeenCalledOnce();

    mocks.scheduleNotification.mockClear();
    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'old', status: 'skipped', skipReason: 'outside_hours' },
    ]);
    await scheduleWaitingPartySms(input);
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  describe('owner re-resolution (F1)', () => {
    it('skips owner_mismatch when the payload company is not the meeting owner — nothing substituted', async () => {
      mocks.deliveringOwner.mockResolvedValue({
        companyId: 'other-company',
        expertProfileId: PROFILE_ID,
      });

      expect(await reasonFor()).toBe('owner_mismatch');
      expect(mocks.findBooker).not.toHaveBeenCalled();
    });

    it('skips owner_mismatch when the payload expert profile is not the meeting expert', async () => {
      mocks.deliveringOwner.mockResolvedValue({
        companyId: COMPANY_ID,
        expertProfileId: 'other-profile',
      });

      expect(await reasonFor()).toBe('owner_mismatch');
    });

    it('skips owner_unresolved when the meeting has no resolvable owner', async () => {
      mocks.deliveringOwner.mockResolvedValue(null);

      expect(await reasonFor()).toBe('owner_unresolved');
      expect(mocks.findBooker).not.toHaveBeenCalled();
    });

    it('reads the owner through the meeting id, not the payload', async () => {
      await meetingWaitingSmsRecheck(row('to_client'));

      expect(mocks.deliveringOwner).toHaveBeenCalledWith(MEETING_ID);
    });
  });

  it('skips waiter_left when the waiter has gone and the absent party never came', async () => {
    mocks.listPresence.mockResolvedValue([{ party: 'expert', joinedAt: START, leftAt: at(0.5) }]);
    expect(await reasonFor('to_client')).toBe('waiter_left');

    mocks.listPresence.mockResolvedValue([{ party: 'client', joinedAt: START, leftAt: at(0.5) }]);
    expect(await reasonFor('to_expert')).toBe('waiter_left');
  });

  it('skips absent_party_joined once the absent party has ever been present', async () => {
    mocks.listPresence.mockResolvedValue([
      { party: 'expert', joinedAt: START, leftAt: null },
      { party: 'client', joinedAt: at(0.5), leftAt: at(0.8) },
    ]);
    expect(await reasonFor('to_client')).toBe('absent_party_joined');

    mocks.listPresence.mockResolvedValue([
      { party: 'client', joinedAt: START, leftAt: null },
      { party: 'expert', joinedAt: at(0.5), leftAt: at(0.8) },
    ]);
    expect(await reasonFor('to_expert')).toBe('absent_party_joined');
  });

  it('an observer alone is not a waiter', async () => {
    mocks.listPresence.mockResolvedValue([{ party: 'observer', joinedAt: START, leftAt: null }]);
    expect(await reasonFor('to_client')).toBe('waiter_left');
  });

  it('skips case_closed', async () => {
    mocks.resolveSubject.mockResolvedValue({ isActive: false, closedAt: at(-60) });
    expect(await reasonFor()).toBe('case_closed');
  });

  describe('recipients (decision 4)', () => {
    it('skips no_booker when the meeting has no booker', async () => {
      mocks.findBooker.mockResolvedValue(null);
      expect(await reasonFor()).toBe('no_booker');
      expect(mocks.bookerParticipates).not.toHaveBeenCalled();
    });

    it('skips no_booker when the booker no longer holds participate — never falls back to an admin', async () => {
      mocks.bookerParticipates.mockResolvedValue(false);
      expect(await reasonFor()).toBe('no_booker');
      expect(mocks.bookerParticipates).toHaveBeenCalledWith(COMPANY_ID, BOOKER_ID);
    });

    it('skips no_expert when the meeting names no delivering expert', async () => {
      mocks.listPresence.mockResolvedValue(CLIENT_ALONE);
      mocks.deliveringExpertUserId.mockResolvedValue(null);
      expect(await reasonFor('to_expert')).toBe('no_expert');
    });

    it('reads the delivering expert for a null profile id', async () => {
      mocks.listPresence.mockResolvedValue(CLIENT_ALONE);
      mocks.deliveringExpertUserId.mockResolvedValue(null);
      mocks.deliveringOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: null });

      const result = await meetingWaitingSmsRecheck(row('to_expert', { expertProfileId: null }));

      expect(mocks.deliveringExpertUserId).toHaveBeenCalledWith(null);
      expect(result).toEqual({ publish: false, reason: 'no_expert' });
    });
  });

  describe('eligibility (decision 1) — the ring SMS gates, without the daily cap', () => {
    it('skips no_number without a verified number', async () => {
      mocks.findConsent.mockResolvedValue({ ...CLIENT_CONSENT, phoneVerifiedAt: null });
      expect(await reasonFor()).toBe('no_number');
    });

    it('skips no_number when there is no consent row at all', async () => {
      mocks.findConsent.mockResolvedValue(undefined);
      expect(await reasonFor()).toBe('no_number');
    });

    it('skips not_opted_in for a client who has not opted in', async () => {
      mocks.findConsent.mockResolvedValue({ ...CLIENT_CONSENT, clientSmsOptedInAt: null });
      expect(await reasonFor()).toBe('not_opted_in');
    });

    it('skips outside_hours for a client whose zone is unknown (UTC)', async () => {
      mocks.findTimezoneContext.mockResolvedValue({ savedTimezone: null, expert: null });
      expect(await reasonFor()).toBe('outside_hours');
    });

    it('skips outside_hours for an expert at 03:00 local', async () => {
      mocks.listPresence.mockResolvedValue(CLIENT_ALONE);
      mocks.findConsent.mockResolvedValue(EXPERT_CONSENT);
      mocks.findTimezoneContext.mockResolvedValue({
        savedTimezone: 'America/New_York',
        expert: { timezone: 'Europe/London' },
      });
      vi.setSystemTime(new Date('2026-11-19T03:00:00.000Z'));

      expect(await reasonFor('to_expert')).toBe('outside_hours');
    });

    it('logs every skip with its reason and never the phone or the name', async () => {
      mocks.findConsent.mockResolvedValue({ ...CLIENT_CONSENT, clientSmsOptedInAt: null });

      await meetingWaitingSmsRecheck(row('to_client'));

      expect(mocks.info).toHaveBeenCalledWith(
        { meetingId: MEETING_ID, event: 'meeting.waiting_for_client', reason: 'not_opted_in' },
        'Waiting-party SMS skipped'
      );
    });
  });

  it('lets a repository failure propagate so the claim TTL retries it', async () => {
    mocks.findBooker.mockRejectedValue(new Error('db down'));

    await expect(meetingWaitingSmsRecheck(row('to_client'))).rejects.toThrow('db down');
  });
});
