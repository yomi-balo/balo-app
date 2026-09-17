import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DeliveryPayload } from './types.js';

// Mock dependencies
const {
  mockFindById,
  mockInsert,
  mockSendTransacEmail,
  mockGetR2ObjectBytes,
  mockDeliverCalendarInvite,
  mockCreateTransport,
  mockCaptureException,
  mockCaptureMessage,
} = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockInsert: vi.fn().mockResolvedValue({}),
  mockSendTransacEmail: vi.fn().mockResolvedValue({ messageId: 'brevo-msg-1' }),
  mockGetR2ObjectBytes: vi.fn(),
  mockDeliverCalendarInvite: vi.fn().mockResolvedValue(undefined),
  mockCreateTransport: vi.fn(() => ({ sendMail: vi.fn() })),
  mockCaptureException: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
}));

vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindById },
  notificationLogRepository: { insert: mockInsert },
}));

vi.mock('../../lib/storage/r2.js', () => ({
  getR2ObjectBytes: mockGetR2ObjectBytes,
}));

vi.mock('@react-email/render', () => ({
  render: vi.fn().mockResolvedValue('<html>rendered</html>'),
}));

vi.mock('@getbrevo/brevo', () => ({
  BrevoClient: class {
    transactionalEmails = { sendTransacEmail: mockSendTransacEmail };
  },
}));

// BAL-475 — the SMTP path's two seams: the transport constructor (never called unless a
// calendar-class payload AND full env config are both present) and the delivery module itself.
vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}));
const { FakeCalendarInviteSendError } = vi.hoisted(() => {
  class HoistedFakeCalendarInviteSendError extends Error {
    readonly code: string | null = null;
    readonly responseCode: number | null = null;
    constructor(message: string) {
      super(message);
      this.name = 'CalendarInviteSendError';
      Object.setPrototypeOf(this, HoistedFakeCalendarInviteSendError.prototype);
    }
  }
  return { FakeCalendarInviteSendError: HoistedFakeCalendarInviteSendError };
});
vi.mock('./calendar-invite-delivery.js', () => ({
  deliverCalendarInvite: mockDeliverCalendarInvite,
  CalendarInviteSendError: FakeCalendarInviteSendError,
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Must use resetModules to clear the cached brevoClient between tests
import { processEmailJob, devEmailSendIsBlocked } from './email.adapter.js';

const SMTP_ENV_KEYS = [
  'BREVO_SMTP_USER',
  'BREVO_SMTP_PASS',
  'CALENDAR_INVITE_ORGANIZER_EMAIL',
  'BREVO_SMTP_HOST',
  'BREVO_SMTP_PORT',
] as const;
const originalSmtpEnv: Record<string, string | undefined> = {};

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function makeJob(data: DeliveryPayload): Job<DeliveryPayload> {
  return { data } as unknown as Job<DeliveryPayload>;
}

const basePayload: DeliveryPayload = {
  recipientId: 'user-1',
  template: 'welcome',
  event: 'user.welcome',
  data: {},
  payload: { correlationId: 'corr-1' },
};

describe('processEmailJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BREVO_API_KEY = 'test-key';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true'; // BAL-275: these nine cases exercise the SEND path
  });

  afterEach(() => {
    delete process.env.DEV_ALLOW_REAL_EMAIL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV; // the guard tests below mutate it
  });

  it('renders template, sends via Brevo, and logs success', async () => {
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    await processEmailJob(makeJob(basePayload));

    // Verifies user lookup
    expect(mockFindById).toHaveBeenCalledWith('user-1');

    // Verifies Brevo was called with rendered HTML
    expect(mockSendTransacEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        htmlContent: '<html>rendered</html>',
        subject: 'Welcome to Balo, Alice!',
        to: [{ email: 'alice@example.com', name: 'Alice' }],
      })
    );

    // Verifies notification log written as 'sent'
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sent',
        channel: 'email',
        template: 'welcome',
      })
    );
  });

  it('skips and logs when user has no email', async () => {
    mockFindById.mockResolvedValue({ id: 'user-1', email: null, firstName: 'Bob' });

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped',
        error: 'No email address',
      })
    );
  });

  it('skips and logs when user is not found', async () => {
    mockFindById.mockResolvedValue(undefined);

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('logs failure and re-throws when Brevo errors', async () => {
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });
    mockSendTransacEmail.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(processEmailJob(makeJob(basePayload))).rejects.toThrow('SMTP timeout');

    // Verifies failure was logged
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'SMTP timeout',
      })
    );
  });

  it('uses firstName fallback when not present', async () => {
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'noname@example.com',
      firstName: null,
    });

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ email: 'noname@example.com', name: 'there' }],
      })
    );
  });

  it('uses a literal recipientEmail (ops inbox) and bypasses the user lookup', async () => {
    const opsPayload: DeliveryPayload = {
      ...basePayload,
      recipientId: 'ops@balo.expert',
      recipientEmail: 'ops@balo.expert',
      template: 'project-match-requested',
    };

    await processEmailJob(makeJob(opsPayload));

    // No user lookup for a literal-email recipient.
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockSendTransacEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ email: 'ops@balo.expert', name: 'team' }],
      })
    );
  });

  // -- BAL-386 attachment path -----------------------------------------------

  const sharePayload: DeliveryPayload = {
    recipientId: 'share-link-1',
    recipientEmail: 'colleague@northwind.com',
    template: 'proposal-shared',
    event: 'proposal.shared',
    data: {},
    payload: {
      correlationId: 'share-link-1',
      sharerName: 'Dana Okafor',
      sharerOrgLabel: 'Acme Industrial',
      proposalTitle: 'CPQ implementation',
      expiresOn: '13 August 2026',
      shareToken: 'raw-token-abcdef0123456789',
    },
    attachments: [{ source: 'r2', key: 'proposals/p1/client.pdf', filename: 'proposal.pdf' }],
  };

  it('resolves an R2 attachment to base64 and passes Brevo attachment: [{ content, name }]', async () => {
    mockGetR2ObjectBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]));

    await processEmailJob(makeJob(sharePayload));

    expect(mockGetR2ObjectBytes).toHaveBeenCalledWith('proposals/p1/client.pdf');
    expect(mockSendTransacEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: [
          {
            content: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64'),
            name: 'proposal.pdf',
          },
        ],
      })
    );
  });

  it('throws (for BullMQ retry) when the R2 read misses, and does not send', async () => {
    mockGetR2ObjectBytes.mockRejectedValueOnce(new Error('NoSuchKey'));

    await expect(processEmailJob(makeJob(sharePayload))).rejects.toThrow('NoSuchKey');
    expect(mockSendTransacEmail).not.toHaveBeenCalled();
  });

  it('leaves the non-attachment path untouched (no R2 read, no attachment field)', async () => {
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    await processEmailJob(makeJob(basePayload));

    expect(mockGetR2ObjectBytes).not.toHaveBeenCalled();
    const sentArgs = mockSendTransacEmail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentArgs).not.toHaveProperty('attachment');
  });

  // -- BAL-275 (D6) dev email send guard ---------------------------------------

  it('blocks in non-production with no opt-in, and resolves without throwing', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_ALLOW_REAL_EMAIL;

    await expect(processEmailJob(makeJob(basePayload))).resolves.toBeUndefined();

    expect(mockSendTransacEmail).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped',
        error: 'Blocked outside production',
      })
    );
  });

  it('a non-"true" value still blocks', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = '1';

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).not.toHaveBeenCalled();
  });

  it('sends when opted in', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).toHaveBeenCalled();
  });

  it('⚠ is inert in production — sends with the flag unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DEV_ALLOW_REAL_EMAIL;
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).toHaveBeenCalled();
  });

  it('⚠ is inert in production — a stray "false" does not block', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_ALLOW_REAL_EMAIL = 'false';
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    await processEmailJob(makeJob(basePayload));

    expect(mockSendTransacEmail).toHaveBeenCalled();
  });
});

describe('devEmailSendIsBlocked', () => {
  afterEach(() => {
    delete process.env.DEV_ALLOW_REAL_EMAIL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('returns false in production regardless of DEV_ALLOW_REAL_EMAIL', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DEV_ALLOW_REAL_EMAIL;
    expect(devEmailSendIsBlocked()).toBe(false);

    process.env.DEV_ALLOW_REAL_EMAIL = 'false';
    expect(devEmailSendIsBlocked()).toBe(false);
  });

  it('returns true outside production unless DEV_ALLOW_REAL_EMAIL is exactly "true"', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_ALLOW_REAL_EMAIL;
    expect(devEmailSendIsBlocked()).toBe(true);

    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    expect(devEmailSendIsBlocked()).toBe(false);
  });
});

/** BAL-475 — a minimal calendar-class payload; only the branch-selection fields matter here. */
const calendarPayload: DeliveryPayload = {
  recipientId: 'user-1',
  template: 'meeting-calendar-invite',
  event: 'meeting.calendar_invite',
  data: {},
  payload: { correlationId: 'corr-1' },
  calendarInvite: {
    meetingId: 'meeting-1',
    party: 'client',
    calendarEventId: 'row-1',
    method: 'REQUEST',
    transition: 'booked',
    recipient: { kind: 'user', userId: 'user-1' },
    contextType: 'case',
  },
};

describe('processEmailJob — BAL-475 calendar-class branch selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of SMTP_ENV_KEYS) {
      originalSmtpEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    delete process.env.DEV_ALLOW_REAL_EMAIL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    for (const key of SMTP_ENV_KEYS) {
      if (originalSmtpEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalSmtpEnv[key];
    }
  });

  it('DEV_ALLOW_REAL_EMAIL unset outside production ⇒ deliverCalendarInvite NOT called, createTransport NOT called, skipped log', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_ALLOW_REAL_EMAIL;

    await processEmailJob(makeJob(calendarPayload));

    expect(mockDeliverCalendarInvite).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', error: 'Blocked outside production' })
    );
  });

  it('F3 (fix round 1, S2/S14/R18) — opted in with ALL FIVE SMTP vars set (incl. host/port) ⇒ a DEFINED transport, and createTransport receives the hardened TLS/timeout/logging options for port 587', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    process.env.BREVO_SMTP_USER = 'smtp-user';
    process.env.BREVO_SMTP_PASS = 'smtp-pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_HOST = 'smtp-relay.brevo.com';
    process.env.BREVO_SMTP_PORT = '587';

    await processEmailJob(makeJob(calendarPayload));

    expect(mockDeliverCalendarInvite).toHaveBeenCalledTimes(1);
    const [, transport] = mockDeliverCalendarInvite.mock.calls[0] as [unknown, unknown];
    expect(transport).toBeDefined();

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
        requireTLS: true,
        tls: expect.objectContaining({ minVersion: 'TLSv1.2' }),
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
        socketTimeout: 30_000,
      })
    );
  });

  it('F3 — port 465 (implicit TLS) sets secure: true and still floors minVersion, without necessarily requiring requireTLS', async () => {
    // The SMTP transport is a module-level singleton (`calendarSmtpTransport`), cached after
    // the first successful build — a SECOND config in the SAME module instance would silently
    // reuse the port-587 transporter and never re-invoke `createTransport`. `resetModules` +
    // a dynamic re-import gives this one test its own fresh module instance.
    vi.resetModules();
    const fresh = await import('./email.adapter.js');

    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    process.env.BREVO_SMTP_USER = 'smtp-user';
    process.env.BREVO_SMTP_PASS = 'smtp-pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_PORT = '465';

    await fresh.processEmailJob(makeJob(calendarPayload));

    expect(mockCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 465,
        secure: true,
        tls: expect.objectContaining({ minVersion: 'TLSv1.2' }),
      })
    );
  });

  it('opted in + SMTP vars UNSET ⇒ deliverCalendarInvite is called with transport undefined', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';

    await processEmailJob(makeJob(calendarPayload));

    expect(mockDeliverCalendarInvite).toHaveBeenCalledTimes(1);
    const [, transport] = mockDeliverCalendarInvite.mock.calls[0] as [unknown, unknown];
    expect(transport).toBeUndefined();
  });

  it('a standard (non-calendar) payload never reaches deliverCalendarInvite — the Brevo path is unchanged', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    await processEmailJob(makeJob(basePayload));

    expect(mockDeliverCalendarInvite).not.toHaveBeenCalled();
    expect(mockSendTransacEmail).toHaveBeenCalled();
  });

  it('F25 (fix round 1, S12) — a calendarInvite payload on a NON-calendar event never reaches SMTP; logged as a mismatch, no transport built', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    process.env.BREVO_SMTP_USER = 'smtp-user';
    process.env.BREVO_SMTP_PASS = 'smtp-pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';

    await processEmailJob(makeJob({ ...calendarPayload, event: 'meeting.guest_added' }));

    expect(mockDeliverCalendarInvite).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', error: 'calendar_invite_event_mismatch' })
    );
  });

  it('F14 (fix round 1, R13) — a non-send failure (e.g. a transient repository read) is sanitised and captured to Sentry only on the FINAL attempt', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    mockDeliverCalendarInvite.mockRejectedValueOnce(new Error('connection reset by peer'));
    const job = {
      data: calendarPayload,
      id: 'job-1',
      attemptsMade: 2,
      opts: { attempts: 3 },
    } as unknown as Job<DeliveryPayload>;

    let caught: unknown;
    try {
      await processEmailJob(job);
      throw new Error('expected processEmailJob to reject');
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).not.toContain('connection reset by peer');
    expect(mockCaptureException).toHaveBeenCalled();
    const [capturedError] = mockCaptureException.mock.calls.at(-1) as [Error];
    expect(capturedError.message).not.toContain('connection reset by peer');
  });

  it('F14 — the SAME non-send failure on a NON-final attempt rethrows sanitised but does NOT capture to Sentry', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    mockDeliverCalendarInvite.mockRejectedValueOnce(new Error('connection reset by peer'));
    const job = {
      data: calendarPayload,
      id: 'job-1',
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<DeliveryPayload>;

    await expect(processEmailJob(job)).rejects.toThrow();

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('F14 — a CalendarInviteSendError from deliverCalendarInvite passes through UNCHANGED (already sanitised + already captured inside deliverCalendarInvite)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_ALLOW_REAL_EMAIL = 'true';
    const sendError = new FakeCalendarInviteSendError(
      'Calendar invite SMTP send failed: Error:EENVELOPE:550'
    );
    mockDeliverCalendarInvite.mockRejectedValueOnce(sendError);

    await expect(processEmailJob(makeJob(calendarPayload))).rejects.toBe(sendError);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
