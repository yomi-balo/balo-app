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
  NOTIFICATION_SERVER_EVENTS: {
    SMS_SENT: 'notification_sms_sent',
    SMS_FAILED: 'notification_sms_failed',
    SMS_SKIPPED: 'notification_sms_skipped',
  },
}));

vi.mock('../../lib/redis.js', () => ({
  createRedisConnection: vi.fn(),
}));

// Import after mocks are set up
import { processSmsJob } from './sms.adapter.js';

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
    });
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
});
