import { describe, it, expect, vi, beforeEach } from 'vitest';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const MSG_ID = 'd0000000-0000-4000-8000-000000000004';

vi.mock('server-only', () => ({}));

const mockListMessagesPage = vi.fn();
const mockListFiles = vi.fn();
vi.mock('@balo/db', () => ({
  conversationsRepository: {
    listMessagesPage: (...args: unknown[]) => mockListMessagesPage(...args),
    listFiles: (...args: unknown[]) => mockListFiles(...args),
  },
  expertsRepository: {
    findProfileById: vi.fn(),
  },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireUser: () => mockRequireUser(),
}));

const mockResolveAccess = vi.fn();
vi.mock('@/lib/project-request/resolve-conversation-access', () => ({
  resolveConversationAccess: (...args: unknown[]) => mockResolveAccess(...args),
}));

vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: () => false,
}));

import { fetchThreadAction } from './fetch-thread';
import { log } from '@/lib/logging';

const USER = { id: 'user-client' };

const ACCESS_OK = {
  ok: true,
  ctx: { lens: 'client' },
  request: {
    id: REQUEST_ID,
    createdByUserId: 'user-client',
    createdByUser: { id: 'user-client', firstName: 'Dana', lastName: 'Whitfield' },
  },
  relationship: {
    id: REL_ID,
    expertProfileId: 'exp-1',
    expertProfile: {
      id: 'exp-1',
      user: { id: 'user-expert', firstName: 'Priya', lastName: 'Nair' },
    },
  },
  recipient: { role: 'expert', expertProfileId: 'exp-1' },
};

function messageRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MSG_ID,
    relationshipId: REL_ID,
    senderUserId: 'user-expert',
    body: '<p>hello</p>',
    createdAt: new Date('2026-06-09T10:00:00Z'),
    updatedAt: new Date('2026-06-09T10:00:00Z'),
    deletedAt: null,
    senderFirstName: 'Priya',
    senderLastName: 'Nair',
    ...overrides,
  };
}

describe('fetchThreadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockResolveAccess.mockResolvedValue(ACCESS_OK);
    mockListMessagesPage.mockResolvedValue({ messages: [messageRow()], hasEarlier: false });
    mockListFiles.mockResolvedValue([]);
  });

  it('rejects when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('Unauthorized'));
    const result = await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      includeFiles: false,
    });
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects an invalid cursor', async () => {
    const result = await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      before: { createdAtIso: 'not-a-date', id: MSG_ID },
      includeFiles: false,
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('returns the access guard error on denial', async () => {
    mockResolveAccess.mockResolvedValue({ ok: false, error: 'No access.' });
    const result = await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      includeFiles: true,
    });
    expect(result).toEqual({ success: false, error: 'No access.' });
    expect(mockListMessagesPage).not.toHaveBeenCalled();
  });

  it('returns mapped messages without files when includeFiles is false', async () => {
    const result = await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      includeFiles: false,
    });
    expect(result).toEqual({
      success: true,
      messages: [
        expect.objectContaining({ id: MSG_ID, bodyHtml: '<p>hello</p>', senderName: 'Priya Nair' }),
      ],
      hasEarlier: false,
    });
    expect(mockListFiles).not.toHaveBeenCalled();
  });

  it('parses the keyset cursor into a Date for the repo', async () => {
    await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      before: { createdAtIso: '2026-06-09T10:00:00.000Z', id: MSG_ID },
      includeFiles: false,
    });
    expect(mockListMessagesPage).toHaveBeenCalledWith({
      relationshipId: REL_ID,
      before: { createdAt: new Date('2026-06-09T10:00:00.000Z'), id: MSG_ID },
      limit: 30,
    });
  });

  it('returns files newest-first with uploader attribution when includeFiles is true', async () => {
    mockListFiles.mockResolvedValue([
      {
        id: 'f-old',
        relationshipId: REL_ID,
        uploadedByUserId: 'user-client',
        r2Key: 'k1',
        fileName: 'old.pdf',
        contentType: 'application/pdf',
        sizeBytes: 100,
        createdAt: new Date('2026-06-07T00:00:00Z'),
        updatedAt: new Date('2026-06-07T00:00:00Z'),
        deletedAt: null,
      },
      {
        id: 'f-new',
        relationshipId: REL_ID,
        uploadedByUserId: 'user-expert',
        r2Key: 'k2',
        fileName: 'new.pdf',
        contentType: 'application/pdf',
        sizeBytes: 200,
        createdAt: new Date('2026-06-08T00:00:00Z'),
        updatedAt: new Date('2026-06-08T00:00:00Z'),
        deletedAt: null,
      },
    ]);
    const result = await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      includeFiles: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.files?.map((f) => f.id)).toEqual(['f-new', 'f-old']);
      expect(result.files?.[0]?.uploadedByName).toBe('Priya Nair');
      expect(result.files?.[1]?.uploadedByName).toBe('Dana Whitfield');
    }
  });

  it('maps repo failures to a friendly error and logs', async () => {
    mockListMessagesPage.mockRejectedValue(new Error('boom'));
    const result = await fetchThreadAction({
      requestId: REQUEST_ID,
      relationshipId: REL_ID,
      includeFiles: false,
    });
    expect(result).toEqual({
      success: false,
      error: 'Could not load this conversation. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to fetch conversation thread',
      expect.any(Object)
    );
  });
});
