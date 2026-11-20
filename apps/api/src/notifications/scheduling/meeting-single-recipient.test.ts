import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findBooker: vi.fn(),
  bookerParticipates: vi.fn(),
  findTimezoneContext: vi.fn(),
  findConsent: vi.fn(),
  deliveringExpertUserId: vi.fn(),
  isOnline: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  clientPartyRecipientsRepository: {
    findMeetingBookerUserId: mocks.findBooker,
    bookerStillParticipatesInCompany: mocks.bookerParticipates,
  },
  usersRepository: {
    findTimezoneContext: mocks.findTimezoneContext,
    findClientSmsConsent: mocks.findConsent,
  },
}));
vi.mock('../../services/meetings/delivering-party.js', () => ({
  deliveringExpertUserId: mocks.deliveringExpertUserId,
}));
vi.mock('../../services/call-now/callee-presence.js', () => ({
  offlineCalleePresence: { isOnline: mocks.isOnline },
}));

import {
  resolveMeetingSingleRecipient,
  smsIneligibilityHoursOpen,
} from './meeting-single-recipient.js';

const INPUT = { meetingId: 'meeting-1', companyId: 'company-1', expertProfileId: 'profile-1' };
const VERIFIED = new Date('2026-01-01T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findBooker.mockResolvedValue('booker-1');
  mocks.bookerParticipates.mockResolvedValue(true);
  mocks.deliveringExpertUserId.mockResolvedValue('expert-user-1');
  mocks.findTimezoneContext.mockResolvedValue({
    savedTimezone: 'Australia/Sydney',
    expert: { timezone: 'Europe/London' },
  });
  mocks.isOnline.mockResolvedValue(false);
});

describe('resolveMeetingSingleRecipient — client', () => {
  it('is the booker, in their saved zone', async () => {
    await expect(resolveMeetingSingleRecipient('client', INPUT)).resolves.toEqual({
      ok: true,
      userId: 'booker-1',
      timeZone: 'Australia/Sydney',
    });
    expect(mocks.findTimezoneContext).toHaveBeenCalledWith('booker-1', undefined);
  });

  it('is no_booker for a system-booked meeting', async () => {
    mocks.findBooker.mockResolvedValue(null);

    await expect(resolveMeetingSingleRecipient('client', INPUT)).resolves.toEqual({
      ok: false,
      reason: 'no_booker',
    });
    expect(mocks.bookerParticipates).not.toHaveBeenCalled();
  });

  it('is no_booker once the booker has left the company', async () => {
    mocks.bookerParticipates.mockResolvedValue(false);

    await expect(resolveMeetingSingleRecipient('client', INPUT)).resolves.toEqual({
      ok: false,
      reason: 'no_booker',
    });
  });

  it('has a null zone when the saved zone is unusable', async () => {
    mocks.findTimezoneContext.mockResolvedValue({ savedTimezone: 'Not/AZone' });

    await expect(resolveMeetingSingleRecipient('client', INPUT)).resolves.toMatchObject({
      ok: true,
      timeZone: null,
    });
  });
});

describe('resolveMeetingSingleRecipient — expert', () => {
  it('is the delivering expert, in their profile zone first', async () => {
    await expect(resolveMeetingSingleRecipient('expert', INPUT)).resolves.toEqual({
      ok: true,
      userId: 'expert-user-1',
      timeZone: 'Europe/London',
    });
    expect(mocks.findTimezoneContext).toHaveBeenCalledWith('expert-user-1', 'profile-1');
    expect(mocks.findBooker).not.toHaveBeenCalled();
  });

  it('falls back to the saved zone when the profile has none', async () => {
    mocks.findTimezoneContext.mockResolvedValue({ savedTimezone: 'Australia/Sydney' });

    await expect(resolveMeetingSingleRecipient('expert', INPUT)).resolves.toMatchObject({
      timeZone: 'Australia/Sydney',
    });
  });

  it('is no_expert when no delivering expert resolves', async () => {
    mocks.deliveringExpertUserId.mockResolvedValue(null);

    await expect(
      resolveMeetingSingleRecipient('expert', { ...INPUT, expertProfileId: null })
    ).resolves.toEqual({ ok: false, reason: 'no_expert' });
  });

  it('passes no profile id to the zone read when the meeting names none', async () => {
    await resolveMeetingSingleRecipient('expert', { ...INPUT, expertProfileId: null });

    expect(mocks.findTimezoneContext).toHaveBeenCalledWith('expert-user-1', undefined);
  });
});

describe('smsIneligibilityHoursOpen', () => {
  const clientConsent = {
    phone: '+61400000000',
    phoneVerifiedAt: VERIFIED,
    clientSmsOptedInAt: VERIFIED,
  };

  it('is null for a verified, opted-in, offline client', async () => {
    mocks.findConsent.mockResolvedValue(clientConsent);

    await expect(smsIneligibilityHoursOpen('client', 'booker-1')).resolves.toBeNull();
  });

  it('is not_opted_in for a client who has not opted in', async () => {
    mocks.findConsent.mockResolvedValue({ ...clientConsent, clientSmsOptedInAt: null });

    await expect(smsIneligibilityHoursOpen('client', 'booker-1')).resolves.toBe('not_opted_in');
  });

  it('is no_number when there is no verified number', async () => {
    mocks.findConsent.mockResolvedValue({ ...clientConsent, phoneVerifiedAt: null });

    await expect(smsIneligibilityHoursOpen('client', 'booker-1')).resolves.toBe('no_number');
  });

  it('is active_in_app for a recipient who is online', async () => {
    mocks.findConsent.mockResolvedValue(clientConsent);
    mocks.isOnline.mockResolvedValue(true);

    await expect(smsIneligibilityHoursOpen('client', 'booker-1')).resolves.toBe('active_in_app');
  });

  it('needs no opt-in for the expert side', async () => {
    mocks.findConsent.mockResolvedValue({ ...clientConsent, clientSmsOptedInAt: null });

    await expect(smsIneligibilityHoursOpen('expert', 'expert-user-1')).resolves.toBeNull();
  });
});
