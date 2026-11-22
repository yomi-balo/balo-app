import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listScheduledStartingBetween: vi.fn(),
  findMeetingById: vi.fn(),
  listContexts: vi.fn(),
  resolveOwner: vi.fn(),
  findCompanyName: vi.fn(),
  findByDedupeKey: vi.fn(),
  scheduleNotification: vi.fn(),
  meetingOrigin: vi.fn(),
  deliveringOwner: vi.fn(),
  deliveringPartyName: vi.fn(),
  resolvePagePath: vi.fn(),
  resolveRecipient: vi.fn(),
  smsGate: vi.fn(),
  isCaseNoLongerActive: vi.fn(),
  trackServer: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: {
    listScheduledStartingBetween: mocks.listScheduledStartingBetween,
    findById: mocks.findMeetingById,
  },
  meetingContextsRepository: { listByMeeting: mocks.listContexts },
  companiesRepository: { findNameById: mocks.findCompanyName },
  scheduledNotificationsRepository: { findByDedupeKey: mocks.findByDedupeKey },
  resolveMeetingContextOwner: mocks.resolveOwner,
}));
vi.mock('@balo/analytics/server', () => ({
  MEETING_SERVER_EVENTS: { MEETING_REMINDER_SENT: 'meeting_reminder_sent' },
  trackServer: mocks.trackServer,
}));
vi.mock('./schedule.js', () => ({ scheduleNotification: mocks.scheduleNotification }));
vi.mock('../../services/call-now/meeting-origin.js', () => ({
  meetingOrigin: mocks.meetingOrigin,
}));
vi.mock('../../services/meetings/delivering-party.js', () => ({
  deliveringContextOwnerForMeeting: mocks.deliveringOwner,
  deliveringPartyName: mocks.deliveringPartyName,
}));
vi.mock('../../services/meetings/meeting-page-path.js', () => ({
  resolveMeetingPagePath: mocks.resolvePagePath,
}));
vi.mock('./meeting-single-recipient.js', () => ({
  resolveMeetingSingleRecipient: mocks.resolveRecipient,
  smsIneligibilityHoursOpen: mocks.smsGate,
}));
vi.mock('./meeting-absence.js', () => ({
  isCaseNoLongerActive: mocks.isCaseNoLongerActive,
  meetingIdFrom: (payload: Record<string, unknown>) =>
    typeof payload.meetingId === 'string' && payload.meetingId.length > 0
      ? payload.meetingId
      : null,
}));

import type { ScheduledNotification } from '@balo/db';
import { MEETING_REMINDER_OFFSETS, type MeetingReminderOffset } from '../events.js';
import {
  MEETING_REMINDER_ARM_LEAD_MS,
  MEETING_REMINDER_ARM_TOLERANCE_MS,
  MEETING_REMINDER_BATCH_LIMIT,
  MEETING_REMINDER_RECHECK,
  REARMABLE_MEETING_REMINDER_SKIP_REASONS,
  armMeetingReminders,
  armWindowFor,
  meetingReminderKey,
  meetingReminderRecheck,
} from './meeting-reminders.js';

const MEETING_ID = '22222222-2222-4222-8222-222222222222';
const COMPANY_ID = '33333333-3333-4333-8333-333333333333';
const PROFILE_ID = '44444444-4444-4444-8444-444444444444';
const BOOKER_ID = '55555555-5555-4555-8555-555555555555';
const CORRELATION_ID = 'c0000000-0000-4000-8000-000000000000';
const MINUTE = 60_000;
const NOW = new Date('2026-11-18T22:00:00.000Z');
const OFFSETS = Object.keys(MEETING_REMINDER_OFFSETS) as MeetingReminderOffset[];

/** A start whose `offset` fire time sits `fireDeltaMs` after NOW. */
function startFor(offset: MeetingReminderOffset, fireDeltaMs: number): Date {
  return new Date(NOW.getTime() + fireDeltaMs + MEETING_REMINDER_OFFSETS[offset].beforeStartMs);
}

function inWindow(offset: MeetingReminderOffset, fireDeltaMs: number): boolean {
  const { startFrom, startTo } = armWindowFor(offset, NOW);
  const start = startFor(offset, fireDeltaMs);
  return start >= startFrom && start <= startTo;
}

const OWNER = {
  companyId: COMPANY_ID,
  expertProfileId: PROFILE_ID,
  deliveringAgency: { from: 'expert_profile' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listScheduledStartingBetween.mockResolvedValue([]);
  mocks.findByDedupeKey.mockResolvedValue([]);
  mocks.meetingOrigin.mockResolvedValue('booked');
  mocks.deliveringOwner.mockResolvedValue(OWNER);
  mocks.scheduleNotification.mockResolvedValue({ outcome: 'scheduled' });
});

describe('the key and the registry name', () => {
  it('keys one promise per meeting, offset, audience and start', () => {
    expect(meetingReminderKey(MEETING_ID, '1h', 'client', '2026-11-18T23:00:00.000Z')).toBe(
      `meeting_reminder:${MEETING_ID}:1h:client:2026-11-18T23:00:00.000Z`
    );
    expect(MEETING_REMINDER_RECHECK).toBe('meeting_reminder');
  });

  it('may re-arm only after a start move or a cleared sibling decision', () => {
    expect(REARMABLE_MEETING_REMINDER_SKIP_REASONS).toEqual(['start_moved', 'already_decided']);
  });
});

describe('armWindowFor', () => {
  it.each(OFFSETS)('%s: a fire time 90 s past is in, 3 min past is out', (offset) => {
    expect(inWindow(offset, -90_000)).toBe(true);
    expect(inWindow(offset, -3 * MINUTE)).toBe(false);
  });

  it.each(OFFSETS)('%s: a fire time 4 min ahead is in, 6 min ahead is out', (offset) => {
    expect(inWindow(offset, 4 * MINUTE)).toBe(true);
    expect(inWindow(offset, 6 * MINUTE)).toBe(false);
  });

  it('states its bounds as tolerance and lead', () => {
    expect(MEETING_REMINDER_ARM_TOLERANCE_MS).toBe(2 * MINUTE);
    expect(MEETING_REMINDER_ARM_LEAD_MS).toBe(5 * MINUTE);
    expect(armWindowFor('1h', NOW)).toEqual({
      startFrom: new Date(NOW.getTime() - 2 * MINUTE + 60 * MINUTE),
      startTo: new Date(NOW.getTime() + 5 * MINUTE + 60 * MINUTE),
    });
  });
});

describe('armMeetingReminders', () => {
  const START = startFor('1h', MINUTE);

  function listOnlyIn(start: Date): void {
    mocks.listScheduledStartingBetween.mockImplementation(
      async (input: { startFrom: Date; startTo: Date }) =>
        start >= input.startFrom && start <= input.startTo
          ? [{ id: MEETING_ID, scheduledStart: start }]
          : []
    );
  }

  it('reads one bounded window per offset', async () => {
    await armMeetingReminders(NOW);

    expect(mocks.listScheduledStartingBetween.mock.calls.map(([input]) => input)).toEqual(
      OFFSETS.map((offset) => ({
        ...armWindowFor(offset, NOW),
        limit: MEETING_REMINDER_BATCH_LIMIT,
      }))
    );
  });

  it('arms both audiences with first_wins, the guard, the fire time and a fresh uuid each', async () => {
    listOnlyIn(START);

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(2);
    const [
      [clientEvent, clientPayload, clientOptions],
      [expertEvent, expertPayload, expertOptions],
    ] = mocks.scheduleNotification.mock.calls;
    expect(clientEvent).toBe('meeting.reminder_to_client');
    expect(expertEvent).toBe('meeting.reminder_to_expert');
    expect(clientOptions).toEqual({
      key: meetingReminderKey(MEETING_ID, '1h', 'client', START.toISOString()),
      at: new Date(NOW.getTime() + MINUTE),
      mode: 'first_wins',
      recheck: 'meeting_reminder',
    });
    expect(expertOptions.key).toBe(
      meetingReminderKey(MEETING_ID, '1h', 'expert', START.toISOString())
    );
    expect(clientPayload).toEqual({
      correlationId: expect.any(String),
      meetingId: MEETING_ID,
      scheduledStartIso: START.toISOString(),
      offset: '1h',
      companyId: COMPANY_ID,
      expertProfileId: PROFILE_ID,
      recipientUserId: null,
      recipientTimeZone: null,
      counterpartyName: null,
      callLabel: null,
      contextType: null,
      durationMinutes: null,
      joinPath: null,
      reschedulePath: null,
    });
    expect(clientPayload.correlationId).not.toBe(expertPayload.correlationId);
    expect(clientPayload.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a meeting booked 3h out gets only the 1h and 30m offsets after the 24h window has passed', async () => {
    const start = new Date(NOW.getTime() + 3 * 60 * MINUTE);
    listOnlyIn(start);
    await armMeetingReminders(NOW);
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();

    // Two hours later the same meeting is 1h out: only its 1h fire time is now in a window.
    const later = new Date(NOW.getTime() + 2 * 60 * MINUTE + MINUTE);
    listOnlyIn(start);
    await armMeetingReminders(later);
    const offsets = mocks.scheduleNotification.mock.calls.map(([, payload]) => payload.offset);
    expect(new Set(offsets)).toEqual(new Set(['1h']));
  });

  it('a new start arms a new key', async () => {
    listOnlyIn(START);
    await armMeetingReminders(NOW);
    const moved = new Date(START.getTime() + 2 * MINUTE);
    listOnlyIn(moved);
    mocks.scheduleNotification.mockClear();

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification.mock.calls[0]?.[2].key).toBe(
      meetingReminderKey(MEETING_ID, '1h', 'client', moved.toISOString())
    );
  });

  it('arms nothing for an audience whose key is decided', async () => {
    listOnlyIn(START);
    mocks.findByDedupeKey.mockImplementation(async (key: string) =>
      key.includes(':client:') ? [{ id: 'old', status: 'published', skipReason: null }] : []
    );

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleNotification.mock.calls[0]?.[0]).toBe('meeting.reminder_to_expert');
  });

  it('re-arms a key whose last skip was start_moved', async () => {
    listOnlyIn(START);
    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'old', status: 'skipped', skipReason: 'start_moved' },
    ]);

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(2);
  });

  it('stops before any other read when both keys are decided', async () => {
    listOnlyIn(START);
    mocks.findByDedupeKey.mockResolvedValue([{ id: 'old', status: 'published', skipReason: null }]);

    await armMeetingReminders(NOW);

    expect(mocks.meetingOrigin).not.toHaveBeenCalled();
    expect(mocks.deliveringOwner).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it('stops before any other read when every audience already has a pending promise', async () => {
    listOnlyIn(START);
    mocks.findByDedupeKey.mockResolvedValue([
      { id: 'live', status: 'pending', skipReason: null, payload: { expertProfileId: PROFILE_ID } },
    ]);

    await armMeetingReminders(NOW);

    expect(mocks.findByDedupeKey).toHaveBeenCalledTimes(2);
    expect(mocks.meetingOrigin).not.toHaveBeenCalled();
    expect(mocks.deliveringOwner).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it('arms only the undecided audience when the other already has a pending promise', async () => {
    listOnlyIn(START);
    mocks.findByDedupeKey.mockImplementation(async (key: string) =>
      key.includes(':client:')
        ? [
            {
              id: 'live',
              status: 'pending',
              skipReason: null,
              payload: { expertProfileId: PROFILE_ID },
            },
          ]
        : []
    );

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleNotification.mock.calls[0]?.[0]).toBe('meeting.reminder_to_expert');
  });

  it('counts only the client audience once a stored promise shows the meeting names no expert', async () => {
    listOnlyIn(START);
    mocks.findByDedupeKey.mockImplementation(async (key: string) =>
      key.includes(':client:')
        ? [{ id: 'live', status: 'pending', skipReason: null, payload: { expertProfileId: null } }]
        : []
    );

    await armMeetingReminders(NOW);

    expect(mocks.meetingOrigin).not.toHaveBeenCalled();
    expect(mocks.deliveringOwner).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it('never arms a Call now meeting', async () => {
    listOnlyIn(START);
    mocks.meetingOrigin.mockResolvedValue('call_now');

    await armMeetingReminders(NOW);

    expect(mocks.deliveringOwner).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
  });

  it('arms nothing, and says why, when the owner is unresolved', async () => {
    listOnlyIn(START);
    mocks.deliveringOwner.mockResolvedValue(null);

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      { meetingId: MEETING_ID, offset: '1h' },
      'Meeting reminder not armed: owner unresolved'
    );
  });

  it('arms only the client when the meeting names no expert', async () => {
    listOnlyIn(START);
    mocks.deliveringOwner.mockResolvedValue({ ...OWNER, expertProfileId: null });

    await armMeetingReminders(NOW);

    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleNotification.mock.calls[0]?.[0]).toBe('meeting.reminder_to_client');
    expect(mocks.scheduleNotification.mock.calls[0]?.[1].expertProfileId).toBeNull();
  });

  it('logs a per-offset summary with armed and already-pending counts', async () => {
    listOnlyIn(START);
    mocks.scheduleNotification
      .mockResolvedValueOnce({ outcome: 'scheduled' })
      .mockResolvedValueOnce({ outcome: 'already_pending' });

    await armMeetingReminders(NOW);

    expect(mocks.info).toHaveBeenCalledWith(
      { offset: '1h', meetings: 1, armed: 1, alreadyPending: 1 },
      'Meeting reminders armed'
    );
  });

  it('warns when an offset read fills the batch', async () => {
    mocks.listScheduledStartingBetween.mockResolvedValueOnce(
      Array.from({ length: MEETING_REMINDER_BATCH_LIMIT }, (_, index) => ({
        id: `meeting-${index}`,
        scheduledStart: START,
      }))
    );
    mocks.findByDedupeKey.mockResolvedValue([{ id: 'old', status: 'published', skipReason: null }]);

    await armMeetingReminders(NOW);

    expect(mocks.warn).toHaveBeenCalledWith(
      { offset: '24h', limit: MEETING_REMINDER_BATCH_LIMIT },
      'Meeting reminder batch FILLED — meetings were dropped from this tick'
    );
  });

  it('one failing meeting is warned about and does not stop the next', async () => {
    mocks.listScheduledStartingBetween.mockResolvedValueOnce([
      { id: 'meeting-a', scheduledStart: START },
      { id: MEETING_ID, scheduledStart: START },
    ]);
    mocks.deliveringOwner.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(OWNER);

    await armMeetingReminders(NOW);

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'meeting-a', offset: '24h', error: 'db blip' }),
      'Meeting reminder arm failed — the next tick retries'
    );
    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(2);
  });
});

describe('meetingReminderRecheck', () => {
  const START = new Date('2026-11-18T23:00:00.000Z');

  function row(
    overrides: Record<string, unknown> = {},
    event = 'meeting.reminder_to_client',
    attempts = 1
  ): ScheduledNotification {
    return {
      id: 'row-1',
      event,
      attempts,
      payload: {
        correlationId: CORRELATION_ID,
        meetingId: MEETING_ID,
        scheduledStartIso: START.toISOString(),
        offset: '1h',
        companyId: COMPANY_ID,
        expertProfileId: PROFILE_ID,
        recipientUserId: null,
        recipientTimeZone: null,
        counterpartyName: null,
        callLabel: null,
        contextType: null,
        durationMinutes: null,
        joinPath: null,
        reschedulePath: null,
        ...overrides,
      },
    } as unknown as ScheduledNotification;
  }

  beforeEach(() => {
    mocks.findMeetingById.mockResolvedValue({
      id: MEETING_ID,
      status: 'scheduled',
      scheduledStart: START,
      scheduledEnd: new Date(START.getTime() + 45 * MINUTE),
    });
    mocks.isCaseNoLongerActive.mockResolvedValue(false);
    mocks.listContexts.mockResolvedValue([{ contextType: 'case', contextId: 'case-1' }]);
    mocks.resolveOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: PROFILE_ID });
    mocks.resolveRecipient.mockResolvedValue({
      ok: true,
      userId: BOOKER_ID,
      timeZone: 'Australia/Sydney',
    });
    mocks.smsGate.mockResolvedValue(null);
    mocks.deliveringPartyName.mockResolvedValue('CloudPeak');
    mocks.findCompanyName.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
    mocks.resolvePagePath.mockResolvedValue('/cases/case-1');
  });

  async function skippedWith(subject: ScheduledNotification): Promise<string | null> {
    const result = await meetingReminderRecheck(subject);
    return result.publish ? null : result.reason;
  }

  describe('skips', () => {
    it.each([
      ['no meeting id', { meetingId: undefined }],
      ['an offset not in the table', { offset: '2h' }],
      ['no correlation id', { correlationId: '' }],
      ['no start', { scheduledStartIso: undefined }],
      ['no company', { companyId: undefined }],
    ])('malformed_payload: %s', async (_label, overrides) => {
      await expect(skippedWith(row(overrides))).resolves.toBe('malformed_payload');
      expect(mocks.findMeetingById).not.toHaveBeenCalled();
    });

    it('malformed_payload: an unknown event', async () => {
      await expect(skippedWith(row({}, 'meeting.reminder_to_guest'))).resolves.toBe(
        'malformed_payload'
      );
    });

    it('meeting_missing', async () => {
      mocks.findMeetingById.mockResolvedValue(undefined);

      await expect(skippedWith(row())).resolves.toBe('meeting_missing');
    });

    it('not_scheduled for a cancelled meeting', async () => {
      mocks.findMeetingById.mockResolvedValue({
        id: MEETING_ID,
        status: 'cancelled',
        scheduledStart: START,
      });

      await expect(skippedWith(row())).resolves.toBe('not_scheduled');
    });

    it('start_moved when the meeting no longer starts when the promise was armed', async () => {
      mocks.findMeetingById.mockResolvedValue({
        id: MEETING_ID,
        status: 'scheduled',
        scheduledStart: new Date(START.getTime() + 30 * MINUTE),
      });

      await expect(skippedWith(row())).resolves.toBe('start_moved');
      expect(mocks.meetingOrigin).not.toHaveBeenCalled();
    });

    it('call_now', async () => {
      mocks.meetingOrigin.mockResolvedValue('call_now');

      await expect(skippedWith(row())).resolves.toBe('call_now');
    });

    it('already_decided, ignoring its own row', async () => {
      mocks.findByDedupeKey.mockResolvedValue([
        { id: 'row-1', status: 'claimed', skipReason: null },
        { id: 'earlier', status: 'published', skipReason: null },
      ]);

      await expect(skippedWith(row())).resolves.toBe('already_decided');
      expect(mocks.findByDedupeKey).toHaveBeenCalledWith(
        meetingReminderKey(MEETING_ID, '1h', 'client', START.toISOString())
      );
    });

    it('does not read its own claimed row as a decision', async () => {
      mocks.findByDedupeKey.mockResolvedValue([
        { id: 'row-1', status: 'claimed', skipReason: null },
      ]);

      await expect(meetingReminderRecheck(row())).resolves.toMatchObject({ publish: true });
    });

    it('case_closed', async () => {
      mocks.isCaseNoLongerActive.mockResolvedValue(true);

      await expect(skippedWith(row())).resolves.toBe('case_closed');
    });

    it('owner_unresolved when the meeting has no primary context', async () => {
      mocks.listContexts.mockResolvedValue([]);

      await expect(skippedWith(row())).resolves.toBe('owner_unresolved');
    });

    it('owner_unresolved when the owner cannot be resolved', async () => {
      mocks.resolveOwner.mockResolvedValue(undefined);

      await expect(skippedWith(row())).resolves.toBe('owner_unresolved');
    });

    it('owner_mismatch when the company changed', async () => {
      mocks.resolveOwner.mockResolvedValue({ companyId: 'other', expertProfileId: PROFILE_ID });

      await expect(skippedWith(row())).resolves.toBe('owner_mismatch');
    });

    it('owner_mismatch when the expert changed', async () => {
      mocks.resolveOwner.mockResolvedValue({ companyId: COMPANY_ID, expertProfileId: 'other' });

      await expect(skippedWith(row())).resolves.toBe('owner_mismatch');
    });

    it('no_booker for a booker who has left, or a system-booked meeting', async () => {
      mocks.resolveRecipient.mockResolvedValue({ ok: false, reason: 'no_booker' });

      await expect(skippedWith(row())).resolves.toBe('no_booker');
    });

    it('no_expert', async () => {
      mocks.resolveRecipient.mockResolvedValue({ ok: false, reason: 'no_expert' });

      await expect(skippedWith(row({}, 'meeting.reminder_to_expert'))).resolves.toBe('no_expert');
    });

    it.each(['no_number', 'not_opted_in', 'active_in_app'])(
      '30m: %s from the SMS gate is a skip',
      async (reason) => {
        mocks.smsGate.mockResolvedValue(reason);

        await expect(skippedWith(row({ offset: '30m' }))).resolves.toBe(reason);
      }
    );

    it.each(['24h', '1h'])('%s never consults the SMS gate', async (offset) => {
      mocks.smsGate.mockResolvedValue('no_number');

      await expect(meetingReminderRecheck(row({ offset }))).resolves.toMatchObject({
        publish: true,
      });
      expect(mocks.smsGate).not.toHaveBeenCalled();
    });

    it('logs each skip with its reason', async () => {
      mocks.isCaseNoLongerActive.mockResolvedValue(true);

      await meetingReminderRecheck(row());

      expect(mocks.info).toHaveBeenCalledWith(
        { meetingId: MEETING_ID, event: 'meeting.reminder_to_client', reason: 'case_closed' },
        'Meeting reminder skipped'
      );
    });
  });

  describe('publish', () => {
    it('rebuilds the client payload field by field, carrying the correlation id', async () => {
      const result = await meetingReminderRecheck(row());

      expect(result).toEqual({
        publish: true,
        payload: {
          correlationId: CORRELATION_ID,
          meetingId: MEETING_ID,
          scheduledStartIso: START.toISOString(),
          offset: '1h',
          companyId: COMPANY_ID,
          expertProfileId: PROFILE_ID,
          recipientUserId: BOOKER_ID,
          recipientTimeZone: 'Australia/Sydney',
          counterpartyName: 'CloudPeak',
          callLabel: 'Consultation',
          contextType: 'case',
          durationMinutes: 45,
          joinPath: `/meetings/${MEETING_ID}/call`,
          reschedulePath: '/cases/case-1',
        },
      });
      expect(mocks.resolveRecipient).toHaveBeenCalledWith('client', {
        meetingId: MEETING_ID,
        companyId: COMPANY_ID,
        expertProfileId: PROFILE_ID,
      });
      expect(mocks.resolvePagePath).toHaveBeenCalledWith(
        { contextType: 'case', contextId: 'case-1' },
        true
      );
    });

    it('never spreads stray stored fields into the published payload', async () => {
      const result = await meetingReminderRecheck(
        row({ userId: 'someone-else', email: 'a@b.co', recipientUserIds: ['x'] })
      );

      expect(result.publish).toBe(true);
      if (result.publish) {
        expect(Object.keys(result.payload).sort()).toEqual(
          [
            'correlationId',
            'meetingId',
            'scheduledStartIso',
            'offset',
            'companyId',
            'expertProfileId',
            'recipientUserId',
            'recipientTimeZone',
            'counterpartyName',
            'callLabel',
            'contextType',
            'durationMinutes',
            'joinPath',
            'reschedulePath',
          ].sort()
        );
        expect(JSON.stringify(result.payload)).not.toContain('@');
      }
    });

    it('names the client company to the expert', async () => {
      mocks.resolveRecipient.mockResolvedValue({ ok: true, userId: 'expert-user', timeZone: null });

      const result = await meetingReminderRecheck(row({}, 'meeting.reminder_to_expert'));

      expect(result).toMatchObject({
        publish: true,
        payload: {
          recipientUserId: 'expert-user',
          recipientTimeZone: null,
          counterpartyName: 'Northwind Industrial',
        },
      });
      expect(mocks.resolveRecipient).toHaveBeenCalledWith('expert', expect.any(Object));
      expect(mocks.deliveringPartyName).not.toHaveBeenCalled();
    });

    it('leaves the label and path null when the context has neither', async () => {
      mocks.listContexts.mockResolvedValue([{ contextType: 'retainer_checkin', contextId: 'r-1' }]);
      mocks.resolvePagePath.mockResolvedValue(null);

      await expect(meetingReminderRecheck(row())).resolves.toMatchObject({
        publish: true,
        payload: { callLabel: null, reschedulePath: null, contextType: 'retainer_checkin' },
      });
    });

    it('runs the SMS gate for the 30m offset on the resolved recipient', async () => {
      await meetingReminderRecheck(row({ offset: '30m' }));

      expect(mocks.smsGate).toHaveBeenCalledWith('client', BOOKER_ID);
    });
  });

  describe('analytics', () => {
    it('a 1h publish emits one event per channel: email and in_app', async () => {
      await meetingReminderRecheck(row());

      expect(mocks.trackServer).toHaveBeenCalledTimes(2);
      const base = {
        meeting_id: MEETING_ID,
        offset: '1h',
        audience: 'client',
        context_type: 'case',
        distinct_id: BOOKER_ID,
      };
      expect(mocks.trackServer).toHaveBeenCalledWith('meeting_reminder_sent', {
        ...base,
        channel: 'email',
      });
      expect(mocks.trackServer).toHaveBeenCalledWith('meeting_reminder_sent', {
        ...base,
        channel: 'in_app',
      });
    });

    it.each([
      ['24h', 'email'],
      ['30m', 'sms'],
    ])('a %s publish emits one %s event', async (offset, channel) => {
      await meetingReminderRecheck(row({ offset }));

      expect(mocks.trackServer).toHaveBeenCalledTimes(1);
      expect(mocks.trackServer).toHaveBeenCalledWith(
        'meeting_reminder_sent',
        expect.objectContaining({ offset, channel })
      );
    });

    it('a re-claimed attempt publishes but emits nothing', async () => {
      await expect(
        meetingReminderRecheck(row({}, 'meeting.reminder_to_client', 2))
      ).resolves.toMatchObject({
        publish: true,
      });

      expect(mocks.trackServer).not.toHaveBeenCalled();
    });

    it('a skip emits nothing', async () => {
      mocks.isCaseNoLongerActive.mockResolvedValue(true);

      await meetingReminderRecheck(row());

      expect(mocks.trackServer).not.toHaveBeenCalled();
    });
  });

  it('lets a repository throw propagate so the tick retries', async () => {
    mocks.findMeetingById.mockRejectedValue(new Error('db down'));

    await expect(meetingReminderRecheck(row())).rejects.toThrow('db down');
  });
});
