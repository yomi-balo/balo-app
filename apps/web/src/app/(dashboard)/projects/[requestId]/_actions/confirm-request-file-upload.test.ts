import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';
const FILE_UUID = 'f0000000-0000-4000-8000-000000000006';
const KEY = `request-files/${REQUEST_ID}/${USER_ID}/${FILE_UUID}`;
const CREATED_AT = new Date('2026-08-10T00:00:00Z');

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
  REQUEST_FILES_UNAVAILABLE_COPY: 'These files are no longer available.',
  REQUEST_FILE_TRACK_CLOSED_SELF_COPY: 'You can no longer share files on this request.',
}));

const mockShare = vi.fn();
// ⚠ `vi.hoisted` — a `class` declaration referenced inside a `vi.mock` factory hits the TDZ
// ("Cannot access 'X' before initialization") because vitest's mock-hoisting only relocates
// `const mockXxx = ...` assignment patterns, not class declarations. `vi.hoisted` is the
// documented escape hatch for exactly this shape.
const { MockTrackNotLiveError } = vi.hoisted(() => {
  class MockTrackNotLiveErrorImpl extends Error {
    relationshipId: string;
    constructor(relationshipId: string) {
      super('closed');
      this.relationshipId = relationshipId;
    }
  }
  return { MockTrackNotLiveError: MockTrackNotLiveErrorImpl };
});
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: { share: (...args: unknown[]) => mockShare(...args) },
  RequestFileTrackNotLiveError: MockTrackNotLiveError,
}));

const mockLoadTrackDisplays = vi.fn();
vi.mock('@/lib/request-files/load-request-files', () => ({
  loadTrackDisplays: (...args: unknown[]) => mockLoadTrackDisplays(...args),
  toSerializerFile: (row: unknown) => row,
  fullName: (first: string | null, last: string | null, fallback: string) =>
    [first, last].filter(Boolean).join(' ') || fallback,
  // ⚠ THE SHARED ATTRIBUTION HELPER. The loader builds the identical label on the next page
  // load, which is the whole point — the same file must not read "Sarah Chen @ Acme Corp" now
  // and "Sarah Chen" after a refresh.
  clientUploaderLabel: (person: string, org: string) => `${person} @ ${org}`,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrack(...args),
  REQUEST_FILE_SERVER_EVENTS: { UPLOADED: 'request_file_uploaded' },
}));

const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => {
    mockPublish(...args);
    return Promise.resolve();
  },
}));

const mockPublishConversationEvent = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  publishConversationEvent: (...args: unknown[]) => {
    mockPublishConversationEvent(...args);
    return Promise.resolve();
  },
}));

const mockSend = vi.fn();
vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: (...args: unknown[]) => mockSend(...args) },
  R2_BUCKET: 'test-bucket',
}));
vi.mock('@aws-sdk/client-s3', () => ({
  HeadObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

const mockDelete = vi.fn();
vi.mock('@/lib/storage/request-file', () => ({
  REQUEST_FILE_ALLOWED_CONTENT_TYPES: new Set(['application/pdf']),
  MAX_REQUEST_FILE_BYTES: 10 * 1024 * 1024,
  REQUEST_FILE_PREFIX: 'request-files/',
  deleteRequestFileFromR2: (...args: unknown[]) => {
    mockDelete(...args);
    return Promise.resolve();
  },
}));

import { confirmRequestFileUploadAction } from './confirm-request-file-upload';

const USER = { id: USER_ID, firstName: 'Sarah', lastName: 'Chen' };

const CLIENT_SCOPE = {
  ok: true,
  side: 'client',
  request: {
    id: REQUEST_ID,
    title: 'CPQ rollout',
    createdByUserId: USER_ID,
    company: { name: 'Acme Corp' },
    relationships: [],
  },
  companyId: 'company-1',
  tracks: [],
};

const EXPERT_SCOPE = {
  ok: true,
  side: 'expert',
  request: {
    id: REQUEST_ID,
    title: 'CPQ rollout',
    createdByUserId: 'client-user',
    company: { name: 'Acme Corp' },
    relationships: [{ id: REL_ID, invitedAt: new Date('2026-08-01T00:00:00Z') }],
  },
  viewer: {
    relationshipId: REL_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    access: { kind: 'live' },
    standing: {
      status: 'eoi_submitted',
      declinedAt: null,
      notSelectedAt: null,
      openedAt: new Date('2026-08-02T00:00:00Z'),
    },
  },
};

const VALID_CLIENT_INPUT = {
  requestId: REQUEST_ID,
  key: KEY,
  fileName: 'requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
  share: { mode: 'all_live_tracks' as const },
  origin: { entryPoint: 'composer' as const, audienceChoice: 'this_thread' as const },
};

const CONVERSATION_ID = 'd0000000-0000-4000-8000-000000000004';
const MESSAGE_ID = 'd0000000-0000-4000-8000-000000000009';

function postedMessage(body: string): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderUserId: USER_ID,
    body,
    sentDuringMeetingId: null,
    requestSharedFileId: 'file-1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
  };
}

const CLIENT_FILE_ROW = {
  id: 'file-1',
  fileName: 'requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
  side: 'client',
  audience: 'all_live_tracks',
  expertRelationshipId: null,
  createdAt: CREATED_AT,
  deletedAt: null,
  deletedByUserId: null,
};

function clientShareResult(threadBody: string | null): Record<string, unknown> {
  return {
    file: CLIENT_FILE_ROW,
    grants: [],
    resolvedLiveTracks: [
      { relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID, via: 'all_live_tracks' },
    ],
    threadMessages:
      threadBody === null
        ? []
        : [
            {
              relationshipId: REL_ID,
              conversationId: CONVERSATION_ID,
              message: postedMessage(threadBody),
            },
          ],
  };
}

describe('confirmRequestFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockSend.mockResolvedValue({ ContentLength: 1234, ContentType: 'application/pdf' });
    mockLoadTrackDisplays.mockResolvedValue([]);
  });

  it('denies when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));
    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects an invalid upload key (wrong provenance)', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    const result = await confirmRequestFileUploadAction({
      ...VALID_CLIENT_INPUT,
      key: `request-files/other-request/${USER_ID}/${FILE_UUID}`,
    });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('denies the read-only admin lens', async () => {
    mockAuthorizeScope.mockResolvedValue({ ...CLIENT_SCOPE, side: 'admin' });
    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);
    expect(result).toEqual({ success: false, error: 'These files are no longer available.' });
  });

  it('shares to all_live_tracks for a client, publishing per resolved track', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockShare.mockResolvedValue({
      file: {
        id: 'file-1',
        fileName: 'requirements.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        side: 'client',
        audience: 'all_live_tracks',
        expertRelationshipId: null,
        createdAt: CREATED_AT,
        deletedAt: null,
        deletedByUserId: null,
      },
      grants: [],
      threadMessages: [],
      resolvedLiveTracks: [
        { relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID, via: 'all_live_tracks' },
      ],
    });

    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);
    expect(result.success).toBe(true);
    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'client',
        audience: 'all_live_tracks',
        expertRelationshipId: null,
        grantRelationshipIds: [],
      })
    );
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'request_file.shared_with_expert',
      expect.objectContaining({ relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID })
    );
    expect(mockTrack).toHaveBeenCalledWith(
      'request_file_uploaded',
      expect.objectContaining({ uploader_side: 'client', track_count: 1 })
    );
  });

  /**
   * ⚠ THE GRANTS ARM RETURNS THE AUDIENCE IT ACTUALLY WROTE. The view handed back to the panel
   * is built from `shareResult.grants` — the rows the repository committed — not from what the
   * caller asked for. A grants share that the repository narrowed (a de-duplicated or dropped
   * target) must therefore be reported as narrowed, so the client's badge matches the database.
   */
  it('returns a grants-mode view built from the grants actually written', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockLoadTrackDisplays.mockResolvedValue([
      { relationshipId: REL_ID, trackName: 'Wei', access: { kind: 'live' } },
    ]);
    mockShare.mockResolvedValue({
      file: {
        id: 'file-3',
        fileName: 'nda.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1234,
        side: 'client',
        audience: 'grants',
        expertRelationshipId: null,
        createdAt: CREATED_AT,
        deletedAt: null,
        deletedByUserId: null,
      },
      grants: [{ relationshipId: REL_ID }],
      threadMessages: [],
      resolvedLiveTracks: [
        { relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID, via: 'grant' },
      ],
    });

    const result = await confirmRequestFileUploadAction({
      ...VALID_CLIENT_INPUT,
      share: { mode: 'grants', relationshipIds: [REL_ID] },
    });

    expect(result.success).toBe(true);
    const audience = result.success ? (result.view as { audience?: unknown }).audience : undefined;
    expect(audience).toEqual({
      type: 'grants',
      grants: [{ relationshipId: REL_ID, trackName: 'Wei' }],
    });
  });

  it('forces audience=own_track and ignores the caller-supplied `share` field on the expert side', async () => {
    mockAuthorizeScope.mockResolvedValue(EXPERT_SCOPE);
    mockShare.mockResolvedValue({
      file: {
        id: 'file-2',
        fileName: 'proposal.pdf',
        contentType: 'application/pdf',
        sizeBytes: 500,
        side: 'expert',
        audience: 'own_track',
        expertRelationshipId: REL_ID,
        createdAt: CREATED_AT,
        deletedAt: null,
        deletedByUserId: null,
      },
      grants: [],
      threadMessages: [],
      resolvedLiveTracks: [
        { relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID, via: 'own_track' },
      ],
    });

    const result = await confirmRequestFileUploadAction({
      ...VALID_CLIENT_INPUT,
      // Attempts to claim a grants share naming a foreign relationship — must be discarded.
      share: { mode: 'grants', relationshipIds: [REL_ID] },
    });
    expect(result.success).toBe(true);
    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'expert',
        audience: 'own_track',
        expertRelationshipId: REL_ID,
        grantRelationshipIds: [],
      })
    );
    expect(mockPublish).toHaveBeenCalledWith(
      'request_file.shared_with_client',
      expect.objectContaining({ recipientId: 'client-user' })
    );
  });

  it('maps a duplicate r2Key (23505) to friendly copy', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockShare.mockRejectedValue({ code: '23505' });
    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);
    expect(result).toEqual({ success: false, error: 'This file was already shared.' });
  });

  /**
   * ⚠ THE EXPERT ARM OF THE GATE — SECOND PERSON. `side === 'expert'` means the READER is the
   * expert whose own track closed, so the copy addresses them directly. Paired deliberately
   * with the client-arm test below, which pins the THIRD-person copy: the two sit on opposite
   * sides of the same file and must never be unified into one string.
   */
  it('denies an expert whose own track is closed, in SECOND person', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ...EXPERT_SCOPE,
      viewer: { ...EXPERT_SCOPE.viewer, access: { kind: 'closed', closedAt: new Date() } },
    });
    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You can no longer share files on this request.',
    });
    expect(result.success === false && result.error).not.toContain('That expert');
    expect(mockShare).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THIRD PERSON, AND IT MUST STAY THAT WAY. `RequestFileTrackNotLiveError` is raised only
   * when a CLIENT named a closed track in a `grants` share — the reader is the client, being
   * told about SOMEONE ELSE. This is the counterpart of the expert-arm test above; collapsing
   * either into the other reintroduces the bug in one direction or the other.
   */
  it('maps a closed grant target to friendly THIRD-person copy for the client', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockShare.mockRejectedValue(new MockTrackNotLiveError(REL_ID));
    const result = await confirmRequestFileUploadAction({
      ...VALID_CLIENT_INPUT,
      share: { mode: 'grants', relationshipIds: [REL_ID] },
    });
    expect(result).toEqual({
      success: false,
      error: 'That expert is no longer on this request.',
    });
    expect(result.success === false && result.error).not.toContain('You can no longer');
  });

  /**
   * ⚠ THE HEAD-OBJECT RE-VERIFICATION. The presigned PUT is signed with a ContentLength
   * condition, but the object's REAL content type and byte count are only knowable once it has
   * landed — so confirm re-reads them from R2 and refuses to create a share row for anything
   * outside the allow-list. Each refusal must ALSO destroy the orphan: leaving it costs storage
   * forever and strands an unreferenced blob in the bucket.
   */
  describe('re-verifies the uploaded object before creating any share row', () => {
    it.each([
      {
        name: 'a zero-byte object',
        head: { ContentLength: 0, ContentType: 'application/pdf' },
        error: 'The uploaded file appears to be empty.',
      },
      {
        name: 'an object with no reported length',
        head: { ContentType: 'application/pdf' },
        error: 'The uploaded file appears to be empty.',
      },
      {
        name: 'an object above the size ceiling',
        head: { ContentLength: 10 * 1024 * 1024 + 1, ContentType: 'application/pdf' },
        error: 'Uploaded file is too large. Please try a smaller file.',
      },
      {
        name: 'an object whose real content type is not allowed',
        head: { ContentLength: 1234, ContentType: 'application/x-msdownload' },
        error: 'This file type is not supported.',
      },
    ])('refuses $name, and deletes the orphan', async ({ head, error }) => {
      mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
      mockSend.mockResolvedValue(head);

      const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);

      expect(result).toEqual({ success: false, error });
      expect(mockShare).not.toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledWith(KEY);
    });

    /**
     * ⚠ R2's REPORTED TYPE WINS OVER THE CALLER'S CLAIM. Someone who claims `application/pdf`
     * for an executable must be refused on what actually landed, never on what they said.
     */
    it('trusts R2’s content type over the caller’s claim', async () => {
      mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
      mockSend.mockResolvedValue({ ContentLength: 1234, ContentType: 'application/x-msdownload' });

      const result = await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        contentType: 'application/pdf',
      });

      expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
      expect(mockShare).not.toHaveBeenCalled();
    });

    /** With no type reported by R2 the caller's claim is the fallback — and is still checked. */
    it('falls back to the claimed type when R2 reports none, and still enforces the allow-list', async () => {
      mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
      mockSend.mockResolvedValue({ ContentLength: 1234 });

      const result = await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        contentType: 'application/x-msdownload',
      });

      expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
      expect(mockShare).not.toHaveBeenCalled();
    });
  });

  it('rejects structurally invalid input before touching R2 or the repository', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    const result = await confirmRequestFileUploadAction({
      ...VALID_CLIENT_INPUT,
      requestId: 'not-a-uuid',
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
  });

  /** A denied scope reads exactly like every other denial — probing learns nothing. */
  it('denies a caller the scope gate refused, with the neutral copy', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: false });
    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);
    expect(result).toEqual({ success: false, error: 'These files are no longer available.' });
    expect(mockShare).not.toHaveBeenCalled();
  });

  /**
   * ⚠ AN UNEXPECTED REPOSITORY FAILURE IS NOT A SUCCESS. The generic catch must return a
   * failure — never fall through — and must not leak the underlying error text to the caller.
   */
  it('maps an unexpected repository failure to generic copy, leaking no internals', async () => {
    mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    mockShare.mockRejectedValue(new Error('deadlock detected on request_file_grants'));

    const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);

    expect(result.success).toBe(false);
    expect(result.success === false && result.error).not.toContain('deadlock');
  });

  // ── BAL-617: the note, the card messages, the realtime ping ──

  describe('share note and card messages', () => {
    beforeEach(() => {
      mockAuthorizeScope.mockResolvedValue(CLIENT_SCOPE);
    });

    it('passes a sanitised note as threadMessageBody on every share', async () => {
      mockShare.mockResolvedValue(clientShareResult('<p>Here you go</p>'));

      await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        note: '  Here you go  ',
      });

      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({ threadMessageBody: '<p>Here you go</p>' })
      );
    });

    it('escapes markup in the note before it reaches the repository', async () => {
      mockShare.mockResolvedValue(clientShareResult(''));

      await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        note: '<script>alert(1)</script>hi',
      });

      const body = (mockShare.mock.calls[0]?.[0] as { threadMessageBody: string })
        .threadMessageBody;
      expect(body).not.toContain('<script');
    });

    it.each([undefined, '', '   \n  '])('passes an empty body for the note %j', async (note) => {
      mockShare.mockResolvedValue(clientShareResult(null));

      await confirmRequestFileUploadAction({ ...VALID_CLIENT_INPUT, note });

      expect(mockShare).toHaveBeenCalledWith(expect.objectContaining({ threadMessageBody: '' }));
    });

    it('rejects an over-long note BEFORE touching R2, so the upload survives for a retry', async () => {
      const result = await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        note: 'x'.repeat(4001),
      });

      expect(result).toEqual({
        success: false,
        error: 'Keep your note under 4000 characters.',
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockShare).not.toHaveBeenCalled();
    });

    it('returns one sender-lens card message per posted thread message', async () => {
      mockLoadTrackDisplays.mockResolvedValue([
        { relationshipId: REL_ID, trackName: 'Wei', access: { kind: 'live' } },
      ]);
      mockShare.mockResolvedValue(clientShareResult('<p>Here you go</p>'));

      const result = await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        note: 'Here you go',
      });

      if (!result.success) throw new Error('expected success');
      expect(result.threadMessages).toHaveLength(1);
      const [entry] = result.threadMessages;
      expect(entry?.relationshipId).toBe(REL_ID);
      expect(entry?.message).toMatchObject({
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        bodyHtml: '<p>Here you go</p>',
        senderUserId: USER_ID,
        senderName: 'Sarah Chen',
      });
      expect(entry?.message.requestSharedFile).toEqual({ kind: 'client', file: result.view });
    });

    it('returns no card messages when no receiving track has an open thread', async () => {
      mockShare.mockResolvedValue(clientShareResult(null));

      const result = await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);

      expect(result.success && result.threadMessages).toEqual([]);
      expect(mockPublishConversationEvent).not.toHaveBeenCalled();
    });

    /**
     * ⚠ AC6. A share notifies through `request_file.shared_with_*` ALONE. A `file_shared` ping is
     * published once per posted card, content-free, and `conversation.message_posted` is never
     * published — the recipient must not be told twice.
     */
    it('publishes the content-free file_shared ping once per posted card, and never message_posted', async () => {
      mockShare.mockResolvedValue({
        ...clientShareResult('<p>Here you go</p>'),
        threadMessages: [
          {
            relationshipId: REL_ID,
            conversationId: CONVERSATION_ID,
            message: postedMessage('<p>Here you go</p>'),
          },
          {
            relationshipId: 'b0000000-0000-4000-8000-000000000099',
            conversationId: 'd0000000-0000-4000-8000-000000000098',
            message: {
              ...postedMessage('<p>Here you go</p>'),
              id: 'd0000000-0000-4000-8000-000000000097',
              conversationId: 'd0000000-0000-4000-8000-000000000098',
            },
          },
        ],
      });

      await confirmRequestFileUploadAction({ ...VALID_CLIENT_INPUT, note: 'Here you go' });

      expect(mockPublishConversationEvent).toHaveBeenCalledTimes(2);
      expect(mockPublishConversationEvent).toHaveBeenNthCalledWith(
        1,
        CONVERSATION_ID,
        'file_shared',
        {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          senderUserId: USER_ID,
          createdAtIso: CREATED_AT.toISOString(),
        }
      );
      for (const [, name, payload] of mockPublishConversationEvent.mock.calls) {
        expect(name).not.toBe('message');
        expect(Object.keys(payload as object).sort()).toEqual([
          'conversationId',
          'createdAtIso',
          'messageId',
          'senderUserId',
        ]);
      }
      const events = mockPublish.mock.calls.map(([event]) => event);
      expect(events).not.toContain('conversation.message_posted');
      expect(events).toEqual(['request_file.shared_with_expert']);
    });

    it('adds a truncated plain-text noteExcerpt to the notification when there is a note', async () => {
      mockShare.mockResolvedValue(clientShareResult(null));

      await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        note: 'y'.repeat(300),
      });

      const payload = mockPublish.mock.calls[0]?.[1] as { noteExcerpt?: string };
      expect(typeof payload.noteExcerpt).toBe('string');
      expect((payload.noteExcerpt ?? '').length).toBeLessThanOrEqual(200);
      expect(payload.noteExcerpt).not.toContain('<');
    });

    it('omits noteExcerpt from the notification when there is no note', async () => {
      mockShare.mockResolvedValue(clientShareResult(null));

      await confirmRequestFileUploadAction(VALID_CLIENT_INPUT);

      expect(mockPublish.mock.calls[0]?.[1]).not.toHaveProperty('noteExcerpt');
    });

    it('records the entry point, audience choice and has_note on the uploaded event', async () => {
      mockShare.mockResolvedValue(clientShareResult(null));

      await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        note: 'hello',
        origin: { entryPoint: 'drop', audienceChoice: 'specific' },
      });

      expect(mockTrack).toHaveBeenCalledWith(
        'request_file_uploaded',
        expect.objectContaining({
          entry_point: 'drop',
          audience_choice: 'specific',
          has_note: true,
        })
      );
    });

    it('rejects an unknown origin value as invalid input', async () => {
      const result = await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        origin: { entryPoint: 'bogus' as never, audienceChoice: 'this_thread' },
      });

      expect(result).toEqual({ success: false, error: 'Invalid request.' });
      expect(mockShare).not.toHaveBeenCalled();
    });

    it('expert arm: coerces audience_choice to this_thread and returns an audience-free card', async () => {
      mockAuthorizeScope.mockResolvedValue(EXPERT_SCOPE);
      mockShare.mockResolvedValue({
        file: {
          ...CLIENT_FILE_ROW,
          side: 'expert',
          audience: 'own_track',
          expertRelationshipId: REL_ID,
        },
        grants: [],
        resolvedLiveTracks: [
          { relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID, via: 'own_track' },
        ],
        threadMessages: [
          {
            relationshipId: REL_ID,
            conversationId: CONVERSATION_ID,
            message: postedMessage(''),
          },
        ],
      });

      const result = await confirmRequestFileUploadAction({
        ...VALID_CLIENT_INPUT,
        origin: { entryPoint: 'composer', audienceChoice: 'all_live_tracks' },
      });

      expect(mockTrack).toHaveBeenCalledWith(
        'request_file_uploaded',
        expect.objectContaining({ audience_choice: 'this_thread' })
      );
      if (!result.success) throw new Error('expected success');
      const card = result.threadMessages[0]?.message.requestSharedFile;
      expect(card?.kind).toBe('expert');
      expect(JSON.stringify(result)).not.toContain('audience');
      expect(JSON.stringify(result)).not.toContain('visibleToLiveTrackIds');
    });
  });
});
