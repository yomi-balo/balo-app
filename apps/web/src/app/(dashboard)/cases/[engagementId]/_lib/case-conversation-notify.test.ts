import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CaseAccess } from '@/lib/cases/resolve-case-access';

/**
 * BAL-421 — unit tests for the case thread's RECIPIENT AXIS and its two publishes.
 *
 * ⚠⚠ THE RECIPIENT IS THE **OTHER** SIDE, DERIVED FROM THE SENDER'S GATE-RESOLVED LENS —
 * never from input, and never from `activeMode`. Getting this backwards notifies the sender
 * about their own message and tells the counterparty nothing, with every type green.
 *
 * ⚠⚠ `resolveCaseNotifyContext` IS THE POST-COMMIT GUARD, NOT A CONVENIENCE WRAPPER. Both
 * writers call it AFTER the row is committed and AFTER Ably has the event, so a rejection
 * escaping it would toast "could not send" for a message the sender can already SEE — and the
 * retry would double-post. The tests below fail the reads on purpose and assert the function
 * still resolves.
 */

vi.mock('server-only', () => ({}));

const mockFindOwnerUserId = vi.fn();

vi.mock('@balo/db', () => ({
  companiesRepository: {
    findOwnerUserIdByCompanyId: (...a: unknown[]) => mockFindOwnerUserId(...a),
  },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => mockPublish(...a),
}));

import {
  publishCaseFileShared,
  publishCaseMessagePosted,
  resolveCaseNotifyContext,
  resolveCaseNotifyTargets,
} from './case-conversation-notify';

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000002';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000003';
const CONVERSATION_ID = 'cv000000-0000-4000-8000-000000000004';
const OWNER_ID = 'u0000000-0000-4000-8000-000000000005';
const SENDER_ID = 'u0000000-0000-4000-8000-000000000006';
const MESSAGE_ID = 'msg00000-0000-4000-8000-000000000007';

function access(lens: 'client' | 'expert'): CaseAccess {
  return {
    lens,
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
    engagementStatus: 'active',
    conversationId: CONVERSATION_ID,
    conversationWritable: true,
  };
}

const mockFindCaseTitle = vi.fn();
const mockOnTargetsFailed = vi.fn();

function notifyContext(lens: 'client' | 'expert'): ReturnType<typeof resolveCaseNotifyContext> {
  return resolveCaseNotifyContext({
    access: access(lens),
    engagementId: ENGAGEMENT_ID,
    conversationId: CONVERSATION_ID,
    userId: SENDER_ID,
    findCaseTitle: (id: string) => mockFindCaseTitle(id),
    onTargetsFailed: (error: unknown) => mockOnTargetsFailed(error),
  });
}

/** The payload of the single publish recorded so far. */
function publishedCall(): { event: string; payload: Record<string, unknown> } {
  const call = mockPublish.mock.calls[0];
  if (call === undefined) throw new Error('expected exactly one publish');
  const [event, payload] = call as [string, Record<string, unknown>];
  return { event, payload };
}

const BASE = {
  targets: { recipientRole: 'expert' as const, expertProfileId: PROFILE_ID },
  title: 'Flow interview loop',
  senderName: 'Dana',
  correlationId: MESSAGE_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindOwnerUserId.mockResolvedValue(OWNER_ID);
  mockFindCaseTitle.mockResolvedValue({ title: 'Flow interview loop' });
  mockPublish.mockResolvedValue(undefined);
});

// ── 1. the recipient axis ────────────────────────────────────────────────────────────────

describe('resolveCaseNotifyTargets — the recipient is the OTHER side', () => {
  it('a CLIENT sender notifies the delivering EXPERT, with no company read at all', async () => {
    const targets = await resolveCaseNotifyTargets(access('client'));

    expect(targets).toEqual({ recipientRole: 'expert', expertProfileId: PROFILE_ID });
    expect(mockFindOwnerUserId).not.toHaveBeenCalled();
  });

  it('an EXPERT sender notifies the client company OWNER, resolved from the GATE companyId', async () => {
    const targets = await resolveCaseNotifyTargets(access('expert'));

    expect(targets).toEqual({ recipientRole: 'client', recipientId: OWNER_ID });
    expect(mockFindOwnerUserId).toHaveBeenCalledWith(COMPANY_ID);
  });

  /**
   * ⚠ AN OWNERLESS COMPANY IS AN EXPECTED, NON-FATAL STATE — `findOwnerUserIdByCompanyId` is
   * the NON-THROWING variant precisely for this. The client rule skips gracefully on an absent
   * `recipientId`; turning it into a rejection would fail a message send instead.
   */
  it('an OWNERLESS company still yields targets, with recipientId absent', async () => {
    mockFindOwnerUserId.mockResolvedValue(undefined);

    const targets = await resolveCaseNotifyTargets(access('expert'));

    expect(targets.recipientRole).toBe('client');
    expect(targets.recipientId).toBeUndefined();
    expect(targets.expertProfileId).toBeUndefined();
  });
});

// ── 2. the post-commit guard ─────────────────────────────────────────────────────────────

describe('resolveCaseNotifyContext — degrades, NEVER rejects', () => {
  it('resolves the title and the targets on the happy path', async () => {
    const result = await notifyContext('expert');

    expect(result).toEqual({
      title: 'Flow interview loop',
      targets: { recipientRole: 'client', recipientId: OWNER_ID },
    });
    expect(mockFindCaseTitle).toHaveBeenCalledWith(ENGAGEMENT_ID);
    expect(mockOnTargetsFailed).not.toHaveBeenCalled();
  });

  it('a REJECTING recipient lookup yields NO targets, reports the error, and does not reject', async () => {
    const boom = new Error('connection terminated');
    mockFindOwnerUserId.mockRejectedValue(boom);

    const result = await notifyContext('expert');

    // `targets: undefined` means DO NOT PUBLISH — a missed notification beats a phantom
    // "could not send" for a message the sender can already see.
    expect(result.targets).toBeUndefined();
    expect(result.title).toBe('Flow interview loop');
    expect(mockOnTargetsFailed).toHaveBeenCalledWith(boom);
  });

  it('a REJECTING title read degrades to "your case" without rejecting', async () => {
    mockFindCaseTitle.mockRejectedValue(new Error('db down'));

    const result = await notifyContext('expert');

    expect(result.title).toBe('your case');
    // ⚠ INDEPENDENT — a dead title must not cost the fan-out.
    expect(result.targets).toEqual({ recipientRole: 'client', recipientId: OWNER_ID });
    expect(mockOnTargetsFailed).not.toHaveBeenCalled();
  });

  it('a MISSING case row degrades to "your case" the same way a rejection does', async () => {
    mockFindCaseTitle.mockResolvedValue(undefined);

    const result = await notifyContext('client');

    expect(result.title).toBe('your case');
    expect(result.targets).toEqual({ recipientRole: 'expert', expertProfileId: PROFILE_ID });
  });

  it('a failing recipient lookup still yields a REAL title — the degradations are independent', async () => {
    mockFindOwnerUserId.mockRejectedValue(new Error('connection terminated'));

    const result = await notifyContext('expert');

    expect(result.title).toBe('Flow interview loop');
    expect(result.targets).toBeUndefined();
  });

  it('degrades BOTH at once without rejecting', async () => {
    mockFindCaseTitle.mockRejectedValue(new Error('db down'));
    mockFindOwnerUserId.mockRejectedValue(new Error('db down'));

    await expect(notifyContext('expert')).resolves.toEqual({
      title: 'your case',
      targets: undefined,
    });
  });
});

// ── 3. the engagement arm ────────────────────────────────────────────────────────────────

describe('publishCaseMessagePosted / publishCaseFileShared — the ENGAGEMENT arm', () => {
  it('anchors the message event to the engagement, always outside a meeting', () => {
    publishCaseMessagePosted({ ...BASE, access: access('client'), preview: 'Hi there' });

    const { event, payload } = publishedCall();
    expect(event).toBe('conversation.message_posted');
    expect(payload).toEqual({
      correlationId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      contextType: 'engagement',
      contextId: ENGAGEMENT_ID,
      engagementId: ENGAGEMENT_ID,
      title: 'Flow interview loop',
      senderName: 'Dana',
      recipientRole: 'expert',
      recipientId: undefined,
      expertProfileId: PROFILE_ID,
      preview: 'Hi there',
      // ⚠ ALWAYS FALSE — this composer is the CASE SURFACE, never the in-call panel.
      sentDuringMeeting: false,
    });
    // The context triple is the gate's engagement id, not anything from a caller.
    expect(payload.contextId).toBe(access('client').engagementId);
  });

  it('anchors the file event to the same engagement triple', () => {
    publishCaseFileShared({
      ...BASE,
      targets: { recipientRole: 'client', recipientId: OWNER_ID },
      access: access('expert'),
      fileName: 'deck.pdf',
    });

    const { event, payload } = publishedCall();
    expect(event).toBe('conversation.file_shared');
    expect(payload).toMatchObject({
      contextType: 'engagement',
      contextId: ENGAGEMENT_ID,
      engagementId: ENGAGEMENT_ID,
      recipientRole: 'client',
      recipientId: OWNER_ID,
      expertProfileId: undefined,
      fileName: 'deck.pdf',
    });
  });

  /**
   * ⚠ THE ANCHOR BLOCK IS SHARED, WHICH IS WHY THE MODULE EXISTS. The only payload difference
   * is the CONTENT field (`preview` vs `fileName`) plus the message event's `sentDuringMeeting`
   * flag, which the file event has no equivalent for.
   */
  it('differs ONLY in the content field and the message-only sentDuringMeeting flag', () => {
    publishCaseMessagePosted({ ...BASE, access: access('client'), preview: 'Hi there' });
    publishCaseFileShared({ ...BASE, access: access('client'), fileName: 'deck.pdf' });

    const [messageCall, fileCall] = mockPublish.mock.calls;
    if (messageCall === undefined || fileCall === undefined) {
      throw new Error('expected both publishes to be recorded');
    }
    const [, messagePayload] = messageCall as [string, Record<string, unknown>];
    const [, filePayload] = fileCall as [string, Record<string, unknown>];

    const messageOnly = Object.keys(messagePayload).filter((key) => !(key in filePayload));
    const fileOnly = Object.keys(filePayload).filter((key) => !(key in messagePayload));
    expect(messageOnly.sort()).toEqual(['preview', 'sentDuringMeeting']);
    expect(fileOnly).toEqual(['fileName']);

    const CONTENT_KEYS = ['preview', 'sentDuringMeeting', 'fileName'];
    const anchorOf = (payload: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(payload).filter(([key]) => !CONTENT_KEYS.includes(key)));
    // Everything else — the anchor triple, the recipients, the title — is IDENTICAL. That is
    // the shared-composer claim, and the reason this module exists rather than two copies.
    expect(anchorOf(messagePayload)).toEqual(anchorOf(filePayload));
    expect(Object.keys(anchorOf(messagePayload)).sort()).toEqual([
      'contextId',
      'contextType',
      'conversationId',
      'correlationId',
      'engagementId',
      'expertProfileId',
      'recipientId',
      'recipientRole',
      'senderName',
      'title',
    ]);
  });

  /**
   * ⚠ FIRE-AND-FORGET BY CONTRACT. Both are `void`-returning and `.catch`-guarded, so a
   * transport failure can never fail a message that is already persisted and already broadcast.
   */
  it('swallows a REJECTING transport on both publishers, with no unhandled rejection', async () => {
    mockPublish.mockRejectedValue(new Error('api unreachable'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      publishCaseMessagePosted({ ...BASE, access: access('client'), preview: 'Hi' });
      publishCaseFileShared({ ...BASE, access: access('client'), fileName: 'deck.pdf' });
      // Drain the task queue so an unguarded rejection would have surfaced by now.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
