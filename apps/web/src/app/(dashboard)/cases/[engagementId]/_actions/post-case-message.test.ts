import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for posting into a CASE's conversation.
 *
 * ⚠⚠ `_lib/case-conversation-notify.ts` IS DELIBERATELY **REAL** HERE, NOT MOCKED. The single
 * most valuable claim in this file is that a POST-COMMIT recipient-resolution failure does NOT
 * surface as "could not send" — and that guard lives inside `resolveCaseNotifyContext`. Mocking
 * that module would replace the code under test with a stub that cannot fail, leaving a green
 * suite asserting nothing. So the rejection is injected at its true source (`@balo/db`'s
 * `companiesRepository.findOwnerUserIdByCompanyId`) and observed through the ACTION's return
 * value, which is what a user actually experiences.
 *
 * The sanitiser chain (`plainMessageToHtml` → `sanitizeProjectHtml` → `htmlToPlainText`) is also
 * real: it is the security boundary for stored HTML, and a mocked sanitiser proves nothing.
 * Only `@balo/db`, the session, the tenancy gate and the two transports are mocked.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'u0000000-0000-4000-8000-000000000002';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';
const CONVERSATION_ID = 'v0000000-0000-4000-8000-000000000005';
const OWNER_ID = 'o0000000-0000-4000-8000-000000000006';
const MESSAGE_ID = 'm0000000-0000-4000-8000-000000000007';
const CREATED_AT = new Date('2026-08-12T09:00:00Z');

vi.mock('server-only', () => ({}));

const mockPostMessage = vi.fn();
const mockMarkThreadRead = vi.fn();
const mockFindCase = vi.fn();
const mockFindOwner = vi.fn();

vi.mock('@balo/db', () => ({
  conversationsRepository: {
    postMessage: (...a: unknown[]) => mockPostMessage(...a),
    markThreadRead: (...a: unknown[]) => mockMarkThreadRead(...a),
  },
  caseEngagementsRepository: {
    findByEngagementId: (...a: unknown[]) => mockFindCase(...a),
  },
  companiesRepository: {
    findOwnerUserIdByCompanyId: (...a: unknown[]) => mockFindOwner(...a),
  },
}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockPublishConversationEvent = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  publishConversationEvent: (...a: unknown[]) => {
    mockPublishConversationEvent(...a);
    return Promise.resolve();
  },
}));

const mockPublishNotification = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublishNotification(...a);
    return Promise.resolve();
  },
}));

import { postCaseMessageAction } from './post-case-message';
import { log } from '@/lib/logging';
import { MESSAGE_MAX_TEXT } from '@/lib/project-request/conversation-view-types';

interface Access {
  lens: 'client' | 'expert';
  engagementId: string;
  companyId: string;
  expertProfileId: string;
  engagementStatus: string;
  conversationId: string;
  conversationWritable: boolean;
}

function access(over: Partial<Access> = {}): Access {
  return {
    lens: 'client',
    engagementId: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: PROFILE_ID,
    engagementStatus: 'active',
    conversationId: CONVERSATION_ID,
    conversationWritable: true,
    ...over,
  };
}

const INPUT = { engagementId: ENGAGEMENT_ID, body: 'Can you look at the flow again?' };

/** The `body` string handed to `conversationsRepository.postMessage` — the STORED HTML. */
function storedBody(): string {
  const [call] = mockPostMessage.mock.calls;
  if (call === undefined) throw new Error('postMessage was never called');
  const [arg] = call as [{ body: string }];
  return arg.body;
}

/** The payload of the single `publishNotificationEvent` call. */
function notifiedPayload(): Record<string, unknown> {
  const [call] = mockPublishNotification.mock.calls;
  if (call === undefined) throw new Error('publishNotificationEvent was never called');
  const [, payload] = call as [string, Record<string, unknown>];
  return payload;
}

function seed(over: { access?: Partial<Access> } = {}): void {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({
    id: USER_ID,
    firstName: 'Dana',
    lastName: 'Whitfield',
  });
  mockResolveCaseAccess.mockResolvedValue(access(over.access));
  mockPostMessage.mockResolvedValue({
    id: MESSAGE_ID,
    body: '<p>Can you look at the flow again?</p>',
    createdAt: CREATED_AT,
  });
  mockMarkThreadRead.mockResolvedValue({ lastReadAt: CREATED_AT });
  mockFindCase.mockResolvedValue({ title: 'Flow interview loop' });
  mockFindOwner.mockResolvedValue(OWNER_ID);
}

beforeEach(() => {
  seed();
});

describe('postCaseMessageAction — the gates, in order', () => {
  it('goes through requireOnboardedUser BEFORE the tenancy gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    expect(await postCaseMessageAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('re-runs the FULL tenancy gate — a Server Action never trusts the page decision', async () => {
    await postCaseMessageAction(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('rejects a malformed engagementId before any DB read', async () => {
    expect(await postCaseMessageAction({ engagementId: 'nope', body: 'hi' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('rejects an unknown extra field — the schema is strict', async () => {
    const result = await postCaseMessageAction({
      ...INPUT,
      relationshipId: 'r-1',
    } as unknown as typeof INPUT);
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('refuses a gate denial and never writes', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await postCaseMessageAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer available.',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  /**
   * ⚠ READ ACCESS AND WRITE ACCESS ARE SEPARATE QUESTIONS. A closed case stays fully readable,
   * but nobody may post to it — and the predicate is composed ONCE at the gate, so the
   * composer's enabled state and this refusal cannot disagree.
   */
  it('refuses a CLOSED case with its own distinct copy, and never writes', async () => {
    mockResolveCaseAccess.mockResolvedValue(access({ conversationWritable: false }));
    expect(await postCaseMessageAction(INPUT)).toEqual({
      success: false,
      error: 'This case is closed, so the conversation is read-only.',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockPublishConversationEvent).not.toHaveBeenCalled();
  });

  it('posts to the conversation FROM THE GATE and the user FROM THE SESSION', async () => {
    mockResolveCaseAccess.mockResolvedValue(access({ conversationId: 'gate-owned-conversation' }));
    await postCaseMessageAction(INPUT);
    expect(mockPostMessage).toHaveBeenCalledWith({
      conversationId: 'gate-owned-conversation',
      senderUserId: USER_ID,
      body: expect.any(String),
    });
  });
});

describe('postCaseMessageAction — the sanitiser is the security boundary', () => {
  it('ESCAPES a script tag rather than storing it', async () => {
    await postCaseMessageAction({
      engagementId: ENGAGEMENT_ID,
      body: '<script>alert(1)</script>',
    });
    const stored = storedBody();
    expect(stored).not.toContain('<script>');
    expect(stored).toContain('&lt;script&gt;');
  });

  it('neutralises an inline event-handler payload into inert text', async () => {
    await postCaseMessageAction({
      engagementId: ENGAGEMENT_ID,
      body: '<img src=x onerror="steal()">',
    });
    const stored = storedBody();
    // The composer is PLAIN TEXT, so the payload survives only as escaped characters — there
    // is no `img` ELEMENT for a browser to fire `onerror` on.
    expect(stored).not.toContain('<img');
    expect(stored).toContain('&lt;img');
    // The only tags that survive are the composer's own paragraph wrapper.
    expect(stored.match(/<[a-z]/gi)).toEqual(['<p']);
  });

  it('refuses a whitespace-only message with copy that names the fix', async () => {
    expect(await postCaseMessageAction({ engagementId: ENGAGEMENT_ID, body: '   \n  ' })).toEqual({
      success: false,
      error: 'Type a message first.',
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('enforces the PLAIN-TEXT length limit, not the raw payload length', async () => {
    const result = await postCaseMessageAction({
      engagementId: ENGAGEMENT_ID,
      body: 'x'.repeat(MESSAGE_MAX_TEXT + 1),
    });
    expect(result).toEqual({
      success: false,
      error: `Keep your message under ${MESSAGE_MAX_TEXT} characters.`,
    });
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('accepts a message exactly AT the limit — the bound is inclusive', async () => {
    const result = await postCaseMessageAction({
      engagementId: ENGAGEMENT_ID,
      body: 'x'.repeat(MESSAGE_MAX_TEXT),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a raw payload beyond the coarse DoS bound before any gate call', async () => {
    const result = await postCaseMessageAction({
      engagementId: ENGAGEMENT_ID,
      body: 'x'.repeat(20001),
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });
});

describe('postCaseMessageAction — the committed message and its broadcast', () => {
  it('returns the message view built from the STORED row, not the input', async () => {
    const result = await postCaseMessageAction(INPUT);
    expect(result).toEqual({
      success: true,
      message: {
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        bodyHtml: '<p>Can you look at the flow again?</p>',
        senderUserId: USER_ID,
        senderName: 'Dana Whitfield',
        createdAtIso: CREATED_AT.toISOString(),
      },
    });
  });

  it('falls back to a neutral sender label when the user has no name on file', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
    const result = await postCaseMessageAction(INPUT);
    expect(result).toMatchObject({ message: { senderName: 'Participant' } });
  });

  it('broadcasts the SAME view it returns, on the message channel', async () => {
    const result = await postCaseMessageAction(INPUT);
    if (!result.success) throw new Error('expected the post to succeed');
    expect(mockPublishConversationEvent).toHaveBeenCalledWith(
      CONVERSATION_ID,
      'message',
      result.message
    );
  });

  it('advances the read watermark to the row instant — sending is reading', async () => {
    await postCaseMessageAction(INPUT);
    expect(mockMarkThreadRead).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      at: CREATED_AT,
    });
  });

  it('a WATERMARK failure never fails the posted message', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('db blip'));
    const result = await postCaseMessageAction(INPUT);
    expect(result.success).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  it('surfaces a genuine WRITE failure, and never broadcasts a message it did not store', async () => {
    mockPostMessage.mockRejectedValue(new Error('insert failed'));
    expect(await postCaseMessageAction(INPUT)).toEqual({
      success: false,
      error: 'Could not send your message. Please try again.',
    });
    expect(mockPublishConversationEvent).not.toHaveBeenCalled();
    expect(mockPublishNotification).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE POST-COMMIT GUARD — THE POINT OF THIS FILE.
 *
 * By the time recipients are resolved, the row is PERSISTED and the Ably event is ALREADY ON
 * THE WIRE. A rejection there must degrade to NO fan-out, never to a failed action: the sender
 * can already SEE their message in the thread, so "could not send" would be a lie, and the
 * retry it invites would DOUBLE-POST.
 */
describe('postCaseMessageAction — a post-commit failure must NOT surface as "could not send"', () => {
  it('still returns SUCCESS when recipient resolution REJECTS, and publishes nothing', async () => {
    seed({ access: { lens: 'expert' } });
    mockFindOwner.mockRejectedValue(new Error('connection terminated'));

    const result = await postCaseMessageAction(INPUT);

    // The whole point: the user is told the message sent, because it did.
    expect(result).toMatchObject({ success: true, message: { id: MESSAGE_ID } });
    // A missed notification is strictly better than a duplicated message.
    expect(mockPublishNotification).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Case notify target resolution failed after commit — no fan-out',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, conversationId: CONVERSATION_ID })
    );
  });

  it('still broadcasts over Ably even when the fan-out is abandoned', async () => {
    seed({ access: { lens: 'expert' } });
    mockFindOwner.mockRejectedValue(new Error('connection terminated'));
    await postCaseMessageAction(INPUT);
    expect(mockPublishConversationEvent).toHaveBeenCalledTimes(1);
  });

  it('degrades a failed TITLE read to a neutral label rather than dropping the notification', async () => {
    mockFindCase.mockRejectedValue(new Error('read timeout'));
    const result = await postCaseMessageAction(INPUT);
    expect(result.success).toBe(true);
    expect(notifiedPayload().title).toBe('your case');
  });

  it('a missing case row degrades the title without failing the send', async () => {
    mockFindCase.mockResolvedValue(undefined);
    const result = await postCaseMessageAction(INPUT);
    expect(result.success).toBe(true);
    expect(notifiedPayload().title).toBe('your case');
  });

  it('the two degradations are INDEPENDENT — a failed title still fans out', async () => {
    seed({ access: { lens: 'expert' } });
    mockFindCase.mockRejectedValue(new Error('read timeout'));
    await postCaseMessageAction(INPUT);
    expect(mockPublishNotification).toHaveBeenCalledTimes(1);
    expect(notifiedPayload()).toMatchObject({ recipientRole: 'client', recipientId: OWNER_ID });
  });
});

/**
 * The recipient is the OTHER side, derived from the sender's GATE-RESOLVED lens — never from
 * input and never from `activeMode`.
 */
describe('postCaseMessageAction — who gets notified', () => {
  it('a CLIENT sender notifies the delivering expert, with no company-owner lookup at all', async () => {
    await postCaseMessageAction(INPUT);
    expect(mockFindOwner).not.toHaveBeenCalled();
    expect(notifiedPayload()).toMatchObject({
      recipientRole: 'expert',
      expertProfileId: PROFILE_ID,
    });
  });

  it('an EXPERT sender notifies the client company owner, resolved from the GATE companyId', async () => {
    seed({ access: { lens: 'expert' } });
    await postCaseMessageAction(INPUT);
    expect(mockFindOwner).toHaveBeenCalledWith(COMPANY_ID);
    expect(notifiedPayload()).toMatchObject({ recipientRole: 'client', recipientId: OWNER_ID });
  });

  it('publishes conversation.message_posted on the ENGAGEMENT arm, with no email anywhere', async () => {
    await postCaseMessageAction(INPUT);
    const [call] = mockPublishNotification.mock.calls;
    if (call === undefined) throw new Error('publishNotificationEvent was never called');
    const [event] = call as [string];
    expect(event).toBe('conversation.message_posted');
    expect(notifiedPayload()).toMatchObject({
      correlationId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      contextType: 'engagement',
      contextId: ENGAGEMENT_ID,
      engagementId: ENGAGEMENT_ID,
      senderName: 'Dana Whitfield',
      sentDuringMeeting: false,
    });
    expect(JSON.stringify(notifiedPayload())).not.toContain('@');
  });

  it('carries a PREVIEW of the plain text, not the raw HTML body', async () => {
    await postCaseMessageAction(INPUT);
    const preview = notifiedPayload().preview;
    expect(preview).toBe('Can you look at the flow again?');
    expect(String(preview)).not.toContain('<p>');
  });

  it('logs the business event on success', async () => {
    await postCaseMessageAction(INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Case conversation message posted',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, messageId: MESSAGE_ID })
    );
  });
});
