import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPublish, mockFindByEmail, mockLog } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockFindByEmail: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('@balo/db', () => ({
  usersRepository: { findByEmail: mockFindByEmail },
}));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

import {
  publishBillingEmailChanged,
  type BillingEmailChangedNotice,
} from './billing-email-notify.js';

function notice(overrides: Partial<BillingEmailChangedNotice> = {}): BillingEmailChangedNotice {
  return {
    companyId: 'company_1',
    newEmail: 'new@northwind.test',
    previousEmail: 'old@northwind.test',
    changedByUserId: 'user_1',
    dedupKey: 'audit_1',
    ...overrides,
  };
}

/** The one shape the publisher reads back out of the repository — existence is all it needs. */
const PREVIOUS_USER = { id: 'user_2', email: 'old@northwind.test' };

function publishedPayload(): Record<string, unknown> {
  const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
  return payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  mockFindByEmail.mockResolvedValue(PREVIOUS_USER);
});

describe('publishBillingEmailChanged', () => {
  it('publishes billing.email_changed with a correlationId of ZERO colons', async () => {
    await publishBillingEmailChanged(
      notice({ companyId: 'company_9', dedupKey: '3fae9c1a-6b1e-4b7e-9c1a-6b1e4b7e9c1a' })
    );

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('billing.email_changed');

    const correlationId = publishedPayload().correlationId as string;
    expect(correlationId).toBe(
      'billing-email-changed.company_9.3fae9c1a-6b1e-4b7e-9c1a-6b1e4b7e9c1a'
    );
    // ⚠ `.`-JOINED, NEVER `:`-JOINED. `engine/dispatcher.ts` builds the per-CHANNEL BullMQ jobId
    // from the RAW correlationId with no escape, and BullMQ accepts a jobId whose colon count is
    // 0 or exactly 2 — a 3-colon id makes every channel job silently fail to enqueue, so the
    // notice is never delivered while everything upstream reports success.
    expect((correlationId.match(/:/g) ?? []).length).toBe(0);
  });

  it('includes BOTH previousEmail and recipientEmail when the previous address belongs to a user', async () => {
    await publishBillingEmailChanged(notice());

    expect(mockFindByEmail).toHaveBeenCalledWith('old@northwind.test');
    expect(publishedPayload()).toMatchObject({
      companyId: 'company_1',
      newEmail: 'new@northwind.test',
      changedByUserId: 'user_1',
      previousEmail: 'old@northwind.test',
      recipientEmail: 'old@northwind.test',
    });
  });

  it('omits BOTH keys on a first-ever set (no previous address) — and never looks a user up', async () => {
    await publishBillingEmailChanged(notice({ previousEmail: null }));

    expect(mockFindByEmail).not.toHaveBeenCalled();
    const payload = publishedPayload();
    expect('previousEmail' in payload).toBe(false);
    expect('recipientEmail' in payload).toBe(false);
  });

  it('omits BOTH keys when the previous address belongs to NO user — an arbitrary typed string is never mailed', async () => {
    mockFindByEmail.mockResolvedValue(undefined);

    await publishBillingEmailChanged(notice({ previousEmail: 'victim@example.test' }));

    expect(mockFindByEmail).toHaveBeenCalledWith('victim@example.test');
    const payload = publishedPayload();
    expect('previousEmail' in payload).toBe(false);
    expect('recipientEmail' in payload).toBe(false);
    // The rest of the notice still goes out — the change itself is real and worth announcing.
    expect(payload).toMatchObject({ companyId: 'company_1', newEmail: 'new@northwind.test' });
  });

  it('FAILS CLOSED — a lookup fault omits both keys rather than mailing on an unproven address', async () => {
    mockFindByEmail.mockRejectedValue(new Error('db down'));

    await publishBillingEmailChanged(notice());

    const payload = publishedPayload();
    expect('previousEmail' in payload).toBe(false);
    expect('recipientEmail' in payload).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
  });

  it('names the actor key changedByUserId, NEVER userId', async () => {
    await publishBillingEmailChanged(notice());

    const payload = publishedPayload();
    expect(payload.changedByUserId).toBe('user_1');
    // ⚠ `userId` would trigger BOTH the generic data.user hydration and the `self` recipient
    // path, mailing the actor separately on top of the billing fan-out.
    expect('userId' in payload).toBe(false);
  });

  it('NEVER throws when the queue publish fails — logs and swallows (best-effort)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue down'));

    await expect(publishBillingEmailChanged(notice())).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});
