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
  viewer: { relationshipId: REL_ID, expertProfileId: EXPERT_PROFILE_ID, access: { kind: 'live' } },
};

const VALID_CLIENT_INPUT = {
  requestId: REQUEST_ID,
  key: KEY,
  fileName: 'requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
  share: { mode: 'all_live_tracks' as const },
};

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
});
