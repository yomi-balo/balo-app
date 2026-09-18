import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';

const {
  mockFindByIdUser,
  mockFindLiveByIdGuest,
  mockFindLiveByIdCalendarEvent,
  mockFindByIdMeeting,
  mockClaimSend,
  mockMarkSent,
  mockMarkFailed,
  mockLogNotification,
  mockGetEmailTemplate,
  mockRender,
  mockBuildIcs,
  mockResolveFacts,
  mockBuildMailOptions,
  mockCaptureException,
  mockCaptureMessage,
  mockResolveCalendarPartyMemberUserIds,
  mockDeliveringExpertProfileIdForMeeting,
  mockLogInfo,
} = vi.hoisted(() => ({
  mockFindByIdUser: vi.fn(),
  mockFindLiveByIdGuest: vi.fn(),
  mockFindLiveByIdCalendarEvent: vi.fn(),
  mockFindByIdMeeting: vi.fn(),
  mockClaimSend: vi.fn(),
  mockMarkSent: vi.fn(),
  mockMarkFailed: vi.fn(),
  mockLogNotification: vi.fn(),
  mockGetEmailTemplate: vi.fn(),
  mockRender: vi.fn(),
  mockBuildIcs: vi.fn(),
  mockResolveFacts: vi.fn(),
  mockBuildMailOptions: vi.fn(),
  mockCaptureException: vi.fn(),
  mockCaptureMessage: vi.fn(),
  mockResolveCalendarPartyMemberUserIds: vi.fn(),
  mockDeliveringExpertProfileIdForMeeting: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindByIdUser },
  meetingGuestsRepository: { findLiveById: mockFindLiveByIdGuest },
  meetingCalendarEventsRepository: { findLiveById: mockFindLiveByIdCalendarEvent },
  meetingsRepository: { findById: mockFindByIdMeeting },
  meetingCalendarDeliveriesRepository: {
    claimSend: mockClaimSend,
    markSent: mockMarkSent,
    markFailed: mockMarkFailed,
  },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ info: mockLogInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
}));
vi.mock('@react-email/render', () => ({ render: mockRender }));
vi.mock('./templates/index.js', () => ({ getEmailTemplate: mockGetEmailTemplate }));
vi.mock('./log.js', () => ({ logNotification: mockLogNotification }));
vi.mock('../../services/calendar-invites/build-calendar-invite-ics.js', () => ({
  buildCalendarInviteIcs: mockBuildIcs,
}));
vi.mock('../../services/calendar-invites/resolve-calendar-invite-facts.js', () => ({
  resolveCalendarInviteFacts: mockResolveFacts,
}));
// F23 (fix round 1, S3) — the send-time membership re-check for a user recipient.
vi.mock('../../services/calendar-invites/resolve-calendar-invite-recipients.js', () => ({
  resolveCalendarPartyMemberUserIds: mockResolveCalendarPartyMemberUserIds,
}));
vi.mock('../../services/meetings/delivering-party.js', () => ({
  deliveringExpertProfileIdForMeeting: mockDeliveringExpertProfileIdForMeeting,
}));
vi.mock('./calendar-invite-message.js', () => ({
  buildCalendarInviteMailOptions: mockBuildMailOptions,
}));

const { deliverCalendarInvite, describeSmtpFailure } =
  await import('./calendar-invite-delivery.js');

const MEETING_ID = 'meeting-1';
const ROW_ID = 'row-1';

const USER_SPEC = {
  meetingId: MEETING_ID,
  party: 'client' as const,
  calendarEventId: ROW_ID,
  method: 'REQUEST' as const,
  transition: 'booked' as const,
  recipient: { kind: 'user' as const, userId: 'user-1' },
  contextType: 'case' as const,
};

const GUEST_SPEC = {
  meetingId: MEETING_ID,
  party: 'client' as const,
  calendarEventId: ROW_ID,
  method: 'REQUEST' as const,
  transition: 'guest_added' as const,
  recipient: { kind: 'guest' as const, guestId: 'guest-1' },
  contextType: 'case' as const,
};

function makeJob(
  payload: Record<string, unknown>,
  opts: { id?: string; attemptsMade?: number; attempts?: number } = {}
): Job {
  return {
    id: opts.id ?? 'job-1',
    data: payload,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job;
}

const FAKE_TRANSPORT = {
  organizerAddress: 'no-reply@balo.test',
  send: vi.fn(),
};

const LIVE_ROW = {
  id: ROW_ID,
  meetingId: MEETING_ID,
  party: 'client',
  deliveryMode: 'ics',
  uid: 'uid-1',
  sequence: 2,
};

const LIVE_MEETING = {
  id: MEETING_ID,
  status: 'scheduled',
  scheduledStart: new Date('2026-09-01T04:00:00.000Z'),
  scheduledEnd: new Date('2026-09-01T04:30:00.000Z'),
};

const FACTS = {
  contextType: 'case',
  summary: 'Consultation with Northwind Industrial',
  description: 'CPQ rollout',
  location: 'https://balo.expert/meetings/meeting-1/call',
  memberJoinUrl: 'https://balo.expert/meetings/meeting-1/call',
};

beforeEach(() => {
  vi.clearAllMocks();
  FAKE_TRANSPORT.send.mockResolvedValue({ messageId: 'smtp-msg-1' });
  mockFindByIdUser.mockResolvedValue({
    id: 'user-1',
    email: 'user@example.test',
    firstName: 'Dana',
  });
  mockFindLiveByIdGuest.mockResolvedValue({
    id: 'guest-1',
    meetingId: MEETING_ID,
    party: 'client',
    admission: 'admitted',
    email: 'guest@example.test',
    name: 'Guest Person',
  });
  mockFindLiveByIdCalendarEvent.mockResolvedValue(LIVE_ROW);
  mockFindByIdMeeting.mockResolvedValue(LIVE_MEETING);
  mockClaimSend.mockResolvedValue({ status: 'claimed', delivery: { id: 'delivery-1' } });
  mockMarkSent.mockResolvedValue({ id: 'delivery-1' });
  mockMarkFailed.mockResolvedValue({ id: 'delivery-1' });
  mockLogNotification.mockResolvedValue(undefined);
  mockGetEmailTemplate.mockReturnValue({ component: 'component', subject: 'Calendar invite: X' });
  mockRender.mockResolvedValue('<html></html>');
  mockBuildIcs.mockReturnValue('BEGIN:VCALENDAR...');
  mockResolveFacts.mockResolvedValue(FACTS);
  mockBuildMailOptions.mockReturnValue({ from: {}, to: {}, subject: 'x' });
  mockDeliveringExpertProfileIdForMeeting.mockResolvedValue('expert-profile-1');
  // F23 — every existing fixture's user recipient ('user-1') passes the send-time membership
  // re-check by default; tests that need to exercise the skip override this per-case.
  mockResolveCalendarPartyMemberUserIds.mockResolvedValue(['user-1']);
});

describe('deliverCalendarInvite — happy path (user recipient)', () => {
  it('sends, marks sent, logs "sent", and never throws', async () => {
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await expect(deliverCalendarInvite(job, FAKE_TRANSPORT)).resolves.toBeUndefined();

    expect(FAKE_TRANSPORT.send).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).toHaveBeenCalledWith({
      id: 'delivery-1',
      claimToken: 'job-1',
      providerMessageId: 'smtp-msg-1',
    });
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'sent',
      undefined,
      expect.objectContaining({ smtpMessageId: 'smtp-msg-1', calendarEventId: ROW_ID })
    );
  });

  it('F5 (fix round 1, R4) — the "sent" outcome line carries a non-null contextType (from facts, resolved at step 6)', async () => {
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    const sentOutcomeCall = mockLogInfo.mock.calls.find(
      (call) => call[1] === 'Calendar invite delivery outcome' && call[0]?.outcome === 'sent'
    ) as [Record<string, unknown>, string] | undefined;
    expect(sentOutcomeCall).toBeDefined();
    expect(sentOutcomeCall?.[0]['contextType']).toBe(FACTS.contextType);
    expect(sentOutcomeCall?.[0]['contextType']).not.toBeNull();
  });

  it('the ICS handed to the transport uses row.uid and row.sequence (current, not publish-time)', async () => {
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: { ...USER_SPEC, calendarEventId: ROW_ID },
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(mockBuildIcs).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'uid-1', sequence: 2, recipientAddress: 'user@example.test' })
    );
  });

  it('resolves the recipient address via usersRepository, never carries it in the spec', async () => {
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(mockFindByIdUser).toHaveBeenCalledWith('user-1');
  });

  it('ordering: findLiveById (row) resolves before meetingsRepository.findById', async () => {
    const order: string[] = [];
    mockFindLiveByIdCalendarEvent.mockImplementation(async () => {
      order.push('row');
      return LIVE_ROW;
    });
    mockFindByIdMeeting.mockImplementation(async () => {
      order.push('meeting');
      return LIVE_MEETING;
    });
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(order).toEqual(['row', 'meeting']);
  });
});

describe('deliverCalendarInvite — F8(a) (fix round 1, R7) — real builder + real mail options end-to-end', () => {
  it('the ICS handed to transport.send has exactly one ATTENDEE (the resolved recipient); its @-bearing properties are exactly ORGANIZER + ATTENDEE; to/from are correct', async () => {
    const { buildCalendarInviteIcs } = await vi.importActual<
      typeof import('../../services/calendar-invites/build-calendar-invite-ics.js')
    >('../../services/calendar-invites/build-calendar-invite-ics.js');
    const { buildCalendarInviteMailOptions } = await vi.importActual<
      typeof import('./calendar-invite-message.js')
    >('./calendar-invite-message.js');
    const { unfoldIcs, icsAddressPropertyNames } =
      await import('../../test/fixtures/ics-assertions.js');
    mockBuildIcs.mockImplementation(buildCalendarInviteIcs);
    mockBuildMailOptions.mockImplementation(buildCalendarInviteMailOptions);

    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).toHaveBeenCalledTimes(1);
    const [sentOptions] = FAKE_TRANSPORT.send.mock.calls[0] as [
      { to: { address: string }; from: { address: string }; icalEvent: { content: string } },
    ];
    expect(sentOptions.to).toEqual({ name: 'Dana', address: 'user@example.test' });
    expect(sentOptions.from).toEqual({ name: 'Balo', address: FAKE_TRANSPORT.organizerAddress });

    const lines = unfoldIcs(sentOptions.icalEvent.content);
    const attendeeLines = lines.filter((line) => line.startsWith('ATTENDEE'));
    expect(attendeeLines).toHaveLength(1);
    expect(attendeeLines[0]).toContain('user@example.test');
    expect([...new Set(icsAddressPropertyNames(lines))].sort((a, b) => a.localeCompare(b))).toEqual(
      ['ATTENDEE', 'ORGANIZER']
    );
  });
});

describe('deliverCalendarInvite — F8(b) (fix round 1, R7) — admitted guest send', () => {
  it('builder gets the GUEST address, facts get audience "guest", logNotification carries recipientEmail, and the name is sanitized', async () => {
    mockFindLiveByIdGuest.mockResolvedValue({
      id: 'guest-1',
      meetingId: MEETING_ID,
      party: 'client',
      admission: 'admitted',
      email: 'guest@example.test',
      name: 'Jane Guest',
    });
    const job = makeJob({
      recipientId: 'x',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'guest_added:guest-1' },
      calendarInvite: GUEST_SPEC,
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(mockBuildIcs).toHaveBeenCalledWith(
      expect.objectContaining({ recipientAddress: 'guest@example.test' })
    );
    expect(mockResolveFacts).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'guest' }),
      expect.anything()
    );
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientEmail: 'guest@example.test' }),
      'email',
      'sent',
      undefined,
      expect.anything()
    );
    expect(mockGetEmailTemplate).toHaveBeenCalledWith(
      'meeting-calendar-invite',
      expect.objectContaining({ recipientName: 'Jane Guest', audience: 'guest' })
    );
  });
});

describe('deliverCalendarInvite — F8(c) (fix round 1, R7) — a genuine retry (first send fails, second succeeds)', () => {
  it('one job run twice: first send rejects (attemptsMade 0), second succeeds (attemptsMade 1) ⇒ one markFailed, one markSent, send called twice', async () => {
    FAKE_TRANSPORT.send
      .mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({ messageId: 'smtp-msg-2' });
    mockClaimSend
      .mockResolvedValueOnce({ status: 'claimed', delivery: { id: 'delivery-1' } })
      .mockResolvedValueOnce({ status: 'claimed', delivery: { id: 'delivery-1' } });

    const firstJob = makeJob(
      {
        recipientId: 'user-1',
        template: 'meeting-calendar-invite',
        event: 'meeting.calendar_invite',
        data: {},
        payload: { correlationId: 'corr-1' },
        calendarInvite: USER_SPEC,
      },
      { id: 'job-retry-1', attemptsMade: 0, attempts: 3 }
    );
    await expect(deliverCalendarInvite(firstJob, FAKE_TRANSPORT)).rejects.toThrow(
      'Calendar invite SMTP send failed'
    );

    const secondJob = makeJob(
      {
        recipientId: 'user-1',
        template: 'meeting-calendar-invite',
        event: 'meeting.calendar_invite',
        data: {},
        payload: { correlationId: 'corr-1' },
        calendarInvite: USER_SPEC,
      },
      { id: 'job-retry-1', attemptsMade: 1, attempts: 3 }
    );
    await expect(deliverCalendarInvite(secondJob, FAKE_TRANSPORT)).resolves.toBeUndefined();

    expect(FAKE_TRANSPORT.send).toHaveBeenCalledTimes(2);
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'smtp-msg-2' })
    );
  });
});

describe('deliverCalendarInvite — skip branches', () => {
  function jobFor(spec: unknown, extra: Record<string, unknown> = {}) {
    return makeJob({
      recipientId: 'x',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: spec,
      ...extra,
    });
  }

  it('a calendar-class message carrying attachments skips WITHOUT sending, and Sentry captures it', async () => {
    const job = jobFor(USER_SPEC, { attachments: [{ source: 'r2', key: 'k', filename: 'f' }] });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockClaimSend).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'calendar_class_with_attachments'
    );
  });

  it('SMTP unconfigured (transport undefined) skips without sending', async () => {
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, undefined);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'smtp_not_configured'
    );
  });

  it('a user recipient with no email skips no_address', async () => {
    mockFindByIdUser.mockResolvedValue({ id: 'user-1', email: null, firstName: 'Dana' });
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'no_address'
    );
  });

  it('a pending guest skips guest_not_admitted — transport.send NOT called, claimSend NOT called, no address in the notification_log call', async () => {
    mockFindLiveByIdGuest.mockResolvedValue({
      id: 'guest-1',
      meetingId: MEETING_ID,
      party: 'client',
      admission: 'pending',
      email: 'guest@example.test',
      name: null,
    });
    const job = jobFor(GUEST_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockClaimSend).not.toHaveBeenCalled();
    const [loggedPayload] = mockLogNotification.mock.calls[0] as [Record<string, unknown>];
    expect(JSON.stringify(loggedPayload)).not.toContain('guest@example.test');
  });

  it('a guest on the wrong party skips guest_not_admitted', async () => {
    mockFindLiveByIdGuest.mockResolvedValue({
      id: 'guest-1',
      meetingId: MEETING_ID,
      party: 'expert',
      admission: 'admitted',
      email: 'guest@example.test',
      name: null,
    });
    const job = jobFor(GUEST_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
  });

  it('a missing / soft-deleted calendar row skips calendar_event_not_live', async () => {
    mockFindLiveByIdCalendarEvent.mockResolvedValue(undefined);
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'calendar_event_not_live'
    );
  });

  it('a row for a different meeting/party skips calendar_event_not_live', async () => {
    mockFindLiveByIdCalendarEvent.mockResolvedValue({ ...LIVE_ROW, meetingId: 'other-meeting' });
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
  });

  it('expert member, row provider_event, skips provider_event_party (Ruling 1 re-checked)', async () => {
    mockFindLiveByIdCalendarEvent.mockResolvedValue({
      ...LIVE_ROW,
      party: 'expert',
      deliveryMode: 'provider_event',
    });
    const job = jobFor({ ...USER_SPEC, party: 'expert' });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'provider_event_party'
    );
  });

  it('missing meeting skips meeting_not_live', async () => {
    mockFindByIdMeeting.mockResolvedValue(undefined);
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
  });

  it('a cancelled meeting skips meeting_not_live', async () => {
    mockFindByIdMeeting.mockResolvedValue({ ...LIVE_MEETING, status: 'cancelled' });
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
  });

  it('F30 (fix round 1, tech follow-up) — an ended meeting also skips meeting_not_live', async () => {
    mockFindByIdMeeting.mockResolvedValue({ ...LIVE_MEETING, status: 'ended' });
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'meeting_not_live'
    );
  });

  it('F23 (fix round 1, S3) — a booker removed from the company between publish and send is skipped, no send, no claim', async () => {
    mockResolveCalendarPartyMemberUserIds.mockResolvedValue([]);
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockClaimSend).not.toHaveBeenCalled();
    expect(mockFindByIdUser).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'recipient_not_member'
    );
  });

  it('F23 — a well-formed userId that is neither the booker nor the delivering expert is skipped before any address is resolved', async () => {
    mockResolveCalendarPartyMemberUserIds.mockResolvedValue(['someone-else']);
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockFindByIdUser).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'recipient_not_member'
    );
  });

  it('undefined display facts skips no_display_facts', async () => {
    mockResolveFacts.mockResolvedValue(undefined);
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
  });

  // BAL-475 (follow-up, F32) — a THROWN facts read must reject `deliverCalendarInvite` (so
  // BullMQ retries), not resolve to a `no_display_facts` skip. Nothing may be claimed or sent.
  it('a facts resolver that THROWS rejects deliverCalendarInvite — no skip, no claim, no send', async () => {
    mockResolveFacts.mockRejectedValue(new Error('display facts read blew up'));
    const job = jobFor(USER_SPEC);

    await expect(deliverCalendarInvite(job, FAKE_TRANSPORT)).rejects.toThrow();

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockClaimSend).not.toHaveBeenCalled();
    expect(mockLogNotification).not.toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'no_display_facts'
    );
  });

  it('already_sent skips duplicate_suppressed — no send', async () => {
    mockClaimSend.mockResolvedValue({ status: 'already_sent', delivery: { id: 'delivery-1' } });
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
    expect(mockLogNotification).toHaveBeenCalledWith(
      expect.anything(),
      'email',
      'skipped',
      'duplicate_suppressed'
    );
  });

  it('in_flight skips in_flight_elsewhere — no send', async () => {
    mockClaimSend.mockResolvedValue({ status: 'in_flight', delivery: { id: 'delivery-1' } });
    const job = jobFor(USER_SPEC);

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).not.toHaveBeenCalled();
  });
});

describe('deliverCalendarInvite — SMTP failure, retry, and Sentry timing', () => {
  /**
   * F2 (fix round 1, R2/S1) — a realistic RCPT rejection message embedding the RECIPIENT'S
   * address, exactly the shape the security review's live probe against a fake SMTP server
   * produced. `rejects.toThrow('boom')` used to PIN the leak (the raw error was rethrown
   * verbatim); the rejection must now equal the sanitised class/code form and must NEVER
   * contain the fixture's message or an `@`.
   */
  const ADDRESS_LEAKING_ERROR = Object.assign(
    new Error(
      "Can't send mail - all recipients were rejected: 550 5.1.1 <guest@victim.test>: Recipient address rejected"
    ),
    { code: 'EENVELOPE', responseCode: 550 }
  );

  it('first attempt: SMTP throws ⇒ markFailed + rethrow (BullMQ retries), the rejection is SANITISED (F2)', async () => {
    FAKE_TRANSPORT.send.mockRejectedValueOnce(ADDRESS_LEAKING_ERROR);
    const job = makeJob(
      {
        recipientId: 'user-1',
        template: 'meeting-calendar-invite',
        event: 'meeting.calendar_invite',
        data: {},
        payload: { correlationId: 'corr-1' },
        calendarInvite: USER_SPEC,
      },
      { attemptsMade: 0, attempts: 3 }
    );

    let caught: unknown;
    try {
      await deliverCalendarInvite(job, FAKE_TRANSPORT);
      throw new Error('expected deliverCalendarInvite to reject');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe('Calendar invite SMTP send failed: Error:EENVELOPE:550');
    expect(message).not.toContain('@');
    expect(message).not.toContain('victim.test');
    expect(message).not.toContain(ADDRESS_LEAKING_ERROR.message);

    expect(mockMarkFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'delivery-1', claimToken: 'job-1' })
    );
    // Not the final attempt (attemptsMade=0, attempts=3) — no Sentry capture yet.
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('final attempt: SMTP throws ⇒ Sentry.captureException IS called with the SANITISED error only', async () => {
    FAKE_TRANSPORT.send.mockRejectedValueOnce(ADDRESS_LEAKING_ERROR);
    const job = makeJob(
      {
        recipientId: 'user-1',
        template: 'meeting-calendar-invite',
        event: 'meeting.calendar_invite',
        data: {},
        payload: { correlationId: 'corr-1' },
        calendarInvite: USER_SPEC,
      },
      { attemptsMade: 2, attempts: 3 }
    );

    let caught: unknown;
    try {
      await deliverCalendarInvite(job, FAKE_TRANSPORT);
      throw new Error('expected deliverCalendarInvite to reject');
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).not.toContain('victim.test');

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [capturedError] = mockCaptureException.mock.calls[0] as [Error];
    expect(capturedError.message).toBe('Calendar invite SMTP send failed: Error:EENVELOPE:550');
    expect(capturedError.message).not.toContain('@');
    expect(capturedError.message).not.toContain('victim.test');
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain('victim.test');
  });

  it('second run (re-claim) after a failed first run ⇒ one send', async () => {
    mockClaimSend.mockResolvedValueOnce({ status: 'claimed', delivery: { id: 'delivery-1' } });
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await deliverCalendarInvite(job, FAKE_TRANSPORT);

    expect(FAKE_TRANSPORT.send).toHaveBeenCalledTimes(1);
  });

  it('markSent throwing does NOT rethrow — the message is already out', async () => {
    mockMarkSent.mockRejectedValueOnce(new Error('db down'));
    const job = makeJob({
      recipientId: 'user-1',
      template: 'meeting-calendar-invite',
      event: 'meeting.calendar_invite',
      data: {},
      payload: { correlationId: 'corr-1' },
      calendarInvite: USER_SPEC,
    });

    await expect(deliverCalendarInvite(job, FAKE_TRANSPORT)).resolves.toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('describeSmtpFailure', () => {
  it('extracts name/code/responseCode/command and never includes the raw message', () => {
    const error = Object.assign(new Error('550 mailbox for recipient@example.com not found'), {
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO',
    });

    const described = describeSmtpFailure(error);

    expect(described).toEqual({
      name: 'Error',
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO',
    });
    expect(JSON.stringify(described)).not.toContain('recipient@example.com');
    expect(JSON.stringify(described)).not.toContain('mailbox');
  });

  it('a non-Error value degrades to a generic shape', () => {
    expect(describeSmtpFailure('plain string')).toEqual({
      name: 'UnknownError',
      code: null,
      responseCode: null,
      command: null,
    });
  });
});
