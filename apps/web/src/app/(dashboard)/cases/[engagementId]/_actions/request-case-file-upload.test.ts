import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for step 1 of the case surface's file share (presign → PUT → confirm).
 *
 * ⚠⚠ SHARING A FILE INTO A CASE IS A **WRITE**, and every property below follows from that:
 * it authenticates with `requireOnboardedUser()` (never the read-only helper), it refuses a
 * CLOSED case, and it hands the presigner nothing the caller supplied — the R2 key is scoped
 * to the GATE's conversation and the SESSION's user.
 *
 * ⚠ THE CONTENT-TYPE ALLOW-LIST COMES FROM SOURCE. The happy path uses real members of
 * `CONVERSATION_ALLOWED_CONTENT_TYPES`, so removing or renaming one fails HERE instead of
 * leaving a green suite asserting a type the storage layer would reject.
 */

const ENGAGEMENT_ID = 'e2000000-0000-4000-8000-000000000001';
const USER_ID = 'u2000000-0000-4000-8000-000000000002';
/** The thread the GATE resolves. Nothing in the input can name it. */
const GATE_CONVERSATION_ID = 'k2000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
  requireUser: () => mockRequireUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockPresignUpload = vi.fn();
// ⚠ The allow-list is re-exported from ITS OWN client-safe module rather than restated, so the
// suite and production consult the SAME Set. Only the presigner is stubbed (it reaches AWS).
vi.mock('@/lib/storage/conversation-file', async () => {
  const constraints = await import('@/lib/storage/conversation-file-constraints');
  return {
    CONVERSATION_ALLOWED_CONTENT_TYPES: constraints.CONVERSATION_ALLOWED_CONTENT_TYPES,
    createPresignedConversationFileUpload: (...a: unknown[]) => mockPresignUpload(...a),
  };
});

import { requestCaseFileUploadAction } from './request-case-file-upload';
import { CONVERSATION_ALLOWED_CONTENT_TYPES } from '@/lib/storage/conversation-file';
import { log } from '@/lib/logging';

type UploadInput = Parameters<typeof requestCaseFileUploadAction>[0];

/** The `.strict()` shapes worth testing are the ones TypeScript already refuses to build. */
function asInput(value: Record<string, unknown>): UploadInput {
  return value as unknown as UploadInput;
}

const ALLOWED_TYPES = [...CONVERSATION_ALLOWED_CONTENT_TYPES];
const [FIRST_ALLOWED_TYPE] = ALLOWED_TYPES;
if (FIRST_ALLOWED_TYPE === undefined) {
  throw new Error('CONVERSATION_ALLOWED_CONTENT_TYPES is empty — nothing could ever be shared');
}

const VALID_INPUT: UploadInput = {
  engagementId: ENGAGEMENT_ID,
  contentType: FIRST_ALLOWED_TYPE,
  fileName: 'requirements.pdf',
};

const ACCESS = {
  lens: 'client',
  engagementId: ENGAGEMENT_ID,
  companyId: 'c2000000-0000-4000-8000-000000000004',
  expertProfileId: 'p2000000-0000-4000-8000-000000000005',
  engagementStatus: 'active',
  conversationId: GATE_CONVERSATION_ID,
  conversationWritable: true,
};

const PRESIGNED = {
  presignedUrl: 'https://signed.example/put',
  key: `conversation-files/${GATE_CONVERSATION_ID}/${USER_ID}/generated-uuid`,
};

function errorOf(
  result: { success: true; presignedUrl: string; key: string } | { success: false; error: string }
): string {
  if (result.success) {
    throw new Error('expected a refusal, got a presigned PUT');
  }
  return result.error;
}

function seed(): void {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockPresignUpload.mockResolvedValue(PRESIGNED);
}

beforeEach(() => {
  seed();
});

describe('requestCaseFileUploadAction — the gates, in order', () => {
  /**
   * ⚠ THE ONBOARDED HELPER, NOT THE BARE ONE. Every mutating web action goes through
   * `requireOnboardedUser()` — a Server Action bypasses middleware, so there is nothing else.
   */
  it('refuses an unauthenticated caller and never reaches the case gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Onboarding not completed'));
    const result = await requestCaseFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPresignUpload).not.toHaveBeenCalled();
  });

  it('never falls back to the read-only session helper', async () => {
    await requestCaseFileUploadAction(VALID_INPUT);
    expect(mockRequireOnboardedUser).toHaveBeenCalledTimes(1);
    expect(mockRequireUser).not.toHaveBeenCalled();
  });

  it('rejects a malformed engagementId before the gate', async () => {
    const result = await requestCaseFileUploadAction({ ...VALID_INPUT, engagementId: 'nope' });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
  });

  it('rejects an EXTRA key and an empty fileName alike (.strict())', async () => {
    const smuggled = await requestCaseFileUploadAction(
      asInput({ ...VALID_INPUT, conversationId: GATE_CONVERSATION_ID })
    );
    const blankName = await requestCaseFileUploadAction({ ...VALID_INPUT, fileName: '   ' });
    expect(errorOf(smuggled)).toBe('Invalid request.');
    expect(errorOf(blankName)).toBe('Invalid request.');
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockPresignUpload).not.toHaveBeenCalled();
  });

  it('re-runs the case gate with the session user, never a caller-supplied id', async () => {
    await requestCaseFileUploadAction(VALID_INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('refuses a gate denial with the case literal and never presigns', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    const result = await requestCaseFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This case is no longer available.' });
    expect(mockPresignUpload).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ A CLOSED CASE STAYS FULLY READABLE AND IS NOT WRITABLE. `conversationWritable` is composed
 * ONCE at the gate and never re-derived here, so this is the single place the rule is enforced
 * on the upload path.
 */
describe('requestCaseFileUploadAction — writability', () => {
  it('refuses a read-only conversation with its own honest copy, and never presigns', async () => {
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, conversationWritable: false });
    const result = await requestCaseFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'This case is closed, so the conversation is read-only.',
    });
    expect(mockPresignUpload).not.toHaveBeenCalled();
  });

  /**
   * ORDER MATTERS: a closed case answers "closed" even when the content type is also junk, so
   * the read-only refusal can never be masked by a validation message.
   */
  it('reports the closed case ahead of an unsupported content type', async () => {
    mockResolveCaseAccess.mockResolvedValue({ ...ACCESS, conversationWritable: false });
    const result = await requestCaseFileUploadAction({
      ...VALID_INPUT,
      contentType: 'application/x-msdownload',
    });
    expect(errorOf(result)).toBe('This case is closed, so the conversation is read-only.');
  });
});

describe('requestCaseFileUploadAction — the content-type allow-list', () => {
  it('refuses a type outside the shipped allow-list, and never presigns', async () => {
    const result = await requestCaseFileUploadAction({
      ...VALID_INPUT,
      contentType: 'application/x-msdownload',
    });
    expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
    expect(mockPresignUpload).not.toHaveBeenCalled();
  });

  it('accepts EVERY member of the real allow-list', async () => {
    for (const contentType of ALLOWED_TYPES) {
      seed();
      const result = await requestCaseFileUploadAction({ ...VALID_INPUT, contentType });
      expect(result).toMatchObject({ success: true });
    }
    expect(ALLOWED_TYPES.length).toBeGreaterThan(1);
  });
});

describe('requestCaseFileUploadAction — the presigned PUT', () => {
  it('returns the presigned URL and key verbatim', async () => {
    const result = await requestCaseFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: true, ...PRESIGNED });
  });

  /**
   * ⚠⚠ THE KEY IS SCOPED TO THE GATE'S CONVERSATION AND THE SESSION'S USER. The action passes
   * `access.conversationId` — which the input cannot name — and `user.id`, so a caller has no
   * way to write an object into another case's key space.
   */
  it('scopes the key to the GATE conversation and the SESSION user', async () => {
    await requestCaseFileUploadAction(VALID_INPUT);
    expect(mockPresignUpload).toHaveBeenCalledWith(
      GATE_CONVERSATION_ID,
      USER_ID,
      FIRST_ALLOWED_TYPE
    );
    expect(mockPresignUpload).toHaveBeenCalledTimes(1);
  });

  it('logs and returns friendly copy when the presigner throws', async () => {
    mockPresignUpload.mockRejectedValue(new Error('R2 down'));
    const result = await requestCaseFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: "File sharing isn't available right now." });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to presign case file upload',
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        contentType: FIRST_ALLOWED_TYPE,
        error: 'R2 down',
      })
    );
  });
});
