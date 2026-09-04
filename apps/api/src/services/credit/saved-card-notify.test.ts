import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPublish, mockLog } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockLog: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLog }));
vi.mock('../../notifications/publisher.js', () => ({
  notificationEvents: { publish: mockPublish },
}));

import { publishSavedCardDetached, type SavedCardDetachedNotice } from './saved-card-notify.js';

function notice(overrides: Partial<SavedCardDetachedNotice> = {}): SavedCardDetachedNotice {
  return {
    walletId: 'wallet_1',
    companyId: 'company_1',
    source: 'stripe_webhook',
    modeReconciled: false,
    previousLowBalanceMode: 'notify_only',
    cardBrand: 'visa',
    cardLast4: '4242',
    dedupKey: 'evt_1',
    detachedByUserId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
});

describe('publishSavedCardDetached', () => {
  it('builds the correlationId as saved-card-detached.{walletId}.{dedupKey}, and it is COLON-FREE', async () => {
    await publishSavedCardDetached(notice({ walletId: 'wallet_9', dedupKey: 'evt_abc' }));

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [event, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('credit.saved_card.detached');
    expect(payload.correlationId).toBe('saved-card-detached.wallet_9.evt_abc');
    // ⚠ `.`-JOINED, NEVER `:`-JOINED (DEC-7). `engine/dispatcher.ts:73` builds the per-CHANNEL
    // BullMQ jobId from the RAW correlationId with NO escape (unlike `publisher.ts`'s `toJobId`,
    // which DOES escape colons for the top-level notification-events jobId) — a colon-joined
    // correlationId would throw at `channelQueue.add` and the notice would never be delivered.
    expect((payload.correlationId as string).includes(':')).toBe(false);
  });

  it('stays colon-free even when the dedupKey is a uuid (the user door) or a Stripe event id (the webhook door)', async () => {
    await publishSavedCardDetached(notice({ dedupKey: '3fae9c1a-6b1e-4b7e-9c1a-6b1e4b7e9c1a' }));
    const [, uuidPayload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect((uuidPayload.correlationId as string).includes(':')).toBe(false);

    mockPublish.mockClear();
    await publishSavedCardDetached(notice({ dedupKey: 'evt_1A2b3C' }));
    const [, eventPayload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect((eventPayload.correlationId as string).includes(':')).toBe(false);
  });

  it('maps notice fields onto the payload, and never names the actor key "userId"', async () => {
    await publishSavedCardDetached(
      notice({
        source: 'user_initiated',
        modeReconciled: true,
        previousLowBalanceMode: 'auto_topup',
        detachedByUserId: 'user_1',
      })
    );

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({
      companyId: 'company_1',
      walletId: 'wallet_1',
      source: 'user_initiated',
      modeReconciled: true,
      previousLowBalanceMode: 'auto_topup',
      cardBrand: 'visa',
      cardLast4: '4242',
      detachedByUserId: 'user_1',
    });
    // ⚠ D12 — NOT `userId`: that key would trigger BOTH the generic data.user hydration and the
    // `self` recipient path, mailing the actor separately on top of the billing fan-out.
    expect(payload.userId).toBeUndefined();
  });

  it('null card fields become ABSENT optional keys, never present-but-null', async () => {
    await publishSavedCardDetached(notice({ cardBrand: null, cardLast4: null }));

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect('cardBrand' in payload).toBe(false);
    expect('cardLast4' in payload).toBe(false);
  });

  it('a half-known card label (one null, one not) ALSO omits both — never a half-filled label', async () => {
    await publishSavedCardDetached(notice({ cardBrand: 'visa', cardLast4: null }));

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect('cardBrand' in payload).toBe(false);
    expect('cardLast4' in payload).toBe(false);
  });

  it('omits detachedByUserId entirely on the webhook door (null actor)', async () => {
    await publishSavedCardDetached(notice({ detachedByUserId: null }));

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect('detachedByUserId' in payload).toBe(false);
  });

  it('NEVER throws when the queue publish fails — logs and swallows (best-effort)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(publishSavedCardDetached(notice())).resolves.toBeUndefined();
    expect(mockLog.error).toHaveBeenCalledTimes(1);
  });
});
