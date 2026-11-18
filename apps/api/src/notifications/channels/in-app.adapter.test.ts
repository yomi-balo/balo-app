import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DeliveryPayload } from './types.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockInsert } = vi.hoisted(() => ({
  mockInsert: vi.fn().mockResolvedValue({ id: 'notif-1' }),
}));

vi.mock('@balo/db', () => ({
  userNotificationsRepository: { insert: mockInsert },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockLogNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('./log.js', () => ({
  logNotification: (...args: unknown[]) => mockLogNotification(...args),
}));

const mockGetInAppTemplate = vi.fn().mockReturnValue({
  title: 'New booking',
  body: 'Alice booked a consultation',
  actionUrl: '/cases/case-1',
});
vi.mock('./templates/in-app-templates.js', () => ({
  getInAppTemplate: (...args: unknown[]) => mockGetInAppTemplate(...args),
}));

const mockTrackServer = vi.fn();
vi.mock('@balo/analytics/server', () => ({
  trackServer: (...args: unknown[]) => mockTrackServer(...args),
  NOTIFICATION_SERVER_EVENTS: {
    IN_APP_SENT: 'notification_in_app_sent',
    IN_APP_FAILED: 'notification_in_app_failed',
  },
}));

vi.mock('../../lib/redis.js', () => ({
  createRedisConnection: vi.fn(),
}));

const mockPublishNotificationCreated = vi.fn().mockResolvedValue(undefined);
vi.mock('./in-app-push.js', () => ({
  publishNotificationCreated: (...args: unknown[]) => mockPublishNotificationCreated(...args),
}));

// Import after mocks are set up
import { processInAppJob } from './in-app.adapter.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<DeliveryPayload> = {}): Job<DeliveryPayload> {
  return {
    data: {
      recipientId: 'user-1',
      template: 'booking-confirmed',
      event: 'booking.confirmed',
      data: { clientName: 'Alice' },
      payload: { correlationId: 'corr-1', caseId: 'case-1' },
      ...overrides,
    },
  } as Job<DeliveryPayload>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('processInAppJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Happy path ----------------------------------------------------------

  describe('happy path', () => {
    it('inserts notification and logs delivery', async () => {
      await processInAppJob(makeJob());

      expect(mockGetInAppTemplate).toHaveBeenCalledWith('booking-confirmed', {
        clientName: 'Alice',
        correlationId: 'corr-1',
        caseId: 'case-1',
      });

      expect(mockInsert).toHaveBeenCalledWith({
        userId: 'user-1',
        event: 'booking.confirmed',
        title: 'New booking',
        body: 'Alice booked a consultation',
        actionUrl: '/cases/case-1',
        metadata: {
          correlationId: 'corr-1',
          template: 'booking-confirmed',
        },
      });

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'in-app',
        'sent'
      );

      expect(mockTrackServer).toHaveBeenCalledWith('notification_in_app_sent', {
        template: 'booking-confirmed',
        event: 'booking.confirmed',
        distinct_id: 'user-1',
      });
    });

    it('handles template with no actionUrl', async () => {
      mockGetInAppTemplate.mockReturnValueOnce({
        title: 'Notification',
        body: 'You have a new notification',
        actionUrl: undefined,
      });

      await processInAppJob(makeJob());

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ actionUrl: null }));
    });

    it('handles template with no body', async () => {
      mockGetInAppTemplate.mockReturnValueOnce({
        title: 'Notification',
        body: undefined,
        actionUrl: undefined,
      });

      await processInAppJob(makeJob());

      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ body: null, actionUrl: null })
      );
    });
  });

  // -- Realtime ping --------------------------------------------------------

  describe('realtime ping', () => {
    it('pings the recipient once, after the row and its log are written', async () => {
      await processInAppJob(makeJob());

      expect(mockPublishNotificationCreated).toHaveBeenCalledTimes(1);
      expect(mockPublishNotificationCreated).toHaveBeenCalledWith('user-1');

      const [insertOrder] = mockInsert.mock.invocationCallOrder;
      const [logOrder] = mockLogNotification.mock.invocationCallOrder;
      const [pingOrder] = mockPublishNotificationCreated.mock.invocationCallOrder;
      expect(pingOrder).toBeGreaterThan(insertOrder as number);
      expect(pingOrder).toBeGreaterThan(logOrder as number);
    });

    it('does not ping when the insert fails, and the job still rethrows', async () => {
      mockInsert.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(processInAppJob(makeJob())).rejects.toThrow('Connection refused');

      expect(mockPublishNotificationCreated).not.toHaveBeenCalled();
    });

    it('does not ping when writing the delivery log fails', async () => {
      mockLogNotification.mockRejectedValueOnce(new Error('log write failed'));

      await expect(processInAppJob(makeJob())).rejects.toThrow('log write failed');

      expect(mockPublishNotificationCreated).not.toHaveBeenCalled();
    });

    it('never writes a second row or a failed log when the ping rejects', async () => {
      mockPublishNotificationCreated.mockRejectedValueOnce(new Error('ably down'));

      // The real publisher never rejects; this pins what the adapter does if one ever did:
      // the job still resolves and, the row being durable, nothing is written twice.
      await expect(processInAppJob(makeJob())).resolves.toBeUndefined();

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockLogNotification).not.toHaveBeenCalledWith(
        expect.anything(),
        'in-app',
        'failed',
        expect.anything()
      );
    });
  });

  // -- Insert failure + re-throw ------------------------------------------

  describe('insert failure', () => {
    it('re-throws error when DB insert fails', async () => {
      mockInsert.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(processInAppJob(makeJob())).rejects.toThrow('Connection refused');

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'in-app',
        'failed',
        'Connection refused'
      );

      expect(mockTrackServer).toHaveBeenCalledWith('notification_in_app_failed', {
        template: 'booking-confirmed',
        event: 'booking.confirmed',
        error_type: 'Connection refused',
        distinct_id: 'user-1',
      });
    });

    it('handles non-Error thrown values', async () => {
      mockInsert.mockRejectedValueOnce('Unknown error');

      await expect(processInAppJob(makeJob())).rejects.toBe('Unknown error');

      expect(mockLogNotification).toHaveBeenCalledWith(
        expect.objectContaining({ recipientId: 'user-1' }),
        'in-app',
        'failed',
        'Unknown error'
      );

      expect(mockTrackServer).toHaveBeenCalledWith('notification_in_app_failed', {
        template: 'booking-confirmed',
        event: 'booking.confirmed',
        error_type: 'Unknown error',
        distinct_id: 'user-1',
      });
    });
  });
});
