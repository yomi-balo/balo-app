import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DeliveryPayload } from './types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockFindById } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindById },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockSendTransacSms = vi.fn().mockResolvedValue({
  messageId: 12345,
});

vi.mock('@getbrevo/brevo', () => ({
  BrevoClient: class {
    transactionalSms = { sendTransacSms: mockSendTransacSms };
  },
}));

const mockLogNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('./log.js', () => ({
  logNotification: (...args: unknown[]) => mockLogNotification(...args),
}));

const mockGetSmsTemplate = vi.fn().mockReturnValue('Test SMS body');
vi.mock('./templates/sms-templates.js', () => ({
  getSmsTemplate: (...args: unknown[]) => mockGetSmsTemplate(...args),
}));

const mockTrackServer = vi.fn();
vi.mock('@balo/analytics/server', () => ({
  trackServer: (...args: unknown[]) => mockTrackServer(...args),
  CALL_NOW_SERVER_EVENTS: { SMS_SENT: 'call_sms_sent' },
  NOTIFICATION_SERVER_EVENTS: {
    SMS_SENT: 'notification_sms_sent',
    SMS_FAILED: 'notification_sms_failed',
    SMS_SKIPPED: 'notification_sms_skipped',
  },
}));

vi.mock('../../lib/redis.js', () => ({
  createRedisConnection: vi.fn(),
  getRedis: vi.fn(() => ({})),
}));

const mockCheckRateLimit = vi.fn();
vi.mock('../../lib/rate-limiter.js', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// Import after mocks are set up
import { processSmsJob, CLIENT_SMS_NOT_OPTED_IN } from './sms.adapter.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<DeliveryPayload> = {}): Job<DeliveryPayload> {
  return {
    data: {
      recipientId: 'user-1',
      template: 'booking-confirmed-sms',
      event: 'booking.confirmed',
      data: { expertName: 'Alice' },
      payload: { correlationId: 'corr-1' },
      ...overrides,
    },
  } as Job<DeliveryPayload>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('processSmsJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BREVO_API_KEY = 'test-key';
    delete process.env.BREVO_SMS_SENDER;
    mockFindById.mockResolvedValue({
      id: 'user-1',
      phone: '+61412345678',
      firstName: 'Alice',
      // Item 17 — the new structural guard. Every existing happy-path fixture in this file
      // must carry a verified phone or the guard added below skips every one of them.
      phoneVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      clientSmsOptedInAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 1, ttlSeconds: 3600 });
  });

  // -- Happy path ----------------------------------------------------------

  describe('happy path', () => {
    it('sends SMS when user has a valid phone number', async () => {
      await processSmsJob(makeJob());

      expect(mockSendTransacSms).toHaveBeenCalledWith({
        recipient: '+61412345678',
        sender: 'Balo',
        content: 'Test SMS body',
        type: 'transactional',
      });

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'sent',
        undefined,
        { brevoMessageId: 12345 }
      );

      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_sent', {
        template: 'booking-confirmed-sms',
        recipient_phone_masked: '****5678',
        distinct_id: 'user-1',
      });
    });

    it('uses BREVO_SMS_SENDER env var when set', async () => {
      process.env.BREVO_SMS_SENDER = 'BaloApp';

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'BaloApp' })
      );
    });

    it('passes merged data and payload to getSmsTemplate', async () => {
      const job = makeJob({
        template: 'booking-confirmed-sms',
        data: { expertName: 'Alice' },
        payload: { correlationId: 'corr-1', date: 'Mar 25' },
      });

      await processSmsJob(job);

      expect(mockGetSmsTemplate).toHaveBeenCalledWith('booking-confirmed-sms', {
        expertName: 'Alice',
        correlationId: 'corr-1',
        date: 'Mar 25',
      });
    });
  });

  // -- Client SMS consent (BAL-655) ----------------------------------------

  describe('client SMS consent gate', () => {
    const verifiedNoConsent = {
      id: 'user-1',
      phone: '+61412345678',
      phoneVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      clientSmsOptedInAt: null,
    };

    it('exports the skip reason as a literal', () => {
      expect(CLIENT_SMS_NOT_OPTED_IN).toBe('Client SMS not opted in');
    });

    it('skips a client-side job when the recipient has not opted in', async () => {
      mockFindById.mockResolvedValue(verifiedNoConsent);

      await processSmsJob(makeJob({ recipientSide: 'client' }));

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'Client SMS not opted in'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_skipped', {
        template: 'booking-confirmed-sms',
        skip_reason: 'Client SMS not opted in',
        distinct_id: 'user-1',
      });
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('treats a job with no recipientSide as client-side (fails closed)', async () => {
      mockFindById.mockResolvedValue(verifiedNoConsent);

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'Client SMS not opted in'
      );
    });

    it('sends an expert-side job without client consent', async () => {
      mockFindById.mockResolvedValue(verifiedNoConsent);

      await processSmsJob(makeJob({ recipientSide: 'expert' }));

      expect(mockSendTransacSms).toHaveBeenCalledOnce();
    });

    it('sends a client-side job once the recipient has opted in', async () => {
      await processSmsJob(makeJob({ recipientSide: 'client' }));

      expect(mockSendTransacSms).toHaveBeenCalledOnce();
    });

    it('still skips as Phone not verified when consent is set but the phone is unverified', async () => {
      mockFindById.mockResolvedValue({
        ...verifiedNoConsent,
        phoneVerifiedAt: null,
        clientSmsOptedInAt: new Date('2026-02-01T00:00:00.000Z'),
      });

      await processSmsJob(makeJob({ recipientSide: 'client' }));

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'Phone not verified'
      );
    });
  });

  // -- No-phone skip -------------------------------------------------------

  describe('no-phone skip', () => {
    it('skips when user has no phone number', async () => {
      mockFindById.mockResolvedValue({ id: 'user-1', phone: null });

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'No phone number'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_skipped', {
        template: 'booking-confirmed-sms',
        skip_reason: 'No phone number',
        distinct_id: 'user-1',
      });
    });

    it('skips when phone number is not E.164 format', async () => {
      mockFindById.mockResolvedValue({ id: 'user-1', phone: '0412345678' });

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'Invalid phone number format'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_skipped', {
        template: 'booking-confirmed-sms',
        skip_reason: 'Invalid phone number format',
        distinct_id: 'user-1',
      });
    });

    // Item 17 — the STRUCTURAL guard. "Has a phone ⇒ verified" previously rested entirely on
    // the convention that `usersRepository.setPhoneVerified` is the sole writer of
    // `users.phone`; this pins the guard directly rather than depending on that grep staying
    // true.
    it('skips when phone is present and E.164-valid but NOT verified', async () => {
      mockFindById.mockResolvedValue({
        id: 'user-1',
        phone: '+61412345678',
        phoneVerifiedAt: null,
      });

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'Phone not verified'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_skipped', {
        template: 'booking-confirmed-sms',
        skip_reason: 'Phone not verified',
        distinct_id: 'user-1',
      });
    });

    it('skips when user not found', async () => {
      mockFindById.mockResolvedValue(undefined);

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).not.toHaveBeenCalled();
      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'No phone number'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_skipped', {
        template: 'booking-confirmed-sms',
        skip_reason: 'No phone number',
        distinct_id: 'user-1',
      });
    });
  });

  // -- Rate limit ----------------------------------------------------------

  describe('rate limit', () => {
    it('skips SMS when rate limit is exceeded', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 6, ttlSeconds: 1500 });

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).not.toHaveBeenCalled();
    });

    it('fires SMS_SKIPPED PostHog event with rate limit skip reason', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 6, ttlSeconds: 1500 });

      await processSmsJob(makeJob());

      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_skipped', {
        template: 'booking-confirmed-sms',
        skip_reason: 'Rate limit exceeded',
        distinct_id: 'user-1',
      });
    });

    it('logs notification with skipped status on rate limit', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 6, ttlSeconds: 1500 });

      await processSmsJob(makeJob());

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'skipped',
        'Rate limit exceeded'
      );
    });

    it('does not throw when rate limited (graceful skip)', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false, current: 6, ttlSeconds: 1500 });

      await expect(processSmsJob(makeJob())).resolves.toBeUndefined();
    });

    it('does not check rate limit when user has no phone', async () => {
      mockFindById.mockResolvedValue({ id: 'user-1', phone: null });

      await processSmsJob(makeJob());

      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('does not check rate limit when phone is invalid E.164', async () => {
      mockFindById.mockResolvedValue({ id: 'user-1', phone: '0412345678' });

      await processSmsJob(makeJob());

      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    });

    it('sends SMS when under rate limit', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: true, current: 3, ttlSeconds: 2000 });

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).toHaveBeenCalled();
    });

    it('passes correct config to checkRateLimit', async () => {
      await processSmsJob(makeJob());

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(), // redis instance
        { keyPrefix: 'sms:rate', maxRequests: 5, windowSeconds: 3600 },
        'user-1'
      );
    });

    it('sends SMS when rate limit check fails (fail-open)', async () => {
      mockCheckRateLimit.mockRejectedValue(new Error('Connection refused'));

      await processSmsJob(makeJob());

      expect(mockSendTransacSms).toHaveBeenCalled();
    });
  });

  // -- Brevo failure + re-throw --------------------------------------------

  describe('Brevo failure', () => {
    it('re-throws error when Brevo API fails', async () => {
      mockSendTransacSms.mockRejectedValueOnce(new Error('SMS quota exceeded'));

      await expect(processSmsJob(makeJob())).rejects.toThrow('SMS quota exceeded');

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'failed',
        'SMS quota exceeded'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_failed', {
        template: 'booking-confirmed-sms',
        error_type: 'SMS quota exceeded',
        distinct_id: 'user-1',
      });
    });

    it('handles non-Error thrown values', async () => {
      mockSendTransacSms.mockRejectedValueOnce('Unknown error');

      await expect(processSmsJob(makeJob())).rejects.toBe('Unknown error');

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'sms',
        'failed',
        'Unknown error'
      );
      expect(mockTrackServer).toHaveBeenCalledWith('notification_sms_failed', {
        template: 'booking-confirmed-sms',
        error_type: 'Unknown error',
        distinct_id: 'user-1',
      });
    });
  });
  // -- BAL-652: Call now ring SMS ------------------------------------------

  describe('call.ringing SMS', () => {
    function ringJob(overrides: Partial<DeliveryPayload> = {}): Job<DeliveryPayload> {
      return makeJob({
        template: 'call-ringing-sms-expert',
        event: 'call.ringing',
        recipientSide: 'expert',
        payload: { correlationId: 'ring-1', ringId: 'ring-1', callerUserId: 'caller-1' },
        ...overrides,
      });
    }

    it('emits call_sms_sent for the caller, with the callee side as the audience', async () => {
      await processSmsJob(ringJob());

      expect(mockTrackServer).toHaveBeenCalledWith('call_sms_sent', {
        audience: 'expert',
        ring_id: 'ring-1',
        distinct_id: 'caller-1',
      });
    });

    it('audience is the client side for a client-side rule', async () => {
      await processSmsJob(
        ringJob({ template: 'call-ringing-sms-client', recipientSide: 'client' })
      );

      expect(mockTrackServer).toHaveBeenCalledWith(
        'call_sms_sent',
        expect.objectContaining({ audience: 'client' })
      );
    });

    it('emits nothing for a non-call SMS', async () => {
      await processSmsJob(makeJob());

      expect(mockTrackServer).not.toHaveBeenCalledWith('call_sms_sent', expect.anything());
    });

    it.each(['ringId', 'callerUserId'])('skips the emit when %s is not a string', async (key) => {
      await processSmsJob(
        ringJob({
          payload: {
            correlationId: 'ring-1',
            ringId: 'ring-1',
            callerUserId: 'caller-1',
            [key]: 7,
          },
        })
      );

      expect(mockTrackServer).not.toHaveBeenCalledWith('call_sms_sent', expect.anything());
    });

    it('emits nothing when the SMS is skipped', async () => {
      mockFindById.mockResolvedValue({ id: 'user-1', phone: null });

      await processSmsJob(ringJob());

      expect(mockTrackServer).not.toHaveBeenCalledWith('call_sms_sent', expect.anything());
    });

    it('never re-queues the send when the tracker throws', async () => {
      mockTrackServer.mockImplementation((event: string) => {
        if (event === 'call_sms_sent') throw new Error('posthog down');
      });

      await expect(processSmsJob(ringJob())).resolves.toBeUndefined();
      expect(mockSendTransacSms).toHaveBeenCalledOnce();
      mockTrackServer.mockReset();
    });

    it('does not touch the call-now SMS cap — it is consumed once, in startCallNow', async () => {
      await processSmsJob(ringJob());

      const prefixes = mockCheckRateLimit.mock.calls.map(
        (call) => (call[1] as { keyPrefix: string }).keyPrefix
      );
      expect(prefixes).not.toContain('ratelimit:call-now-sms');
    });
  });
});
