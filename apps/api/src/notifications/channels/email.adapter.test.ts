import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEmailTemplate } from './templates/index.js';
import { logNotification } from './log.js';

// -- Test getEmailTemplate --------------------------------------------------

describe('getEmailTemplate', () => {
  it('returns welcome template with correct subject', () => {
    const result = getEmailTemplate('welcome', { recipientName: 'Alice' });
    expect(result.subject).toBe('Welcome to Balo');
    expect(result.component).toBeDefined();
  });

  it('returns application-submitted template with correct subject', () => {
    const result = getEmailTemplate('application-submitted', {
      recipientName: 'Bob',
    });
    expect(result.subject).toBe('We received your application');
    expect(result.component).toBeDefined();
  });

  it('falls back to "there" when recipientName is missing', () => {
    const result = getEmailTemplate('welcome', {});
    expect(result.subject).toBe('Welcome to Balo');
    expect(result.component).toBeDefined();
  });

  it('throws for unknown template', () => {
    expect(() => getEmailTemplate('nonexistent', {})).toThrow(
      'Unknown email template: nonexistent'
    );
  });
});

// -- Test logNotification ----------------------------------------------------

const mockInsert = vi.fn().mockResolvedValue({});

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => () => ({
    notificationLogRepository: { insert: mockInsert },
  })),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('logNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a notification log record with correct fields', async () => {
    await logNotification(
      {
        recipientId: 'user-1',
        template: 'welcome',
        event: 'user.welcome',
        data: {},
        payload: { correlationId: 'corr-1' },
      },
      'email',
      'sent',
      undefined,
      { brevoMessageId: 'msg-123' }
    );

    expect(mockInsert).toHaveBeenCalledWith({
      event: 'user.welcome',
      correlationId: 'corr-1',
      recipientId: 'user-1',
      channel: 'email',
      template: 'welcome',
      status: 'sent',
      error: null,
      metadata: { brevoMessageId: 'msg-123' },
    });
  });

  it('logs failed status with error message', async () => {
    await logNotification(
      {
        recipientId: 'user-2',
        template: 'welcome',
        event: 'user.welcome',
        data: {},
        payload: { correlationId: 'corr-2' },
      },
      'email',
      'failed',
      'SMTP error: connection refused'
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'SMTP error: connection refused',
        metadata: null,
      })
    );
  });

  it('does not throw when repository insert fails', async () => {
    mockInsert.mockRejectedValueOnce(new Error('DB connection lost'));

    // Should not throw -- errors are caught and logged internally
    await expect(
      logNotification(
        {
          recipientId: 'user-3',
          template: 'welcome',
          event: 'user.welcome',
          data: {},
          payload: { correlationId: 'corr-3' },
        },
        'email',
        'sent'
      )
    ).resolves.toBeUndefined();
  });
});
