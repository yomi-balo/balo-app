import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { DeliveryPayload } from './types.js';

// Mock dependencies
const { mockFindById, mockInsert, mockSendTransacEmail, mockGetR2ObjectBytes } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockInsert: vi.fn().mockResolvedValue({}),
  mockSendTransacEmail: vi.fn().mockResolvedValue({ messageId: 'brevo-msg-1' }),
  mockGetR2ObjectBytes: vi.fn(),
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
});
