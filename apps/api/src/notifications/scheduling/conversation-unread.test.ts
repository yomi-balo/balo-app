import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledNotification } from '@balo/db';

const { mockUnreadSummaryFor, mockScheduleNotification, mockFindUserById } = vi.hoisted(() => ({
  mockUnreadSummaryFor: vi.fn(),
  mockScheduleNotification: vi.fn(),
  mockFindUserById: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  conversationsRepository: {
    unreadSummaryFor: (...args: unknown[]) => mockUnreadSummaryFor(...args),
  },
  usersRepository: {
    findById: (...args: unknown[]) => mockFindUserById(...args),
  },
}));

vi.mock('./schedule.js', () => ({
  scheduleNotification: (...args: unknown[]) => mockScheduleNotification(...args),
}));

import {
  conversationUnreadKey,
  conversationUnreadRecheck,
  scheduleConversationUnreadDigest,
  CONVERSATION_UNREAD_DELAY_MS,
  CONVERSATION_UNREAD_RECHECK,
} from './conversation-unread.js';

const CONVERSATION_ID = 'a0000000-0000-4000-8000-000000000001';
const RECIPIENT_USER_ID = 'b0000000-0000-4000-8000-000000000002';
const CONTEXT_ID = 'c0000000-0000-4000-8000-000000000003';
const LATEST_AT = new Date('2026-08-11T10:00:00.000Z');

/** A claimed `scheduled_notifications` row, as the dispatch tick hands it to a guard. */
function row(payload: Record<string, unknown> = {}): ScheduledNotification {
  return {
    payload: {
      correlationId: `${CONVERSATION_ID}:${RECIPIENT_USER_ID}`,
      conversationId: CONVERSATION_ID,
      contextType: 'engagement',
      contextId: CONTEXT_ID,
      recipientUserId: RECIPIENT_USER_ID,
      recipientRole: 'client',
      title: 'Salesforce CPQ',
      senderName: 'Priya',
      unreadMessageCount: 0,
      unreadFileCount: 0,
      latestActivityAtIso: '2026-08-11T09:00:00.000Z',
      ...payload,
    },
  } as unknown as ScheduledNotification;
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unreadMessageCount: 0,
    unreadFileCount: 0,
    distinctInboundSenderCount: 0,
    latestInboundAt: null,
    latestInboundSenderUserId: null,
    latestInboundBody: null,
    latestInboundFileName: null,
    ...overrides,
  };
}

describe('conversationUnreadKey', () => {
  /**
   * ⚠⚠ THE COALESCING TEST. The key names NEITHER the message NOR the file, which is exactly
   * what makes a message at T+0 and a file at T+3min fold into ONE pending row — and so into
   * ONE email (owner ruling, 2026-08-11).
   */
  it('is identical for a message-triggered and a file-triggered schedule of the same pair', () => {
    const fromMessage = conversationUnreadKey(CONVERSATION_ID, RECIPIENT_USER_ID);
    const fromFile = conversationUnreadKey(CONVERSATION_ID, RECIPIENT_USER_ID);
    expect(fromMessage).toBe(fromFile);
    expect(fromMessage).toBe(`conversation-unread:${CONVERSATION_ID}:${RECIPIENT_USER_ID}`);
    expect(fromMessage).not.toContain('message');
    expect(fromMessage).not.toContain('file');
  });

  it('separates the two recipients of one conversation', () => {
    expect(conversationUnreadKey(CONVERSATION_ID, 'user-a')).not.toBe(
      conversationUnreadKey(CONVERSATION_ID, 'user-b')
    );
  });
});

describe('conversationUnreadRecheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUserById.mockResolvedValue({ firstName: 'Priya', lastName: 'Nair' });
  });

  it('publishes when messages are unread, rebuilding the counts from live state', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 3,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-priya',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>Are you keeping Zendesk?</p>',
      })
    );
    const result = await conversationUnreadRecheck(row());
    expect(mockUnreadSummaryFor).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      viewerUserId: RECIPIENT_USER_ID,
    });
    expect(result).toEqual({
      publish: true,
      payload: expect.objectContaining({
        unreadMessageCount: 3,
        unreadFileCount: 0,
        latestActivityAtIso: LATEST_AT.toISOString(),
        preview: 'Are you keeping Zendesk?',
      }),
    });
  });

  /**
   * ⚠ THE REBUILT PAYLOAD MUST KEEP `correlationId`. `publisher.publish` derives the BullMQ
   * jobId from it, so a missing one collapses every promise of this event into the single job
   * `event--undefined`. The guard SPREADS the stored payload; it never builds fresh.
   */
  it('preserves correlationId (and every other stored field) on the rebuilt payload', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 1,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-priya',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>hi</p>',
      })
    );
    const result = await conversationUnreadRecheck(row());
    expect(result.publish).toBe(true);
    if (result.publish) {
      expect(result.payload.correlationId).toBe(`${CONVERSATION_ID}:${RECIPIENT_USER_ID}`);
      expect(result.payload.contextType).toBe('engagement');
      expect(result.payload.contextId).toBe(CONTEXT_ID);
      expect(result.payload.recipientRole).toBe('client');
    }
  });

  /**
   * ⚠⚠ THE FILE-ONLY REGRESSION THIS RULING EXISTS TO FIX. Before BAL-424 a file share
   * produced an in-app notification and NO EMAIL, EVER. Skipping on `unreadMessageCount === 0`
   * alone would reinstate exactly that.
   */
  it('publishes a FILE-ONLY exchange with fileName set and preview CLEARED', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 0,
        unreadFileCount: 1,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-priya',
        latestInboundAt: LATEST_AT,
        latestInboundFileName: 'price-book.xlsx',
      })
    );
    // ⚠ THE STORED PAYLOAD SEEDS A `preview` — the message leg won at SCHEDULE time. If the
    // guard only ever ADDED keys, that stale preview would survive and the template would
    // render "X said …" under a "1 new file waiting for you." headline. Seeding it is what
    // makes this test real rather than vacuous (the default payload carries neither key).
    const result = await conversationUnreadRecheck(row({ preview: 'stale message preview' }));
    expect(result.publish).toBe(true);
    if (result.publish) {
      expect(result.payload.unreadMessageCount).toBe(0);
      expect(result.payload.unreadFileCount).toBe(1);
      expect(result.payload.fileName).toBe('price-book.xlsx');
      expect(result.payload.preview).toBeUndefined();
    }
  });

  /** The mirror image: a stale `fileName` must not survive a message-only rebuild. */
  it('clears a stale fileName when the message leg wins at fire time', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 2,
        unreadFileCount: 0,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-priya',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>and one more thing</p>',
      })
    );
    const result = await conversationUnreadRecheck(row({ fileName: 'stale.pdf' }));
    expect(result.publish).toBe(true);
    if (result.publish) {
      expect(result.payload.preview).toBe('and one more thing');
      expect(result.payload.fileName).toBeUndefined();
    }
  });

  // ── senderName is REBUILT, never inherited ────────────────────────────
  it('rebuilds senderName from the live newest-inbound author', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 1,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-marcus',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>hi</p>',
      })
    );
    mockFindUserById.mockResolvedValue({ firstName: 'Marcus', lastName: 'Bell' });
    // The STORED name is whoever triggered the FIRST activity in the window.
    const result = await conversationUnreadRecheck(row({ senderName: 'Priya' }));
    expect(mockFindUserById).toHaveBeenCalledWith('user-marcus');
    expect(result.publish).toBe(true);
    if (result.publish) {
      expect(result.payload.senderName).toBe('Marcus Bell');
    }
  });

  /**
   * ⚠ A COALESCED WINDOW SPANNING TWO PEOPLE NAMES NOBODY. Naming only the newest would be a
   * quiet lie about who wrote the rest, so the template says "your conversation" instead.
   */
  it('drops attribution to null when the digest spans more than one sender', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 3,
        unreadFileCount: 1,
        distinctInboundSenderCount: 2,
        latestInboundSenderUserId: 'user-marcus',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>hi</p>',
      })
    );
    const result = await conversationUnreadRecheck(row({ senderName: 'Priya' }));
    expect(result.publish).toBe(true);
    if (result.publish) {
      expect(result.payload.senderName).toBeNull();
    }
    // No point resolving a name we are not going to use.
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it('falls back to the stored name when the author cannot be resolved', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 1,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-gone',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>hi</p>',
      })
    );
    mockFindUserById.mockResolvedValue(undefined);
    const result = await conversationUnreadRecheck(row({ senderName: 'Priya' }));
    expect(result.publish).toBe(true);
    if (result.publish) {
      expect(result.payload.senderName).toBe('Priya');
    }
  });

  it('publishes a mixed window with BOTH counts, summed by neither', async () => {
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 3,
        unreadFileCount: 1,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-priya',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>see attached</p>',
      })
    );
    const result = await conversationUnreadRecheck(row());
    expect(result).toMatchObject({
      publish: true,
      payload: { unreadMessageCount: 3, unreadFileCount: 1 },
    });
  });

  /**
   * THE WATERMARK PASSED THE ACTIVITY — the AC's "no email to a recipient whose watermark is
   * newer". A NORMAL outcome (`skip_reason`), never a failure.
   */
  it('skips when nothing is unread', async () => {
    mockUnreadSummaryFor.mockResolvedValue(summary());
    expect(await conversationUnreadRecheck(row())).toEqual({
      publish: false,
      reason: 'read_before_send',
    });
  });

  it('skips when the counts are zero even though an inbound instant exists', async () => {
    mockUnreadSummaryFor.mockResolvedValue(summary({ latestInboundAt: LATEST_AT }));
    expect(await conversationUnreadRecheck(row())).toEqual({
      publish: false,
      reason: 'read_before_send',
    });
  });

  it.each([
    ['conversationId', { conversationId: 42 }],
    ['recipientUserId', { recipientUserId: null }],
  ])('skips a payload with a malformed %s, without touching the database', async (_l, bad) => {
    expect(await conversationUnreadRecheck(row(bad))).toEqual({
      publish: false,
      reason: 'malformed_payload',
    });
    expect(mockUnreadSummaryFor).not.toHaveBeenCalled();
  });
});

describe('scheduleConversationUnreadDigest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScheduleNotification.mockResolvedValue({ outcome: 'scheduled' });
  });

  const base = {
    conversationId: CONVERSATION_ID,
    contextType: 'engagement' as const,
    contextId: CONTEXT_ID,
    recipientUserId: RECIPIENT_USER_ID,
    recipientRole: 'client' as const,
    title: 'Salesforce CPQ',
    senderName: 'Priya',
  };

  it('schedules +10 minutes, first_wins, guarded by the conversation_unread recheck', async () => {
    await scheduleConversationUnreadDigest({ ...base, preview: 'hello' });
    expect(mockScheduleNotification).toHaveBeenCalledWith(
      'conversation.unread_digest_due',
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        contextType: 'engagement',
        recipientUserId: RECIPIENT_USER_ID,
        preview: 'hello',
      }),
      {
        key: conversationUnreadKey(CONVERSATION_ID, RECIPIENT_USER_ID),
        delayMs: CONVERSATION_UNREAD_DELAY_MS,
        // ⚠ `first_wins`, NOT `replace_pending`: the window is anchored on the FIRST unread
        // activity. Pushing it out on every subsequent one means a fast exchange never sends.
        mode: 'first_wins',
        recheck: CONVERSATION_UNREAD_RECHECK,
      }
    );
    expect(CONVERSATION_UNREAD_DELAY_MS).toBe(10 * 60 * 1000);
  });

  /** Both publishers reach the SAME key — the other half of the coalescing story. */
  it('uses one key for a message-seeded and a file-seeded schedule', async () => {
    await scheduleConversationUnreadDigest({ ...base, preview: 'hello' });
    await scheduleConversationUnreadDigest({ ...base, fileName: 'x.pdf' });
    const [firstCall, secondCall] = mockScheduleNotification.mock.calls;
    expect(firstCall?.[2].key).toBe(secondCall?.[2].key);
  });

  /**
   * ⚠⚠ THE HIGH-SEVERITY REGRESSION THIS TEST EXISTS FOR. `publisher.publish` derives the
   * BullMQ jobId as `${event}--${correlationId}`, and `lib/queue.ts` retains completed jobs
   * `{ count: 100 }` on ONE SHARED queue. A correlationId stable per (conversation,
   * recipient) FOREVER — which is what the plan specified and called "stable per promise" —
   * therefore collides with its OWN EARLIER SEND for days at pre-launch volume:
   * `queue.add` silently no-ops while the dispatch tick still marks the row `published`.
   *
   * Reachable on an ordinary path: digest #1 at T+10; recipient reads at T+11; counterparty
   * writes again at T+40; the T+50 digest is NEVER DELIVERED and nothing records a failure.
   */
  it('mints a DIFFERENT correlationId for each successive promise of the same pair', async () => {
    await scheduleConversationUnreadDigest(base);
    await scheduleConversationUnreadDigest(base);
    const [first, second] = mockScheduleNotification.mock.calls;
    const firstId = first?.[1].correlationId;
    const secondId = second?.[1].correlationId;

    expect(typeof firstId).toBe('string');
    expect(firstId).not.toHaveLength(0);
    expect(firstId).not.toBe(secondId);
    // Specifically NOT the pair-scoped value the plan named.
    expect(firstId).not.toBe(`${CONVERSATION_ID}:${RECIPIENT_USER_ID}`);
    // …while the DEDUPE KEY stays pair-scoped — that is what still coalesces the window.
    expect(first?.[2].key).toBe(second?.[2].key);
  });

  /**
   * The other half of the requirement: stable across the RECHECK'S REBUILD of one promise, so
   * a stranded send that is re-claimed and re-published still dedupes against itself.
   */
  it("keeps one promise's correlationId stable across the recheck rebuild", async () => {
    await scheduleConversationUnreadDigest(base);
    const stored = mockScheduleNotification.mock.calls[0]?.[1];
    mockUnreadSummaryFor.mockResolvedValue(
      summary({
        unreadMessageCount: 1,
        distinctInboundSenderCount: 1,
        latestInboundSenderUserId: 'user-priya',
        latestInboundAt: LATEST_AT,
        latestInboundBody: '<p>hi</p>',
      })
    );
    mockFindUserById.mockResolvedValue({ firstName: 'Priya', lastName: 'Nair' });

    const first = await conversationUnreadRecheck(row(stored));
    const second = await conversationUnreadRecheck(row(stored));
    expect(first.publish).toBe(true);
    expect(second.publish).toBe(true);
    if (first.publish && second.publish) {
      expect(first.payload.correlationId).toBe(stored.correlationId);
      expect(second.payload.correlationId).toBe(stored.correlationId);
    }
  });

  it('omits preview / fileName / anchor ids that were not supplied', async () => {
    await scheduleConversationUnreadDigest(base);
    const [, payload] = mockScheduleNotification.mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty('preview');
    expect(payload).not.toHaveProperty('fileName');
    expect(payload).not.toHaveProperty('projectRequestId');
    expect(payload).not.toHaveProperty('engagementId');
  });
});
