import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const USER_ID = 'e0000000-0000-4000-8000-000000000005';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireUser(),
}));

const mockAuthorizeScope = vi.fn();
vi.mock('@/lib/request-files/authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
  REQUEST_FILES_UNAVAILABLE_COPY: 'These files are no longer available.',
}));

const mockRevokeGrant = vi.fn();
// ⚠ `vi.hoisted` — see confirm-request-file-upload.test.ts's comment: a `class` referenced
// inside a `vi.mock` factory hits the TDZ, since only `const mockXxx` patterns are relocated.
const { MockGrantNotFoundError, MockFileNotFoundError } = vi.hoisted(() => {
  class MockGrantNotFoundErrorImpl extends Error {}
  class MockFileNotFoundErrorImpl extends Error {}
  return {
    MockGrantNotFoundError: MockGrantNotFoundErrorImpl,
    MockFileNotFoundError: MockFileNotFoundErrorImpl,
  };
});
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: { revokeGrant: (...args: unknown[]) => mockRevokeGrant(...args) },
  RequestFileGrantNotFoundError: MockGrantNotFoundError,
  RequestFileNotFoundError: MockFileNotFoundError,
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...args: unknown[]) => mockTrack(...args),
  REQUEST_FILE_SERVER_EVENTS: { AUDIENCE_CHANGED: 'request_file_audience_changed' },
}));

import { revokeRequestFileGrantAction } from './revoke-request-file-grant';

const USER = { id: USER_ID };
const VALID_INPUT = { requestId: REQUEST_ID, fileId: FILE_ID, relationshipId: REL_ID };

describe('revokeRequestFileGrantAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireUser.mockResolvedValue(USER);
  });

  it('denies when not signed in', async () => {
    mockRequireUser.mockRejectedValue(new Error('nope'));
    const result = await revokeRequestFileGrantAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
  });

  it('denies an expert viewer — revoke is client-only', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'expert',
      request: { id: REQUEST_ID },
      viewer: { relationshipId: REL_ID, expertProfileId: 'ep', access: { kind: 'live' } },
    });
    const result = await revokeRequestFileGrantAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'These files are no longer available.' });
    expect(mockRevokeGrant).not.toHaveBeenCalled();
  });

  it('denies the admin lens', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'admin',
      request: { id: REQUEST_ID },
      tracks: [],
    });
    const result = await revokeRequestFileGrantAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'These files are no longer available.' });
  });

  it('revokes for a client and publishes NO notification', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockRevokeGrant.mockResolvedValue({ id: 'grant-1' });
    const result = await revokeRequestFileGrantAction(VALID_INPUT);
    expect(result).toEqual({ success: true });
    expect(mockTrack).toHaveBeenCalledWith(
      'request_file_audience_changed',
      expect.objectContaining({ action: 'revoke' })
    );
  });

  it('maps a missing grant to friendly copy', async () => {
    mockAuthorizeScope.mockResolvedValue({
      ok: true,
      side: 'client',
      request: { id: REQUEST_ID },
      companyId: 'c1',
      tracks: [],
    });
    mockRevokeGrant.mockRejectedValue(new MockGrantNotFoundError('gone'));
    const result = await revokeRequestFileGrantAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'This file is no longer available.' });
  });
});
