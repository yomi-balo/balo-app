import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────
const { mockInsert } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  notificationLogRepository: { insert: mockInsert },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { logNotification } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({});
});

/**
 * BAL-341 / ADR-1047 Decision 8 — THE THREE DELIVERY SHAPES.
 *
 * These assertions are the ONLY thing standing between the exactly-one CHECK and a silent
 * failure: `logNotification` swallows deliberately (a best-effort audit write must never
 * fail a send), so a row that sets both or neither recipient column trips
 * `notification_log_recipient_exactly_one` INVISIBLY. Hence exact-argument assertions, not
 * `objectContaining` — a stray extra column is exactly the bug.
 */
describe('logNotification — the three recipient shapes (BAL-341)', () => {
  it('ORDINARY USER: recipient_id set, recipient_email NULL', async () => {
    await logNotification(
      {
        recipientId: '11111111-1111-1111-1111-111111111111',
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
      recipientId: '11111111-1111-1111-1111-111111111111',
      recipientEmail: null,
      channel: 'email',
      template: 'welcome',
      status: 'sent',
      error: null,
      metadata: { brevoMessageId: 'msg-123' },
    });
  });

  it('OPS INBOX: the literal address lands in recipient_email, recipient_id NULL', async () => {
    // `dispatcher.ts` sets BOTH fields to OPS_NOTIFICATION_EMAIL for the admin+email path.
    // Before BAL-341 that bare string went into a `uuid NOT NULL` column → 22P02, swallowed:
    // there was NO record that Balo's own ops inbox had ever been emailed.
    await logNotification(
      {
        recipientId: 'ops@balo.expert',
        recipientEmail: 'ops@balo.expert',
        template: 'project-match-requested',
        event: 'project.match_requested',
        data: {},
        payload: { correlationId: 'req-1' },
      },
      'email',
      'sent'
    );

    expect(mockInsert).toHaveBeenCalledWith({
      event: 'project.match_requested',
      correlationId: 'req-1',
      recipientId: null,
      recipientEmail: 'ops@balo.expert',
      channel: 'email',
      template: 'project-match-requested',
      status: 'sent',
      error: null,
      metadata: null,
    });
  });

  it('EXTERNAL INVITEE: recipient_email set, and the invite uuid survives as correlation_id', async () => {
    // The invite-row uuid is a valid uuid that is not a `users.id` → 23503, swallowed.
    // Dropping it from `recipient_id` loses nothing: `dispatchExternalEmail` passes that
    // same uuid as the correlationId, which is where it is still readable.
    const inviteId = '22222222-2222-2222-2222-222222222222';

    await logNotification(
      {
        recipientId: inviteId,
        recipientEmail: 'invitee@example.com',
        template: 'expert-referral-invited',
        event: 'expert.referral_invited',
        data: {},
        payload: { correlationId: inviteId },
      },
      'email',
      'sent'
    );

    expect(mockInsert).toHaveBeenCalledWith({
      event: 'expert.referral_invited',
      correlationId: inviteId,
      recipientId: null,
      recipientEmail: 'invitee@example.com',
      channel: 'email',
      template: 'expert-referral-invited',
      status: 'sent',
      error: null,
      metadata: null,
    });
  });

  it('an EMPTY recipientEmail falls back to the user shape rather than writing both as NULL', async () => {
    // Neither-set is a CHECK violation too, so a blank literal address must not be treated
    // as "a literal address is present".
    await logNotification(
      {
        recipientId: '33333333-3333-3333-3333-333333333333',
        recipientEmail: '',
        template: 'welcome',
        event: 'user.welcome',
        data: {},
        payload: { correlationId: 'corr-2' },
      },
      'in-app',
      'sent'
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: '33333333-3333-3333-3333-333333333333',
        recipientEmail: null,
      })
    );
  });
});

describe('logNotification — status and error passthrough', () => {
  it('records a failed status with its error message and null metadata', async () => {
    await logNotification(
      {
        recipientId: '44444444-4444-4444-4444-444444444444',
        template: 'welcome',
        event: 'user.welcome',
        data: {},
        payload: { correlationId: 'corr-3' },
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

  it('carries a composite correlationId through unchanged (the text widening)', async () => {
    await logNotification(
      {
        recipientId: '55555555-5555-5555-5555-555555555555',
        template: 'session-settled',
        event: 'session.settled',
        data: {},
        payload: { correlationId: 'session-1:settled' },
      },
      'email',
      'sent'
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'session-1:settled' })
    );
  });
});

describe('logNotification — the swallowing catch is preserved', () => {
  it('does not throw when the repository insert fails', async () => {
    mockInsert.mockRejectedValueOnce(new Error('DB connection lost'));

    // The contrast with `scheduledNotificationsRepository.claim` is the point: THIS write is
    // best-effort audit and must never fail a send; THAT one is the send-once guarantee and
    // has no catch anywhere on its path.
    await expect(
      logNotification(
        {
          recipientId: '66666666-6666-6666-6666-666666666666',
          template: 'welcome',
          event: 'user.welcome',
          data: {},
          payload: { correlationId: 'corr-4' },
        },
        'email',
        'sent'
      )
    ).resolves.toBeUndefined();
  });

  it('swallows a CHECK violation too — the accepted, tested-around cost of ADR R10', async () => {
    mockInsert.mockRejectedValueOnce(
      new Error('new row violates check constraint "notification_log_recipient_exactly_one"')
    );

    await expect(
      logNotification(
        {
          recipientId: '77777777-7777-7777-7777-777777777777',
          template: 'welcome',
          event: 'user.welcome',
          data: {},
          payload: { correlationId: 'corr-5' },
        },
        'email',
        'sent'
      )
    ).resolves.toBeUndefined();
  });
});
