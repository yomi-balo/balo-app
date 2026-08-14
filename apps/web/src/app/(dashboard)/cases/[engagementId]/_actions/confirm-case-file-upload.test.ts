import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for confirming a file uploaded into a CASE's conversation (step 3 of
 * presign → PUT → confirm).
 *
 * ⚠⚠ `_lib/case-conversation-notify.ts` IS DELIBERATELY **REAL** HERE, for the same reason it is
 * real in `post-case-message.test.ts`: the claim worth testing is that a POST-COMMIT recipient
 * failure does not surface as "could not share" for a file the uploader can already SEE. That
 * guard lives inside `resolveCaseNotifyContext`, so the rejection is injected at its true source
 * (`companiesRepository.findOwnerUserIdByCompanyId`) and observed through the ACTION's return.
 *
 * The content-type allow-list and the size cap are imported FROM SOURCE
 * (`storage/conversation-file-constraints`) rather than restated, so a change there fails here
 * instead of leaving a green suite asserting a dead rule.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
// ⚠ HEX-ONLY, DELIBERATELY. `CONVERSATION_FILE_KEY_PATTERN` matches `[0-9a-f-]{36}` per
// segment, so a placeholder id containing a non-hex letter would fail key validation and make
// every happy-path test below refuse for the wrong reason.
const USER_ID = 'dddddddd-1111-4222-8333-444444444444';
const COMPANY_ID = 'c0000000-0000-4000-8000-000000000003';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000004';
const CONVERSATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OWNER_ID = 'o0000000-0000-4000-8000-000000000006';
const FILE_ROW_ID = 'f0000000-0000-4000-8000-000000000007';
const OBJECT_UUID = '11111111-2222-4333-8444-555555555555';
const CREATED_AT = new Date('2026-08-12T09:00:00Z');

/** The one key shape the action accepts: `conversation-files/{conversationId}/{userId}/{uuid}`. */
const VALID_KEY = `conversation-files/${CONVERSATION_ID}/${USER_ID}/${OBJECT_UUID}`;

vi.mock('server-only', () => ({}));

const mockAddFile = vi.fn();
const mockMarkThreadRead = vi.fn();
const mockFindCase = vi.fn();
const mockFindOwner = vi.fn();

vi.mock('@balo/db', () => ({
  conversationsRepository: {
    addFile: (...a: unknown[]) => mockAddFile(...a),
    markThreadRead: (...a: unknown[]) => mockMarkThreadRead(...a),
  },
  caseEngagementsRepository: { findByEngagementId: (...a: unknown[]) => mockFindCase(...a) },
  companiesRepository: { findOwnerUserIdByCompanyId: (...a: unknown[]) => mockFindOwner(...a) },
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

const mockR2Send = vi.fn();
vi.mock('@/lib/storage/r2', () => ({
  r2Client: { send: (...a: unknown[]) => mockR2Send(...a) },
  R2_BUCKET: 'balo-test-bucket',
}));

// `HeadObjectCommand` is captured so the HEAD target can be asserted without a live SDK.
vi.mock('@aws-sdk/client-s3', () => ({
  HeadObjectCommand: class {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  },
}));

// The real constants, with ONLY the R2 delete stubbed — a rejected upload is best-effort
// cleaned up, and that call is an assertion target rather than something to really perform.
const mockDeleteFromR2 = vi.fn();
vi.mock('@/lib/storage/conversation-file', async () => {
  const constraints = await import('@/lib/storage/conversation-file-constraints');
  return {
    CONVERSATION_FILE_PREFIX: 'conversation-files/',
    CONVERSATION_ALLOWED_CONTENT_TYPES: constraints.CONVERSATION_ALLOWED_CONTENT_TYPES,
    MAX_CONVERSATION_FILE_BYTES: constraints.MAX_CONVERSATION_FILE_BYTES,
    deleteConversationFileFromR2: (...a: unknown[]) => {
      mockDeleteFromR2(...a);
      return Promise.resolve();
    },
  };
});

import { confirmCaseFileUploadAction } from './confirm-case-file-upload';
import { log } from '@/lib/logging';
import { MAX_CONVERSATION_FILE_BYTES } from '@/lib/storage/conversation-file-constraints';

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

const INPUT = {
  engagementId: ENGAGEMENT_ID,
  key: VALID_KEY,
  fileName: 'flow-diagram.pdf',
  contentType: 'application/pdf',
  sizeBytes: 4096,
};

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
  mockR2Send.mockResolvedValue({ ContentLength: 4096, ContentType: 'application/pdf' });
  mockAddFile.mockResolvedValue({
    id: FILE_ROW_ID,
    fileName: 'flow-diagram.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4096,
    createdAt: CREATED_AT,
  });
  mockMarkThreadRead.mockResolvedValue({ lastReadAt: CREATED_AT });
  mockFindCase.mockResolvedValue({ title: 'Flow interview loop' });
  mockFindOwner.mockResolvedValue(OWNER_ID);
}

beforeEach(() => {
  seed();
});

describe('confirmCaseFileUploadAction — the gates run before any R2 work', () => {
  it('goes through requireOnboardedUser BEFORE the tenancy gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockR2Send).not.toHaveBeenCalled();
  });

  it('rejects malformed input before any gate call', async () => {
    expect(await confirmCaseFileUploadAction({ ...INPUT, engagementId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('rejects a negative size — the schema requires a non-negative integer', async () => {
    expect(await confirmCaseFileUploadAction({ ...INPUT, sizeBytes: -1 })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockR2Send).not.toHaveBeenCalled();
  });

  /**
   * ⚠ A DENIAL IS INDISTINGUISHABLE FROM NOT-FOUND, and no R2 call is made on the way to it —
   * the gate is not merely consulted, it is a precondition for touching storage at all.
   */
  it('refuses a gate denial with NO R2 call and NO row written', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer available.',
    });
    expect(mockR2Send).not.toHaveBeenCalled();
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('refuses a CLOSED case — sharing a file is a write', async () => {
    mockResolveCaseAccess.mockResolvedValue(access({ conversationWritable: false }));
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'This case is closed, so the conversation is read-only.',
    });
    expect(mockR2Send).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE WHOLE IDOR STORY FOR `key`. The expected prefix is rebuilt from the VALIDATED gate's
 * conversation and the SESSION's user — two values the caller does not control — so a key
 * naming someone else's thread is refused before any row is written.
 */
describe('confirmCaseFileUploadAction — key shape and provenance', () => {
  it('refuses a key pointing at ANOTHER conversation, before any write', async () => {
    const foreign = `conversation-files/99999999-8888-4777-8666-555555555555/${USER_ID}/${OBJECT_UUID}`;
    expect(await confirmCaseFileUploadAction({ ...INPUT, key: foreign })).toEqual({
      success: false,
      error: 'Invalid upload key.',
    });
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('refuses a key attributed to ANOTHER user', async () => {
    const foreign = `conversation-files/${CONVERSATION_ID}/99999999-8888-4777-8666-555555555555/${OBJECT_UUID}`;
    const result = await confirmCaseFileUploadAction({ ...INPUT, key: foreign });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockR2Send).not.toHaveBeenCalled();
  });

  it('refuses a structurally wrong key (traversal / wrong prefix)', async () => {
    const result = await confirmCaseFileUploadAction({
      ...INPUT,
      key: `meeting-files/${CONVERSATION_ID}/${USER_ID}/${OBJECT_UUID}`,
    });
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('validates the key against the GATE conversation, not the one in the key', async () => {
    // The gate resolves a DIFFERENT conversation than the key names, so the key must lose.
    mockResolveCaseAccess.mockResolvedValue(
      access({ conversationId: '77777777-6666-4555-8444-333333333333' })
    );
    const result = await confirmCaseFileUploadAction(INPUT);
    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
  });
});

describe('confirmCaseFileUploadAction — the object is re-verified AT THE SOURCE', () => {
  it('HEADs the exact key in the configured bucket', async () => {
    await confirmCaseFileUploadAction(INPUT);
    const [call] = mockR2Send.mock.calls;
    if (call === undefined) throw new Error('no HEAD was issued');
    const [command] = call as [{ input: Record<string, unknown> }];
    expect(command.input).toEqual({ Bucket: 'balo-test-bucket', Key: VALID_KEY });
  });

  it('rejects an EMPTY object with its own copy, and cleans up the orphan', async () => {
    mockR2Send.mockResolvedValue({ ContentLength: 0, ContentType: 'application/pdf' });
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'The uploaded file appears to be empty.',
    });
    expect(mockDeleteFromR2).toHaveBeenCalledWith(VALID_KEY);
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('rejects an object with no reported length at all', async () => {
    mockR2Send.mockResolvedValue({ ContentType: 'application/pdf' });
    const result = await confirmCaseFileUploadAction(INPUT);
    expect(result).toEqual({ success: false, error: 'The uploaded file appears to be empty.' });
  });

  /** ⚠ EMPTY AND OVER-CAP ARE DIFFERENT FAILURES — telling someone their empty file is "too
   *  large" is a dead end. Pin that the two copies genuinely differ. */
  it('rejects an OVER-CAP object with DIFFERENT copy from the empty case', async () => {
    mockR2Send.mockResolvedValue({
      ContentLength: MAX_CONVERSATION_FILE_BYTES + 1,
      ContentType: 'application/pdf',
    });
    const tooLarge = await confirmCaseFileUploadAction(INPUT);

    seed();
    mockR2Send.mockResolvedValue({ ContentLength: 0, ContentType: 'application/pdf' });
    const empty = await confirmCaseFileUploadAction(INPUT);

    expect(tooLarge).toEqual({
      success: false,
      error: 'Uploaded file is too large. Please try a smaller file.',
    });
    expect(tooLarge).not.toEqual(empty);
  });

  it('accepts an object exactly AT the cap — the bound is inclusive', async () => {
    mockR2Send.mockResolvedValue({
      ContentLength: MAX_CONVERSATION_FILE_BYTES,
      ContentType: 'application/pdf',
    });
    mockAddFile.mockResolvedValue({
      id: FILE_ROW_ID,
      fileName: 'flow-diagram.pdf',
      contentType: 'application/pdf',
      sizeBytes: MAX_CONVERSATION_FILE_BYTES,
      createdAt: CREATED_AT,
    });
    expect((await confirmCaseFileUploadAction(INPUT)).success).toBe(true);
  });

  it('rejects a disallowed type using R2’s REPORTED type, not the claimed one', async () => {
    // The caller claims an allowed PDF; the object is really an executable.
    mockR2Send.mockResolvedValue({
      ContentLength: 4096,
      ContentType: 'application/x-msdownload',
    });
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'This file type is not supported.',
    });
    expect(mockDeleteFromR2).toHaveBeenCalledWith(VALID_KEY);
    expect(mockAddFile).not.toHaveBeenCalled();
  });

  it('persists the VERIFIED size and type, never the caller-supplied ones', async () => {
    mockR2Send.mockResolvedValue({ ContentLength: 8192, ContentType: 'image/png' });
    await confirmCaseFileUploadAction({ ...INPUT, sizeBytes: 1, contentType: 'application/pdf' });
    expect(mockAddFile).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      uploadedByUserId: USER_ID,
      r2Key: VALID_KEY,
      fileName: 'flow-diagram.pdf',
      contentType: 'image/png',
      sizeBytes: 8192,
    });
  });

  it('falls back to the CLAIMED type when R2 reports none', async () => {
    mockR2Send.mockResolvedValue({ ContentLength: 4096 });
    await confirmCaseFileUploadAction(INPUT);
    expect(mockAddFile).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/pdf' })
    );
  });
});

describe('confirmCaseFileUploadAction — the committed share and its broadcast', () => {
  it('returns the file view built from the STORED row', async () => {
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: true,
      file: {
        id: FILE_ROW_ID,
        conversationId: CONVERSATION_ID,
        fileName: 'flow-diagram.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4096,
        uploadedByUserId: USER_ID,
        uploadedByName: 'Dana Whitfield',
        createdAtIso: CREATED_AT.toISOString(),
      },
    });
  });

  it('falls back to a neutral uploader label when the user has no name on file', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
    const result = await confirmCaseFileUploadAction(INPUT);
    expect(result).toMatchObject({ file: { uploadedByName: 'Participant' } });
  });

  it('broadcasts the SAME view it returns, on the file channel', async () => {
    const result = await confirmCaseFileUploadAction(INPUT);
    if (!result.success) throw new Error('expected the share to succeed');
    expect(mockPublishConversationEvent).toHaveBeenCalledWith(CONVERSATION_ID, 'file', result.file);
  });

  it('a WATERMARK failure never fails the share', async () => {
    mockMarkThreadRead.mockRejectedValue(new Error('db blip'));
    expect((await confirmCaseFileUploadAction(INPUT)).success).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  /** A double confirm trips `conversation_file_key_idx` — EXPECTED, so warn rather than error. */
  it('reports a duplicate confirm as "already shared" and warns rather than errors', async () => {
    mockAddFile.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'This file was already shared.',
    });
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('treats a non-unique-violation failure as a real error', async () => {
    mockAddFile.mockRejectedValue(new Error('disk full'));
    expect(await confirmCaseFileUploadAction(INPUT)).toEqual({
      success: false,
      error: 'Could not share your file. Please try again.',
    });
    expect(log.error).toHaveBeenCalled();
    expect(mockPublishConversationEvent).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE POST-COMMIT GUARD. The `conversation_files` row is persisted and the Ably event is
 * already on the wire, so a recipient-lookup rejection must degrade to NO fan-out — never to
 * "could not share" for a file the uploader can SEE in the panel, whose retry would trip
 * `conversation_file_key_idx` and report "already shared".
 */
describe('confirmCaseFileUploadAction — a post-commit failure must NOT surface as "could not share"', () => {
  it('still returns SUCCESS when recipient resolution REJECTS, and publishes nothing', async () => {
    seed({ access: { lens: 'expert' } });
    mockFindOwner.mockRejectedValue(new Error('connection terminated'));

    const result = await confirmCaseFileUploadAction(INPUT);

    expect(result).toMatchObject({ success: true, file: { id: FILE_ROW_ID } });
    expect(mockPublishNotification).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Case notify target resolution failed after commit — no fan-out',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, conversationId: CONVERSATION_ID })
    );
  });

  it('degrades a failed TITLE read to a neutral label rather than dropping the notification', async () => {
    mockFindCase.mockRejectedValue(new Error('read timeout'));
    const result = await confirmCaseFileUploadAction(INPUT);
    expect(result.success).toBe(true);
    expect(notifiedPayload().title).toBe('your case');
  });

  it('publishes conversation.file_shared on the ENGAGEMENT arm, keyed by the file row id', async () => {
    await confirmCaseFileUploadAction(INPUT);
    const [call] = mockPublishNotification.mock.calls;
    if (call === undefined) throw new Error('publishNotificationEvent was never called');
    const [event] = call as [string];
    expect(event).toBe('conversation.file_shared');
    expect(notifiedPayload()).toMatchObject({
      correlationId: FILE_ROW_ID,
      conversationId: CONVERSATION_ID,
      contextType: 'engagement',
      contextId: ENGAGEMENT_ID,
      engagementId: ENGAGEMENT_ID,
      fileName: 'flow-diagram.pdf',
      recipientRole: 'expert',
      expertProfileId: PROFILE_ID,
    });
  });

  it('carries the STORED file name, never the caller-supplied one, and no email anywhere', async () => {
    mockAddFile.mockResolvedValue({
      id: FILE_ROW_ID,
      fileName: 'sanitised-name.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
      createdAt: CREATED_AT,
    });
    await confirmCaseFileUploadAction({ ...INPUT, fileName: 'attacker-supplied.pdf' });
    expect(notifiedPayload().fileName).toBe('sanitised-name.pdf');
    expect(JSON.stringify(notifiedPayload())).not.toContain('@');
  });

  it('logs the business event on success', async () => {
    await confirmCaseFileUploadAction(INPUT);
    expect(log.info).toHaveBeenCalledWith(
      'Case conversation file shared',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, fileId: FILE_ROW_ID })
    );
  });
});
