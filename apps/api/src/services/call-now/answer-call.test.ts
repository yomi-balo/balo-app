import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByIdForParty: vi.fn(),
  authorize: vi.fn(),
  endRing: vi.fn(),
  checkFunding: vi.fn(),
  joinAsMember: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingRingsRepository: { findByIdForParty: mocks.findByIdForParty },
}));
vi.mock('./authorize-call-now.js', () => ({ authorizeCallNow: mocks.authorize }));
vi.mock('./end-ring.js', () => ({ endRing: mocks.endRing }));
vi.mock('../meetings/case-booking-funding.js', () => ({
  checkCaseBookingFunding: mocks.checkFunding,
}));
vi.mock('../meetings/join-meeting.js', () => ({ joinMeetingAsMember: mocks.joinAsMember }));

import { CALL_NOW_RING_MS, CALL_NOW_SCHEDULED_MINUTES } from '@balo/shared/meetings';
import { answerCallNow } from './answer-call.js';

const ENGAGEMENT_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';
const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const BOOKER = '55555555-5555-4555-8555-555555555555';
const EXPERT_USER = '22222222-2222-4222-8222-222222222222';
const RING_ID = '88888888-8888-4888-8888-888888888888';
const MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-11-16T10:00:00.000Z');

const CASE_ROW = { id: ENGAGEMENT_ID, companyId: COMPANY_ID, expertProfileId: EXPERT_PROFILE_ID };
const JOIN_OK = { ok: true, grant: { token: 'daily.jwt' } };

function ring(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RING_ID,
    meetingId: MEETING_ID,
    engagementId: ENGAGEMENT_ID,
    callerUserId: EXPERT_USER,
    calleeUserId: BOOKER,
    callerSide: 'expert',
    placement: 'new_meeting',
    status: 'ringing',
    createdAt: new Date(NOW.getTime() - 5_000),
    expiresAt: new Date(NOW.getTime() + CALL_NOW_RING_MS),
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}) {
  return answerCallNow({ ringId: RING_ID, userId: BOOKER, now: NOW, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findByIdForParty.mockResolvedValue(ring());
  mocks.authorize.mockResolvedValue({ ok: true, side: 'client', caseRow: CASE_ROW, mayRing: true });
  mocks.checkFunding.mockResolvedValue({ ok: true });
  mocks.joinAsMember.mockResolvedValue(JOIN_OK);
  mocks.endRing.mockResolvedValue({ ended: true, status: 'unanswered' });
});

describe('answerCallNow — the client commit to an expert-started ring', () => {
  it('checks funding with the ring’s own meeting excluded, then admits with answeringRingId', async () => {
    const minter = { mint: vi.fn() };

    await expect(answer({ minter })).resolves.toEqual({ ok: true, join: JOIN_OK });

    expect(mocks.checkFunding).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      scheduledStart: NOW,
      scheduledEnd: new Date(NOW.getTime() + CALL_NOW_SCHEDULED_MINUTES * 60_000),
      now: NOW,
      excludeMeetingId: MEETING_ID,
    });
    expect(mocks.joinAsMember).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: BOOKER,
      answeringRingId: RING_ID,
      minter,
    });
    expect(mocks.checkFunding.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.joinAsMember.mock.invocationCallOrder[0] as number
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ ringId: RING_ID, meetingId: MEETING_ID }),
      expect.stringContaining('answered')
    );
  });

  it('reads the ring by id AND identity', async () => {
    await answer();
    expect(mocks.findByIdForParty).toHaveBeenCalledWith(RING_ID, BOOKER);
  });

  describe('identity and auth come before any funding read', () => {
    it.each([
      ['an unknown ring or a stranger', undefined],
      ['the CALLER of the ring', ring({ calleeUserId: EXPERT_USER, callerUserId: BOOKER })],
      ['a client-started ring', ring({ callerSide: 'client' })],
      ['an in-place ring', ring({ placement: 'in_place' })],
    ])('%s is ring_not_found, with no funding read and no admission', async (_label, row) => {
      mocks.findByIdForParty.mockResolvedValue(row);

      await expect(answer()).resolves.toEqual({ ok: false, code: 'ring_not_found' });

      expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.checkFunding).not.toHaveBeenCalled();
      expect(mocks.joinAsMember).not.toHaveBeenCalled();
    });

    it('an expert-side callee (no client authorization) is ring_not_found, warned, never checked', async () => {
      mocks.authorize.mockResolvedValue({
        ok: true,
        side: 'expert',
        caseRow: CASE_ROW,
        mayRing: true,
      });

      await expect(answer()).resolves.toEqual({ ok: false, code: 'ring_not_found' });

      expect(mocks.warn).toHaveBeenCalledWith(
        expect.objectContaining({ ringId: RING_ID, userId: BOOKER }),
        'Call now answer denied'
      );
      expect(mocks.checkFunding).not.toHaveBeenCalled();
      expect(mocks.joinAsMember).not.toHaveBeenCalled();
    });

    it('a failed authorization is ring_not_found', async () => {
      mocks.authorize.mockResolvedValue({ ok: false, code: 'case_not_found' });

      await expect(answer()).resolves.toEqual({ ok: false, code: 'ring_not_found' });
      expect(mocks.checkFunding).not.toHaveBeenCalled();
    });
  });

  describe('ring state', () => {
    it.each(['connected', 'unanswered', 'declined', 'stopped'])(
      'a %s ring is ring_not_ringing with its status, and nothing else runs',
      async (status) => {
        mocks.findByIdForParty.mockResolvedValue(ring({ status }));

        await expect(answer()).resolves.toEqual({ ok: false, code: 'ring_not_ringing', status });

        expect(mocks.endRing).not.toHaveBeenCalled();
        expect(mocks.authorize).toHaveBeenCalledTimes(1);
        expect(mocks.checkFunding).not.toHaveBeenCalled();
      }
    );

    it.each([
      ['an ended', { status: 'declined' }],
      ['an expired', { expiresAt: new Date(NOW.getTime() - 1) }],
    ])(
      '⚠ %s ring answered by a callee who is no longer authorized is ring_not_found: nothing learned, nothing written',
      async (_label, overrides) => {
        mocks.findByIdForParty.mockResolvedValue(ring(overrides));
        mocks.authorize.mockResolvedValue({ ok: false, code: 'case_not_found' });

        await expect(answer()).resolves.toEqual({ ok: false, code: 'ring_not_found' });

        expect(mocks.endRing).not.toHaveBeenCalled();
        expect(mocks.checkFunding).not.toHaveBeenCalled();
        expect(mocks.joinAsMember).not.toHaveBeenCalled();
      }
    );

    it('a ring past expires_at is ended unanswered first, then ring_not_ringing', async () => {
      mocks.findByIdForParty.mockResolvedValue(ring({ expiresAt: new Date(NOW.getTime() - 1) }));

      await expect(answer()).resolves.toEqual({
        ok: false,
        code: 'ring_not_ringing',
        status: 'unanswered',
      });

      expect(mocks.endRing).toHaveBeenCalledWith({
        ringId: RING_ID,
        to: 'unanswered',
        actorUserId: null,
        now: NOW,
      });
      expect(mocks.checkFunding).not.toHaveBeenCalled();
      expect(mocks.joinAsMember).not.toHaveBeenCalled();
    });

    it('a lost end race reports the status the ring actually has', async () => {
      mocks.findByIdForParty.mockResolvedValue(ring({ expiresAt: new Date(NOW.getTime() - 1) }));
      mocks.endRing.mockResolvedValue({ ended: false, status: 'connected' });

      await expect(answer()).resolves.toEqual({
        ok: false,
        code: 'ring_not_ringing',
        status: 'connected',
      });
    });
  });

  describe('a funding refusal', () => {
    it.each([
      ['account_on_hold', 4_200],
      ['booking_unfunded', 12_500],
      ['booking_reserved', 30_000],
      ['booking_funding_unavailable', null],
    ])('%s carries its figure, admits nobody and ends no ring', async (code, figure) => {
      mocks.checkFunding.mockResolvedValue({ ok: false, code, suggestedTopUpMinor: figure });

      await expect(answer()).resolves.toEqual({
        ok: false,
        code,
        suggestedTopUpMinor: figure,
      });

      expect(mocks.joinAsMember).not.toHaveBeenCalled();
      expect(mocks.endRing).not.toHaveBeenCalled();
      expect(mocks.info).toHaveBeenCalledWith(
        expect.objectContaining({ code, ringId: RING_ID }),
        'Call now answer refused — funding'
      );
    });
  });

  it('a join refused after the check passed is join_failed, carrying the failure', async () => {
    const failure = { ok: false, code: 'meeting_not_open_for_join' };
    mocks.joinAsMember.mockResolvedValue(failure);

    await expect(answer()).resolves.toEqual({ ok: false, code: 'join_failed', failure });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'meeting_not_open_for_join' }),
      expect.stringContaining('join was refused')
    );
  });

  it('a repository error propagates to the route’s log.error boundary', async () => {
    mocks.findByIdForParty.mockRejectedValue(new Error('db down'));
    await expect(answer()).rejects.toThrow('db down');
  });
});
