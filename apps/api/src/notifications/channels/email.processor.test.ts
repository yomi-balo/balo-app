import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DeliveryPayload } from './types.js';

// Mock dependencies
const { mockFindById, mockInsert, mockSendTransacEmail } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockInsert: vi.fn().mockResolvedValue({}),
  mockSendTransacEmail: vi.fn().mockResolvedValue({ messageId: 'brevo-msg-1' }),
}));

vi.mock('@balo/db', () => ({
  usersRepository: { findById: mockFindById },
  notificationLogRepository: { insert: mockInsert },
}));

vi.mock('@react-email/render', () => ({
  render: vi.fn().mockResolvedValue('<html>rendered</html>'),
}));

vi.mock('@getbrevo/brevo', () => ({
  BrevoClient: class {
    transactionalEmails = { sendTransacEmail: mockSendTransacEmail };
  },
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
import { processEmailJob } from './email.adapter.js';

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
        to: [{ email: 'noname@example.com', name: undefined }],
      })
    );
  });
});
