import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';

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

const mockPresign = vi.fn();
vi.mock('@/lib/storage/request-file', () => ({
  REQUEST_FILE_ALLOWED_CONTENT_TYPES: new Set(['application/pdf']),
  MAX_REQUEST_FILE_BYTES: 10 * 1024 * 1024,
  createPresignedRequestFileUpload: (...args: unknown[]) => mockPresign(...args),
}));

import { requestSharedFileUploadAction } from './request-shared-file-upload';

const USER = { id: USER_ID };
const SIZE_BYTES = 24_576;
const VALID_INPUT = {
  requestId: REQUEST_ID,
  contentType: 'application/pdf',
  fileName: 'scope.pdf',
  sizeBytes: SIZE_BYTES,
};

describe('requestSharedFileUploadAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
    mockPresign.mockResolvedValue({ presignedUrl: 'https://signed', key: 'request-files/x/y/z' });
  });

  it('denies when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));
    const result = await requestSharedFileUploadAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('rejects invalid input', async () => {
    const result = await requestSharedFileUploadAction({
      ...VALID_INPUT,
      requestId: 'not-a-uuid',
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
  });

  it('denies when the gate denies', async () => {
    mockAuthorizeScope.mockResolvedValue({ ok: false, code: 'request_files_not_found' });
    const result = await requestSharedFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'These files are no longer available.',
    });
  });

  it('denies the read-only admin lens', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: { id: REQUEST_ID },
      tracks: [],
    });
    const result = await requestSharedFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'These files are no longer available.',
    });
    expect(mockPresign).not.toHaveBeenCalled();
  });

  /**
   * ⚠ SECOND PERSON — THE READER IS THE EXPERT. This arm is reached only when the gate resolved
   * `side: 'expert'`, i.e. the person seeing this copy IS the expert whose track closed. The
   * third-person form ("That expert is no longer on this request.") told them about themselves.
   * That form is still correct on the CLIENT arm and is pinned separately in
   * `confirm-request-file-upload.test.ts` — the two must not be collapsed back together.
   */
  it('denies an expert whose track is closed, in SECOND person', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: {
        relationshipId: REL_ID,
        expertProfileId: 'ep',
        access: { kind: 'closed', closedAt: new Date() },
      },
    });
    const result = await requestSharedFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: false,
      error: 'You can no longer share files on this request.',
    });
    expect(result.success === false && result.error).not.toContain('That expert');
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content type', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    const result = await requestSharedFileUploadAction({
      ...VALID_INPUT,
      contentType: 'application/x-msdownload',
    });
    expect(result).toEqual({ success: false, error: 'This file type is not supported.' });
  });

  /**
   * ⚠ THE SIZE IS SIGNED INTO THE URL, so it must never reach the signer unbounded. Without
   * this rejection an authenticated participant could loop the action and PUT arbitrarily large
   * objects into `request-files/` and never confirm — nothing writes a row, so nothing reaps
   * them.
   */
  it('rejects a declared size above the cap BEFORE presigning', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    const result = await requestSharedFileUploadAction({
      ...VALID_INPUT,
      sizeBytes: 10 * 1024 * 1024 + 1,
    });
    expect(result).toEqual({
      success: false,
      error: 'This file is too large. Please try a smaller file.',
    });
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('rejects a non-positive declared size', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    const result = await requestSharedFileUploadAction({ ...VALID_INPUT, sizeBytes: 0 });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('presigns for a live expert track', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: { relationshipId: REL_ID, expertProfileId: 'ep', access: { kind: 'live' } },
    });
    const result = await requestSharedFileUploadAction(VALID_INPUT);
    expect(result).toEqual({
      success: true,
      presignedUrl: 'https://signed',
      key: 'request-files/x/y/z',
    });
    expect(mockPresign).toHaveBeenCalledWith(REQUEST_ID, USER_ID, 'application/pdf', SIZE_BYTES);
  });

  it('presigns for a client', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    const result = await requestSharedFileUploadAction(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it('ignores a caller-supplied side/expertRelationshipId/audience — the GATE decides, never the body', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    const maliciousInput = {
      ...VALID_INPUT,
      side: 'admin',
      expertRelationshipId: REL_ID,
      audience: 'grants',
    };
    const result = await requestSharedFileUploadAction(maliciousInput);
    // Zod strips unknown keys; the schema has no `side`/`expertRelationshipId`/`audience`
    // field, so these can never reach `authorizeRequestFileScope` or the presign call.
    expect(result.success).toBe(true);
    expect(mockAuthorizeScope).toHaveBeenCalledWith(USER, REQUEST_ID);
    expect(mockPresign).toHaveBeenCalledWith(REQUEST_ID, USER_ID, 'application/pdf', SIZE_BYTES);
  });

  /**
   * ⚠ A PRESIGN FAILURE MUST NOT LEAK R2 INTERNALS. This action's error string is rendered
   * straight into a toast, so an AWS SDK message (which carries bucket names and key ids) must
   * never reach it — the generic copy is the only thing the client may see.
   */
  it('maps an unexpected presign failure to generic copy, leaking no internals', async () => {
    mockPresign.mockRejectedValue(
      new Error('SignatureDoesNotMatch: bucket=balo-prod-files key=AKIAEXAMPLE')
    );

    const result = await requestSharedFileUploadAction(VALID_INPUT);

    expect(result).toEqual({ success: false, error: "File sharing isn't available right now." });
    const message = result.success === false ? result.error : '';
    expect(message).not.toContain('AKIA');
    expect(message).not.toContain('balo-prod-files');
  });
});
