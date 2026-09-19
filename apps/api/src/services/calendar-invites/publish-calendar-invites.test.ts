import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockListLiveByMeeting,
  mockListByMeetingContexts,
  mockPublish,
  mockResolveRecipients,
  mockCaptureException,
} = vi.hoisted(() => ({
  mockListLiveByMeeting: vi.fn(),
  mockListByMeetingContexts: vi.fn(),
  mockPublish: vi.fn(),
  mockResolveRecipients: vi.fn(),
  mockCaptureException: vi.fn(),
}));

// ⚠ ONLY `listLiveByMeeting` is exposed on `meetingCalendarEventsRepository` — a write call
// from this module would be a TypeError, which is the structural proof that the publisher
// never double-increments SEQUENCE (§4.5).
vi.mock('@balo/db', () => ({
  meetingCalendarEventsRepository: { listLiveByMeeting: mockListLiveByMeeting },
  meetingContextsRepository: { listByMeeting: mockListByMeetingContexts },
}));
vi.mock('../../notifications/index.js', () => ({
  notificationEvents: { publish: mockPublish },
}));
vi.mock('./resolve-calendar-invite-recipients.js', () => ({
  resolveCalendarInviteRecipients: mockResolveRecipients,
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  publishBookingCalendarInvites,
  publishRescheduleCalendarInvites,
  publishGuestAddedCalendarInvites,
  publishCancellationCalendarWithdrawals,
  publishGuestRemovedCalendarWithdrawal,
} = await import('./publish-calendar-invites.js');

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** The fields on the publisher own "Calendar invite enqueued" line, for the last publish. */
function lastEnqueuedFields(log: ReturnType<typeof fakeLog>): Record<string, unknown> {
  const call = log.info.mock.calls.at(-1) as [Record<string, unknown>, string] | undefined;
  expect(call?.[1]).toBe('Calendar invite enqueued');
  return call?.[0] ?? {};
}

const MEETING_ID = 'meeting-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  mockListByMeetingContexts.mockResolvedValue([{ contextType: 'case', contextId: 'ctx-1' }]);
});

describe('publishBookingCalendarInvites', () => {
  it('one publish per (row × recipient), with exact correlationIds', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 },
      { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 0 },
    ]);
    mockResolveRecipients.mockImplementation(({ party }: { party: string }) =>
      Promise.resolve(
        party === 'client'
          ? [{ kind: 'user', userId: 'booker-1' }]
          : [{ kind: 'user', userId: 'expert-1' }]
      )
    );
    const log = fakeLog();

    await publishBookingCalendarInvites(
      { meetingId: MEETING_ID, contextType: 'case', expertProfileId: 'ep-1' },
      log
    );

    expect(mockPublish).toHaveBeenCalledTimes(2);
    // F13 (fix round 1, R12) — the FULL spec, not a partial `objectContaining`: a publisher
    // emitting the wrong `transition` or omitting `recipient` must fail this test.
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'booked:row-client:0:client:user:booker-1',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'client',
        calendarEventId: 'row-client',
        method: 'REQUEST',
        transition: 'booked',
        recipient: { kind: 'user', userId: 'booker-1' },
        contextType: 'case',
      },
    });
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'booked:row-expert:0:expert:user:expert-1',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'expert',
        calendarEventId: 'row-expert',
        method: 'REQUEST',
        transition: 'booked',
        recipient: { kind: 'user', userId: 'expert-1' },
        contextType: 'case',
      },
    });
  });

  it('F6 (fix round 1, R5/S9) — one row resolver rejecting does not abort the fan-out: the other row still publishes, Sentry is called, the function resolves', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 },
      { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 0 },
    ]);
    mockResolveRecipients.mockImplementation(({ party }: { party: string }) => {
      if (party === 'client') return Promise.reject(new Error('transient read failure'));
      return Promise.resolve([{ kind: 'user', userId: 'expert-1' }]);
    });
    const log = fakeLog();

    await expect(
      publishBookingCalendarInvites(
        { meetingId: MEETING_ID, contextType: 'case', expertProfileId: 'ep-1' },
        log
      )
    ).resolves.toBeUndefined();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'meeting.calendar_invite',
      expect.objectContaining({
        calendarInvite: expect.objectContaining({ party: 'expert' }),
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        party: 'client',
        step: 'resolveCalendarInviteRecipients',
        error: 'transient read failure',
        stack: expect.any(String),
      }),
      'Calendar invite publisher read failed'
    );
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('F6 — the top-level listLiveByMeeting rejecting logs + Sentry and resolves, publishing nothing', async () => {
    mockListLiveByMeeting.mockRejectedValue(new Error('db down'));
    const log = fakeLog();

    await expect(
      publishBookingCalendarInvites(
        { meetingId: MEETING_ID, contextType: 'case', expertProfileId: 'ep-1' },
        log
      )
    ).resolves.toBeUndefined();

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'listLiveByMeeting', error: 'db down' }),
      'Calendar invite publisher read failed'
    );
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('the expert member is skipped for a provider_event row (no recipients) — logs the reason, publishes nothing for it', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'row-expert', party: 'expert', deliveryMode: 'provider_event', sequence: 0 },
    ]);
    mockResolveRecipients.mockResolvedValue([]);
    const log = fakeLog();

    await publishBookingCalendarInvites(
      { meetingId: MEETING_ID, contextType: 'case', expertProfileId: 'ep-1' },
      log
    );

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'provider_event_party' }),
      'Calendar invite not enqueued'
    );
  });

  it('no live rows ⇒ one skip log, no publish', async () => {
    mockListLiveByMeeting.mockResolvedValue([]);
    const log = fakeLog();

    await publishBookingCalendarInvites(
      { meetingId: MEETING_ID, contextType: 'case', expertProfileId: 'ep-1' },
      log
    );

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_calendar_row' }),
      'Calendar invite not enqueued'
    );
  });

  it('one recipient publish throwing does not stop the next, and never rejects', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 },
    ]);
    mockResolveRecipients.mockResolvedValue([
      { kind: 'user', userId: 'a' },
      { kind: 'user', userId: 'b' },
    ]);
    mockPublish.mockRejectedValueOnce(new Error('queue down')).mockResolvedValueOnce(undefined);
    const log = fakeLog();

    await expect(
      publishBookingCalendarInvites(
        { meetingId: MEETING_ID, contextType: 'case', expertProfileId: 'ep-1' },
        log
      )
    ).resolves.toBeUndefined();

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'queue down' }),
      'Calendar invite enqueue failed'
    );
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('publishRescheduleCalendarInvites', () => {
  it('uses the BUMPED rows passed in and never reads sequences itself', async () => {
    mockResolveRecipients.mockResolvedValue([{ kind: 'user', userId: 'booker-1' }]);
    const log = fakeLog();

    await publishRescheduleCalendarInvites(
      {
        meetingId: MEETING_ID,
        rescheduleAuditId: 'audit-1',
        expertProfileId: 'ep-1',
        calendarEvents: [{ id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 1 }],
      },
      log
    );

    expect(mockListLiveByMeeting).not.toHaveBeenCalled();
    // F13 — the FULL spec.
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'rescheduled:audit-1:client:user:booker-1',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'client',
        calendarEventId: 'row-client',
        method: 'REQUEST',
        transition: 'rescheduled',
        recipient: { kind: 'user', userId: 'booker-1' },
        contextType: 'case',
      },
    });
  });

  it('no calendar rows ⇒ skip, no publish', async () => {
    const log = fakeLog();

    await publishRescheduleCalendarInvites(
      {
        meetingId: MEETING_ID,
        rescheduleAuditId: 'audit-1',
        expertProfileId: null,
        calendarEvents: [],
      },
      log
    );

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('F6 — a row recipient-resolver rejecting is logged + Sentried and does not abort the other row', async () => {
    mockResolveRecipients.mockImplementation(({ party }: { party: string }) => {
      if (party === 'client') return Promise.reject(new Error('read blip'));
      return Promise.resolve([{ kind: 'user', userId: 'expert-1' }]);
    });
    const log = fakeLog();

    await expect(
      publishRescheduleCalendarInvites(
        {
          meetingId: MEETING_ID,
          rescheduleAuditId: 'audit-1',
          expertProfileId: 'ep-1',
          calendarEvents: [
            { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 1 },
            { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 1 },
          ],
        },
        log
      )
    ).resolves.toBeUndefined();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalled();
  });

  it('F6 — the context read (logs only) failing degrades contextType to null, publish still proceeds', async () => {
    mockListByMeetingContexts.mockRejectedValue(new Error('context read down'));
    mockResolveRecipients.mockResolvedValue([{ kind: 'user', userId: 'booker-1' }]);
    const log = fakeLog();

    await publishRescheduleCalendarInvites(
      {
        meetingId: MEETING_ID,
        rescheduleAuditId: 'audit-1',
        expertProfileId: 'ep-1',
        calendarEvents: [{ id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 1 }],
      },
      log
    );

    expect(mockPublish).toHaveBeenCalledWith(
      'meeting.calendar_invite',
      expect.objectContaining({
        calendarInvite: expect.objectContaining({ contextType: null }),
      })
    );
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('publishGuestAddedCalendarInvites', () => {
  it('one publish per guest id, none for other recipients', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 2 },
    ]);
    const log = fakeLog();

    await publishGuestAddedCalendarInvites(
      {
        meetingId: MEETING_ID,
        party: 'client',
        guestIds: ['guest-1', 'guest-2'],
        contextType: 'case',
      },
      log
    );

    expect(mockPublish).toHaveBeenCalledTimes(2);
    // F13 — the FULL spec.
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'guest_added:guest-1',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'client',
        calendarEventId: 'row-client',
        method: 'REQUEST',
        transition: 'guest_added',
        recipient: { kind: 'guest', guestId: 'guest-1' },
        contextType: 'case',
      },
    });
  });

  it('skips when the side has no live row', async () => {
    mockListLiveByMeeting.mockResolvedValue([
      { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 0 },
    ]);
    const log = fakeLog();

    await publishGuestAddedCalendarInvites(
      { meetingId: MEETING_ID, party: 'client', guestIds: ['guest-1'], contextType: 'case' },
      log
    );

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_calendar_row' }),
      'Calendar invite not enqueued'
    );
  });
});

// ── BAL-476 — the two withdrawal fan-outs ─────────────────────────────────────────────────

describe('publishCancellationCalendarWithdrawals', () => {
  it('one METHOD:CANCEL per (row × recipient), at each row CURRENT sequence, with exact keys', async () => {
    mockResolveRecipients.mockImplementation(({ party }: { party: string }) =>
      Promise.resolve(
        party === 'client'
          ? [
              { kind: 'user', userId: 'booker-1' },
              { kind: 'guest', guestId: 'guest-1' },
            ]
          : [{ kind: 'guest', guestId: 'guest-2' }]
      )
    );
    const log = fakeLog();

    await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: 'ep-1',
        calendarEvents: [
          { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 4 },
          { id: 'row-expert', party: 'expert', deliveryMode: 'provider_event', sequence: 4 },
        ],
      } as never,
      log
    );

    expect(mockPublish).toHaveBeenCalledTimes(3);
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'cancelled:audit-cancel-1:client:user:booker-1',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'client',
        calendarEventId: 'row-client',
        method: 'CANCEL',
        transition: 'cancelled',
        recipient: { kind: 'user', userId: 'booker-1' },
        contextType: 'case',
      },
    });
    // ⚠ THE EXPERT-PARTY `provider_event` ROW STILL FANS OUT — to that side's guests. This is
    // exactly why the delivery path's calendar-row read had to become retired-tolerant.
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'cancelled:audit-cancel-1:expert:guest:guest-2',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'expert',
        calendarEventId: 'row-expert',
        method: 'CANCEL',
        transition: 'cancelled',
        recipient: { kind: 'guest', guestId: 'guest-2' },
        contextType: 'case',
      },
    });
  });

  it('⚠ NEVER WRITES `sequence` — the mocked repository exposes no write method at all', async () => {
    mockResolveRecipients.mockResolvedValue([{ kind: 'user', userId: 'booker-1' }]);

    await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: null,
        calendarEvents: [{ id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 7 }],
      } as never,
      fakeLog()
    );

    const { meetingCalendarEventsRepository } = await import('@balo/db');
    expect(Object.keys(meetingCalendarEventsRepository)).toEqual(['listLiveByMeeting']);
    const [, published] = mockPublish.mock.calls[0] as [string, { calendarInvite: unknown }];
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(published.calendarInvite).toMatchObject({ method: 'CANCEL', transition: 'cancelled' });
  });

  it('skips an empty row set and never publishes', async () => {
    const log = fakeLog();
    await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: null,
        calendarEvents: [],
      },
      log
    );
    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_calendar_row' }),
      'Calendar invite not enqueued'
    );
  });

  it('never throws when the recipient read fails, and still covers the other row', async () => {
    mockResolveRecipients
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([{ kind: 'user', userId: 'expert-1' }]);
    const log = fakeLog();

    await expect(
      publishCancellationCalendarWithdrawals(
        {
          meetingId: MEETING_ID,
          cancelAuditId: 'audit-cancel-1',
          expertProfileId: 'ep-1',
          calendarEvents: [
            { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 },
            { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 0 },
          ],
        } as never,
        log
      )
    ).resolves.toBeInstanceOf(Set);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  // ── THE DISCHARGE REPORT — what the orchestrator retires from ──────────────────────────

  /**
   * ⚠⚠ THE WHOLE POINT OF THE RETURN VALUE. Every publish here is individually try/caught, so a
   * Redis blip produces a NORMAL return having enqueued nothing. Returning `void` made that
   * indistinguishable from a clean fan-out, and the caller retired the rows either way — leaving
   * no CANCEL enqueued, the rows gone from the live set, and nothing for reconciliation to see.
   */
  it('⚠⚠ reports a row as discharged ONLY when every one of its publishes was accepted', async () => {
    mockResolveRecipients.mockImplementation(({ party }: { party: string }) =>
      Promise.resolve(
        party === 'client'
          ? [
              { kind: 'user', userId: 'booker-1' },
              { kind: 'guest', guestId: 'guest-1' },
            ]
          : [{ kind: 'user', userId: 'expert-1' }]
      )
    );
    // The SECOND client-side publish is refused; the expert row's is accepted.
    mockPublish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue(undefined);

    const discharged = await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: 'ep-1',
        calendarEvents: [
          { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 },
          { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 0 },
        ],
      } as never,
      fakeLog()
    );

    expect(mockPublish).toHaveBeenCalledTimes(3);
    expect([...discharged]).toEqual(['row-expert']);
    expect(discharged.has('row-client')).toBe(false);
  });

  it('⚠ a row whose recipient READ failed is never discharged', async () => {
    mockResolveRecipients.mockRejectedValue(new Error('db down'));

    const discharged = await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: 'ep-1',
        calendarEvents: [{ id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 }],
      } as never,
      fakeLog()
    );

    expect(discharged.size).toBe(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  /**
   * ⚠ "NOBODY TO TELL" IS NOT "WE COULD NOT FIND OUT". A row with an empty recipient list is
   * fully discharged — there is no CANCEL owed — so holding it live would be a permanent stale
   * projection for no benefit.
   */
  it('⚠ a row with NOBODY to tell IS discharged', async () => {
    mockResolveRecipients.mockResolvedValue([]);

    const discharged = await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: 'ep-1',
        calendarEvents: [
          { id: 'row-expert', party: 'expert', deliveryMode: 'provider_event', sequence: 0 },
        ],
      } as never,
      fakeLog()
    );

    expect([...discharged]).toEqual(['row-expert']);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('every row discharged on a clean fan-out', async () => {
    mockResolveRecipients.mockResolvedValue([{ kind: 'user', userId: 'booker-1' }]);

    const discharged = await publishCancellationCalendarWithdrawals(
      {
        meetingId: MEETING_ID,
        cancelAuditId: 'audit-cancel-1',
        expertProfileId: 'ep-1',
        calendarEvents: [
          { id: 'row-client', party: 'client', deliveryMode: 'ics', sequence: 0 },
          { id: 'row-expert', party: 'expert', deliveryMode: 'ics', sequence: 0 },
        ],
      } as never,
      fakeLog()
    );

    expect([...discharged].sort((a, b) => a.localeCompare(b))).toEqual([
      'row-client',
      'row-expert',
    ]);
  });
});

describe('publishGuestRemovedCalendarWithdrawal', () => {
  /**
   * ⚠⚠ R2 — THE TEST THAT SATISFIES "the remaining party's behaviour on guest removal is decided,
   * documented, and covered". Exactly ONE publish, to the removed person, at the side's CURRENT
   * sequence. Nothing to the remaining party, nothing to the other side, no bump.
   */
  it('⚠ sends to the removed person and to NOBODY ELSE', async () => {
    const log = fakeLog();

    await publishGuestRemovedCalendarWithdrawal(
      {
        meetingId: MEETING_ID,
        party: 'client',
        guestId: 'guest-1',
        contextType: 'case',
        calendarEvent: { id: 'row-client', sequence: 5 },
      },
      log
    );

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'guest_removed:guest-1',
      calendarInvite: {
        meetingId: MEETING_ID,
        party: 'client',
        calendarEventId: 'row-client',
        method: 'CANCEL',
        transition: 'guest_removed',
        recipient: { kind: 'guest', guestId: 'guest-1' },
        contextType: 'case',
      },
    });
    // ⚠ NO recipient resolution at all — the removed guest is named directly, and the resolver
    // (which reads the LIVE guest index) could not find them anyway.
    expect(mockResolveRecipients).not.toHaveBeenCalled();
  });

  it('⚠ NEVER WRITES `sequence` — the mocked repository exposes no write method at all', async () => {
    await publishGuestRemovedCalendarWithdrawal(
      {
        meetingId: MEETING_ID,
        party: 'client',
        guestId: 'guest-1',
        contextType: 'case',
        calendarEvent: { id: 'row-client', sequence: 5 },
      },
      fakeLog()
    );
    const { meetingCalendarEventsRepository } = await import('@balo/db');
    expect(Object.keys(meetingCalendarEventsRepository)).toEqual(['listLiveByMeeting']);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠⚠ IT PERFORMS **NO READ OF ITS OWN**, AND THAT ABSENCE IS THE RACE FIX. It used to
   * `listLiveByMeeting` here — i.e. AFTER `removeGuest` had revoked, ejected and published — so a
   * cancellation landing in that window retired the party row, the read found nothing, and the
   * guest got a withdrawal from NEITHER path (the cancellation's own fan-out had already resolved
   * its recipients from the LIVE guest index, which no longer held them). The caller now
   * snapshots the row BEFORE the revoke and hands it in.
   */
  it('⚠⚠ reads NOTHING — the row is the caller pre-revoke snapshot', async () => {
    await publishGuestRemovedCalendarWithdrawal(
      {
        meetingId: MEETING_ID,
        party: 'client',
        guestId: 'guest-1',
        contextType: 'case',
        calendarEvent: { id: 'row-snapshot', sequence: 9 },
      },
      fakeLog()
    );

    expect(mockListLiveByMeeting).not.toHaveBeenCalled();
    expect(mockPublish).toHaveBeenCalledWith('meeting.calendar_invite', {
      correlationId: 'guest_removed:guest-1',
      calendarInvite: expect.objectContaining({ calendarEventId: 'row-snapshot' }),
    });
  });

  it('⚠ uses the SNAPSHOT sequence, not a re-read one — R2 bumps nothing', async () => {
    const log = fakeLog();

    await publishGuestRemovedCalendarWithdrawal(
      {
        meetingId: MEETING_ID,
        party: 'client',
        guestId: 'guest-1',
        contextType: 'case',
        calendarEvent: { id: 'row-client', sequence: 9 },
      },
      log
    );

    expect(lastEnqueuedFields(log).sequence).toBe(9);
  });
});
