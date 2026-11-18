import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findResolverSettings: vi.fn(),
  findRingingForEngagement: vi.fn(),
  findByCompanyId: vi.fn(),
  hasActiveSessionForWallet: vi.fn(),
  hasLiveSessionlessCaseMeeting: vi.fn(),
  listMeetingsForContext: vi.fn(),
  findTimezoneContext: vi.fn(),
  isUserInLiveMeeting: vi.fn(),
  hasRingingOnOtherCompanyCase: vi.fn(),
  hasDeclinedSince: vi.fn(),
  resolveCallee: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  expertsRepository: { findResolverSettings: mocks.findResolverSettings },
  meetingRingsRepository: {
    findRingingForEngagement: mocks.findRingingForEngagement,
    hasRingingOnOtherCompanyCase: mocks.hasRingingOnOtherCompanyCase,
    hasDeclinedSince: mocks.hasDeclinedSince,
  },
  creditWalletsRepository: { findByCompanyId: mocks.findByCompanyId },
  creditSessionsRepository: { hasActiveSessionForWallet: mocks.hasActiveSessionForWallet },
  meetingsRepository: { hasLiveSessionlessCaseMeeting: mocks.hasLiveSessionlessCaseMeeting },
  meetingContextsRepository: { listMeetingsForContext: mocks.listMeetingsForContext },
  usersRepository: { findTimezoneContext: mocks.findTimezoneContext },
  meetingPresenceRepository: { isUserInLiveMeeting: mocks.isUserInLiveMeeting },
}));
vi.mock('./resolve-callee.js', () => ({ resolveCallee: mocks.resolveCallee }));

import type { CaseEngagementRow } from '@balo/db';
import type { CalleePresence } from './callee-presence.js';
import { loadCallNowGates } from './call-now-gates.js';

const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const EXPERT_USER = '22222222-2222-4222-8222-222222222222';
const BOOKER = '55555555-5555-4555-8555-555555555555';
const WALLET_ID = '77777777-7777-4777-8777-777777777777';

/** Wednesday 2026-11-18, 10:00 in Sydney (UTC+11) is 23:00 UTC the day before. */
const NOW_IN_HOURS = new Date('2026-11-17T23:00:00.000Z');
const NOW_AFTER_HOURS = new Date('2026-11-18T10:30:00.000Z');

const OPEN_CASE = {
  id: ENGAGEMENT_ID,
  companyId: COMPANY_ID,
  expertProfileId: EXPERT_PROFILE_ID,
  status: 'active',
  closedAt: null,
} as unknown as CaseEngagementRow;

function base(overrides: Partial<Parameters<typeof loadCallNowGates>[0]> = {}) {
  return {
    caseRow: OPEN_CASE,
    side: 'client' as const,
    userId: CLIENT,
    mayRing: true,
    now: NOW_IN_HOURS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findResolverSettings.mockResolvedValue({
    userId: EXPERT_USER,
    timezone: 'Australia/Sydney',
    availableForWork: true,
  });
  mocks.findRingingForEngagement.mockResolvedValue(undefined);
  mocks.findByCompanyId.mockResolvedValue({ id: WALLET_ID });
  mocks.hasActiveSessionForWallet.mockResolvedValue(false);
  mocks.hasLiveSessionlessCaseMeeting.mockResolvedValue(false);
  mocks.listMeetingsForContext.mockResolvedValue([]);
  mocks.findTimezoneContext.mockResolvedValue({ savedTimezone: 'Australia/Sydney', expert: null });
  mocks.isUserInLiveMeeting.mockResolvedValue(false);
  mocks.hasRingingOnOtherCompanyCase.mockResolvedValue(false);
  mocks.hasDeclinedSince.mockResolvedValue(false);
  mocks.resolveCallee.mockResolvedValue({
    ok: true,
    userId: EXPERT_USER,
    timeZone: 'Australia/Sydney',
  });
});

describe('loadCallNowGates — each fact feeds the shared predicate', () => {
  it('offers the call when every gate is clear, in hours', async () => {
    const gates = await loadCallNowGates(base());

    expect(gates.availability).toEqual({ canCallNow: true });
    expect(gates.callee).toEqual({ userId: EXPERT_USER, timeZone: 'Australia/Sydney' });
    expect(gates.expertProfileId).toBe(EXPERT_PROFILE_ID);
    expect(gates.companyId).toBe(COMPANY_ID);
    expect(gates.calleeOnline).toBe(false);
  });

  it('returns the presence read the SMS decision reuses', async () => {
    const online: CalleePresence = { isOnline: vi.fn().mockResolvedValue(true) };

    const gates = await loadCallNowGates(base({ presence: online }));

    expect(gates.calleeOnline).toBe(true);
  });

  it('calleeOnline is false, and presence unread, when no callee resolves', async () => {
    mocks.resolveCallee.mockResolvedValue({ ok: false, reason: 'self' });
    const online: CalleePresence = { isOnline: vi.fn().mockResolvedValue(true) };

    const gates = await loadCallNowGates(base({ presence: online }));

    expect(gates.calleeOnline).toBe(false);
    expect(online.isOnline).not.toHaveBeenCalled();
  });

  it('caseOpen ← closedAt', async () => {
    const closed = {
      ...OPEN_CASE,
      closedAt: new Date('2026-11-01'),
    } as unknown as CaseEngagementRow;
    const gates = await loadCallNowGates(base({ caseRow: closed }));
    expect(gates.availability).toMatchObject({ canCallNow: false, refusal: 'case_closed' });
  });

  it('caseOpen ← engagement status', async () => {
    const ended = { ...OPEN_CASE, status: 'completed' } as unknown as CaseEngagementRow;
    const gates = await loadCallNowGates(base({ caseRow: ended }));
    expect(gates.availability).toMatchObject({ refusal: 'case_closed' });
  });

  it('expertAvailableForWork ← findResolverSettings: paused refuses a client caller', async () => {
    mocks.findResolverSettings.mockResolvedValue({
      userId: EXPERT_USER,
      timezone: 'Australia/Sydney',
      availableForWork: false,
    });
    expect((await loadCallNowGates(base())).availability).toMatchObject({
      refusal: 'expert_paused',
      reason: null,
    });
  });

  it('a paused expert may still ring the client (the gate is client-callers-only)', async () => {
    mocks.findResolverSettings.mockResolvedValue({
      userId: EXPERT_USER,
      timezone: 'Australia/Sydney',
      availableForWork: false,
    });
    mocks.resolveCallee.mockResolvedValue({ ok: true, userId: BOOKER, timeZone: 'UTC' });

    const gates = await loadCallNowGates(base({ side: 'expert', userId: EXPERT_USER }));

    expect(gates.availability).toEqual({ canCallNow: true });
  });

  it('calleeResolved ← resolveCallee (a departed booker hides the action)', async () => {
    mocks.resolveCallee.mockResolvedValue({ ok: false, reason: 'departed' });

    const gates = await loadCallNowGates(base({ side: 'expert', userId: EXPERT_USER }));

    expect(gates.callee).toBeNull();
    expect(gates.availability).toMatchObject({ refusal: 'callee_unavailable', reason: null });
    expect(mocks.isUserInLiveMeeting).not.toHaveBeenCalled();
  });

  it('missing expert settings: no callee, nothing resolved', async () => {
    mocks.findResolverSettings.mockResolvedValue(null);

    const gates = await loadCallNowGates(base());

    expect(gates.callee).toBeNull();
    expect(mocks.resolveCallee).not.toHaveBeenCalled();
    expect(gates.availability).toMatchObject({ canCallNow: false });
  });

  it('calleeInLiveMeeting ← isUserInLiveMeeting(callee)', async () => {
    mocks.isUserInLiveMeeting.mockResolvedValue(true);

    const gates = await loadCallNowGates(base());

    expect(mocks.isUserInLiveMeeting).toHaveBeenCalledWith(EXPERT_USER, NOW_IN_HOURS);
    expect(gates.availability).toMatchObject({ refusal: 'callee_busy', reason: 'busy' });
  });

  it('ringLiveOnCase ← a ringing ring that has not expired', async () => {
    mocks.findRingingForEngagement.mockResolvedValue({
      status: 'ringing',
      placement: 'new_meeting',
      createdAt: new Date(NOW_IN_HOURS.getTime() - 10_000),
      expiresAt: new Date(NOW_IN_HOURS.getTime() + 30_000),
      endedAt: null,
    });
    expect((await loadCallNowGates(base())).availability).toMatchObject({
      refusal: 'ring_in_progress',
    });
  });

  it('an expired `ringing` row is NOT live (the start path ends it)', async () => {
    mocks.findRingingForEngagement.mockResolvedValue({
      status: 'ringing',
      placement: 'new_meeting',
      createdAt: new Date(NOW_IN_HOURS.getTime() - 60_000),
      expiresAt: new Date(NOW_IN_HOURS.getTime() - 15_000),
      endedAt: null,
    });
    expect((await loadCallNowGates(base())).availability).toEqual({ canCallNow: true });
  });

  it('companyHasOtherLiveSession ← the wallet’s active session', async () => {
    mocks.hasActiveSessionForWallet.mockResolvedValue(true);

    const gates = await loadCallNowGates(base());

    expect(mocks.hasActiveSessionForWallet).toHaveBeenCalledWith(WALLET_ID);
    expect(gates.availability).toMatchObject({ refusal: 'company_in_call' });
  });

  it('companyHasOtherLiveSession ← a live sessionless case meeting', async () => {
    mocks.hasLiveSessionlessCaseMeeting.mockResolvedValue(true);

    const gates = await loadCallNowGates(base());

    expect(mocks.hasLiveSessionlessCaseMeeting).toHaveBeenCalledWith({ companyId: COMPANY_ID });
    expect(gates.availability).toMatchObject({ refusal: 'company_in_call' });
  });

  it('⚠ companyHasOtherLiveSession ← a ring ringing on ANOTHER case of the company', async () => {
    mocks.hasRingingOnOtherCompanyCase.mockResolvedValue(true);

    const gates = await loadCallNowGates(base());

    expect(mocks.hasRingingOnOtherCompanyCase).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      excludeEngagementId: ENGAGEMENT_ID,
    });
    expect(gates.availability).toMatchObject({ refusal: 'company_in_call', reason: null });
  });

  it('⚠ calleeRecentlyDeclinedCaller ← a decline by this callee of this caller in the last 2 minutes', async () => {
    mocks.hasDeclinedSince.mockResolvedValue(true);

    const gates = await loadCallNowGates(base());

    expect(mocks.hasDeclinedSince).toHaveBeenCalledWith({
      callerUserId: CLIENT,
      calleeUserId: EXPERT_USER,
      since: new Date(NOW_IN_HOURS.getTime() - 2 * 60_000),
    });
    expect(gates.availability).toEqual({
      canCallNow: false,
      refusal: 'recently_declined',
      reason: null,
    });
  });

  it('⚠ mayRing false (an agency owner/admin, not the delivering expert): no callee, the action is hidden', async () => {
    const gates = await loadCallNowGates(base({ side: 'expert', userId: BOOKER, mayRing: false }));

    expect(mocks.resolveCallee).not.toHaveBeenCalled();
    expect(gates.callee).toBeNull();
    expect(gates.availability).toEqual({
      canCallNow: false,
      refusal: 'callee_unavailable',
      reason: null,
    });
  });

  it('a company with no wallet skips the wallet-session read', async () => {
    mocks.findByCompanyId.mockResolvedValue(undefined);

    await loadCallNowGates(base());

    expect(mocks.hasActiveSessionForWallet).not.toHaveBeenCalled();
  });

  it('expertWithinCallHours: the same instant is outside 8–20 in the expert’s zone', async () => {
    const gates = await loadCallNowGates(base({ now: NOW_AFTER_HOURS }));

    expect(gates.availability).toMatchObject({ refusal: 'outside_hours', reason: 'outside_hours' });
  });

  it('calleeOnline ← the presence port flips `outside_hours` off', async () => {
    const online: CalleePresence = { isOnline: vi.fn().mockResolvedValue(true) };

    const gates = await loadCallNowGates(base({ now: NOW_AFTER_HOURS, presence: online }));

    expect(online.isOnline).toHaveBeenCalledWith(EXPERT_USER);
    expect(gates.availability).toEqual({ canCallNow: true });
  });

  it('an invalid expert zone fails closed on hours and warns', async () => {
    mocks.findResolverSettings.mockResolvedValue({
      userId: EXPERT_USER,
      timezone: 'Not/AZone',
      availableForWork: true,
    });

    const gates = await loadCallNowGates(base());

    expect(gates.availability).toMatchObject({ refusal: 'outside_hours' });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('not a valid IANA zone')
    );
  });
});

describe('loadCallNowGates — the in-place candidate', () => {
  function meeting(id: string, start: string) {
    return { id, status: 'scheduled', scheduledStart: new Date(start) };
  }

  it('is the same-day booking later today in the CALLER’s zone', async () => {
    // 10:00 Sydney on the 18th; a 15:00 Sydney booking the same day.
    mocks.listMeetingsForContext.mockResolvedValue([
      meeting('m-today', '2026-11-18T04:00:00.000Z'),
    ]);

    const gates = await loadCallNowGates(base());

    expect(gates.inPlaceCandidate).toEqual({
      meetingId: 'm-today',
      scheduledStart: new Date('2026-11-18T04:00:00.000Z'),
    });
    expect(mocks.listMeetingsForContext).toHaveBeenCalledWith('case', ENGAGEMENT_ID);
  });

  it('is null for a booking on the next local day', async () => {
    // Tomorrow 10:00 Sydney = 2026-11-18T23:00Z.
    mocks.listMeetingsForContext.mockResolvedValue([
      meeting('m-tomorrow', '2026-11-18T23:00:00.000Z'),
    ]);

    expect((await loadCallNowGates(base())).inPlaceCandidate).toBeNull();
  });

  it('judges "same day" in the CALLER’s zone, not UTC', async () => {
    // 23:00 on the 17th in Sydney; the booking is 01:00 on the 18th in Sydney. Both fall on the
    // 17th in UTC, so a UTC reading would wrongly offer it.
    mocks.listMeetingsForContext.mockResolvedValue([meeting('m', '2026-11-17T14:00:00.000Z')]);

    const gates = await loadCallNowGates(base({ now: new Date('2026-11-17T12:00:00.000Z') }));

    expect(gates.inPlaceCandidate).toBeNull();
  });

  it('is always null for an expert caller, with no caller-zone read (decision 9)', async () => {
    mocks.listMeetingsForContext.mockResolvedValue([
      meeting('m-today', '2026-11-18T04:00:00.000Z'),
    ]);
    mocks.resolveCallee.mockResolvedValue({
      ok: true,
      userId: BOOKER,
      timeZone: 'Australia/Sydney',
    });

    const gates = await loadCallNowGates(base({ side: 'expert', userId: EXPERT_USER }));

    expect(gates.inPlaceCandidate).toBeNull();
    expect(mocks.findTimezoneContext).not.toHaveBeenCalled();
  });

  it('falls back to UTC when the caller has no saved zone', async () => {
    mocks.findTimezoneContext.mockResolvedValue(null);
    mocks.listMeetingsForContext.mockResolvedValue([meeting('m-utc', '2026-11-17T23:30:00.000Z')]);

    expect((await loadCallNowGates(base())).inPlaceCandidate?.meetingId).toBe('m-utc');
  });
});

describe('loadCallNowGates — a booking in its join window hides Call now (decision 20)', () => {
  const RING_MEETING_ID = '99999999-9999-4999-8999-999999999999';
  /** The join window opens 3 minutes before the start. */
  const WINDOW_MS = 3 * 60_000;

  function caseMeeting(id: string, status: string, startOffsetMs: number) {
    return {
      id,
      status,
      scheduledStart: new Date(NOW_IN_HOURS.getTime() + startOffsetMs),
    };
  }

  it.each<{ side: 'client' | 'expert'; userId: string }>([
    { side: 'client', userId: CLIENT },
    { side: 'expert', userId: EXPERT_USER },
  ])('$side caller: refuses one second after the window opens', async ({ side, userId }) => {
    mocks.resolveCallee.mockResolvedValue({ ok: true, userId: BOOKER, timeZone: 'UTC' });
    mocks.listMeetingsForContext.mockResolvedValue([
      caseMeeting('m-soon', 'scheduled', WINDOW_MS - 1_000),
    ]);

    const gates = await loadCallNowGates(base({ side, userId }));

    expect(gates.availability).toEqual({
      canCallNow: false,
      refusal: 'booking_starting',
      reason: null,
    });
  });

  it('refuses exactly at the instant the window opens', async () => {
    mocks.listMeetingsForContext.mockResolvedValue([caseMeeting('m-edge', 'scheduled', WINDOW_MS)]);

    expect((await loadCallNowGates(base())).availability).toMatchObject({
      refusal: 'booking_starting',
    });
  });

  it('offers the call one second before the window opens', async () => {
    mocks.listMeetingsForContext.mockResolvedValue([
      caseMeeting('m-later', 'scheduled', WINDOW_MS + 1_000),
    ]);

    expect((await loadCallNowGates(base())).availability).toEqual({ canCallNow: true });
  });

  it.each(['in_progress', 'waiting_for_participants'])(
    'refuses while a meeting on the case is %s',
    async (status) => {
      mocks.listMeetingsForContext.mockResolvedValue([caseMeeting('m-live', status, -60_000)]);

      expect((await loadCallNowGates(base())).availability).toMatchObject({
        refusal: 'booking_starting',
        reason: null,
      });
    }
  );

  it.each(['ended', 'cancelled'])('ignores a %s meeting', async (status) => {
    mocks.listMeetingsForContext.mockResolvedValue([caseMeeting('m-done', status, -60_000)]);

    expect((await loadCallNowGates(base())).availability).toEqual({ canCallNow: true });
  });

  it('does not count the ringing ring’s own meeting', async () => {
    mocks.findRingingForEngagement.mockResolvedValue({
      meetingId: RING_MEETING_ID,
      status: 'ringing',
      placement: 'new_meeting',
      createdAt: new Date(NOW_IN_HOURS.getTime() - 60_000),
      expiresAt: new Date(NOW_IN_HOURS.getTime() - 15_000),
      endedAt: null,
    });
    mocks.listMeetingsForContext.mockResolvedValue([
      caseMeeting(RING_MEETING_ID, 'scheduled', -60_000),
    ]);

    expect((await loadCallNowGates(base())).availability).toEqual({ canCallNow: true });
  });
});
