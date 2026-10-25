import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * BAL-617 — per-viewer resolution of request-share card messages.
 *
 * ⚠ THE SCOPE GATE AND THE TRACK READ ARE DOUBLES (each has its own suite); the AUDIENCE RULE is
 * REAL (`@balo/shared/authz` is not mocked), so a revoked grant, a deleted file and a closed
 * track are proven against the actual predicate rather than a stub of it.
 */

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';
const CLIENT_USER_ID = 'u0000000-0000-4000-8000-000000000006';
const FILE_ID = 'f0000000-0000-4000-8000-000000000001';
const FILE_ID_2 = 'f0000000-0000-4000-8000-000000000002';

const mockListByIds = vi.fn();
const mockFindNamesByIds = vi.fn();
vi.mock('@balo/db', () => ({
  requestSharedFilesRepository: {
    listByIdsInRequest: (...args: unknown[]) => mockListByIds(...args),
  },
  usersRepository: { findNamesByIds: (...args: unknown[]) => mockFindNamesByIds(...args) },
}));

const mockAuthorizeScope = vi.fn();
vi.mock('./authorize-request-file-scope', () => ({
  authorizeRequestFileScope: (...args: unknown[]) => mockAuthorizeScope(...args),
}));

const mockLoadTrackDisplays = vi.fn();
vi.mock('./load-request-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./load-request-files')>();
  return { ...actual, loadTrackDisplays: (...args: unknown[]) => mockLoadTrackDisplays(...args) };
});

import type { SessionUser } from '@/lib/auth/session';
import { REQUEST_FILE_EXPERT_VIEW_KEYS } from './request-file-audience-view';
import { attachRequestFileCards, type ThreadMessageRow } from './thread-file-cards';

const USER = { id: CLIENT_USER_ID } as SessionUser;
const OPENED_AT = new Date('2026-07-01T00:00:00.000Z');
const SHARED_AT = new Date('2026-08-05T00:00:00.000Z');
const CLOSED_AT = new Date('2026-08-20T00:00:00.000Z');

function messageRow(id: string, requestSharedFileId: string | null): ThreadMessageRow {
  return {
    id,
    conversationId: 'c0000000-0000-4000-8000-000000000001',
    senderUserId: CLIENT_USER_ID,
    body: requestSharedFileId === null ? '<p>hello</p>' : '<p>here you go</p>',
    sentDuringMeetingId: null,
    requestSharedFileId,
    createdAt: SHARED_AT,
    updatedAt: SHARED_AT,
    deletedAt: null,
    senderFirstName: 'Sarah',
    senderLastName: 'Chen',
  } as ThreadMessageRow;
}

function fileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FILE_ID,
    projectRequestId: REQUEST_ID,
    uploadedByUserId: CLIENT_USER_ID,
    fileName: 'Requirements.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    side: 'client',
    audience: 'all_live_tracks',
    expertRelationshipId: null,
    r2Key: 'request-files/secret-key',
    createdAt: SHARED_AT,
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  };
}

const LIVE_STANDING = {
  status: 'proposal_submitted',
  declinedAt: null,
  notSelectedAt: null,
  openedAt: OPENED_AT,
};

function expertScope(access: unknown = { kind: 'live' }): unknown {
  return {
    ok: true,
    side: 'expert',
    request: { id: REQUEST_ID, company: { name: 'Acme Corp' } },
    viewer: {
      relationshipId: REL_ID,
      expertProfileId: 'e1',
      access,
      standing: LIVE_STANDING,
    },
  };
}

const LIVE_TRACK_DISPLAY = {
  relationshipId: REL_ID,
  expertProfileId: 'e1',
  trackName: 'Wei',
  access: { kind: 'live' },
  closedReason: null,
};

function clientScope(): unknown {
  return {
    ok: true,
    side: 'client',
    companyId: 'c1',
    request: { id: REQUEST_ID, company: { name: 'Acme Corp' } },
    tracks: [
      {
        relationshipId: REL_ID,
        expertProfileId: 'e1',
        access: { kind: 'live' },
        standing: LIVE_STANDING,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindNamesByIds.mockResolvedValue([
    { id: CLIENT_USER_ID, firstName: 'Sarah', lastName: 'Chen' },
  ]);
  mockLoadTrackDisplays.mockResolvedValue([LIVE_TRACK_DISPLAY]);
});

describe('attachRequestFileCards', () => {
  it('maps ordinary messages unchanged and runs no query when no row is a share', async () => {
    const views = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', null)]);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: 'm1',
      bodyHtml: '<p>hello</p>',
      senderName: 'Sarah Chen',
    });
    expect(views[0]).not.toHaveProperty('requestSharedFile');
    expect(mockAuthorizeScope).not.toHaveBeenCalled();
    expect(mockListByIds).not.toHaveBeenCalled();
  });

  it('authorizes ONCE and reads the files in ONE query for the page, deleted rows included', async () => {
    mockAuthorizeScope.mockResolvedValue(clientScope());
    mockListByIds.mockResolvedValue([
      { file: fileRow(), grants: [] },
      { file: fileRow({ id: FILE_ID_2 }), grants: [] },
    ]);

    await attachRequestFileCards(USER, REQUEST_ID, [
      messageRow('m1', FILE_ID),
      messageRow('m2', FILE_ID_2),
      messageRow('m3', FILE_ID),
    ]);

    expect(mockAuthorizeScope).toHaveBeenCalledTimes(1);
    expect(mockListByIds).toHaveBeenCalledTimes(1);
    expect(mockListByIds).toHaveBeenCalledWith(REQUEST_ID, [FILE_ID, FILE_ID_2], {
      includeDeleted: true,
    });
  });

  describe('expert viewer', () => {
    it('gets an audience-free card: keys are exactly { kind, file } and file the expert view keys', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope());
      mockListByIds.mockResolvedValue([{ file: fileRow(), grants: [] }]);

      const [view] = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      const card = view?.requestSharedFile;
      if (card?.kind !== 'expert') throw new Error('expected an expert card');
      expect(Object.keys(card).sort()).toEqual(['file', 'kind']);
      expect(Object.keys(card.file).sort()).toEqual([...REQUEST_FILE_EXPERT_VIEW_KEYS].sort());
      const json = JSON.stringify(view);
      for (const forbidden of ['visibleToLiveTrackIds', 'audience', 'r2Key', 'secret-key']) {
        expect(json).not.toContain(forbidden);
      }
    });

    it('DROPS the message when the file was granted to a different track (revoked grant)', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope());
      mockListByIds.mockResolvedValue([
        {
          file: fileRow({ audience: 'grants' }),
          grants: [{ relationshipId: OTHER_REL_ID }],
        },
      ]);

      const views = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      expect(views).toEqual([]);
    });

    it('DROPS the message when the file was soft-deleted', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope());
      mockListByIds.mockResolvedValue([
        { file: fileRow({ deletedAt: CLOSED_AT, deletedByUserId: CLIENT_USER_ID }), grants: [] },
      ]);

      const views = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      expect(views).toEqual([]);
    });

    it('DROPS the message when the expert’s track is closed (ADR-1048)', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope({ kind: 'closed', closedAt: CLOSED_AT }));
      mockListByIds.mockResolvedValue([
        { file: fileRow({ audience: 'grants' }), grants: [{ relationshipId: REL_ID }] },
      ]);

      const views = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      expect(views).toEqual([]);
    });

    it('keeps ordinary messages while dropping the hidden share', async () => {
      mockAuthorizeScope.mockResolvedValue(expertScope());
      mockListByIds.mockResolvedValue([
        { file: fileRow({ deletedAt: CLOSED_AT, deletedByUserId: CLIENT_USER_ID }), grants: [] },
      ]);

      const views = await attachRequestFileCards(USER, REQUEST_ID, [
        messageRow('m1', null),
        messageRow('m2', FILE_ID),
      ]);

      expect(views.map((v) => v.id)).toEqual(['m1']);
    });
  });

  describe('client viewer', () => {
    it('gets a client card carrying the audience and the live-track ids', async () => {
      mockAuthorizeScope.mockResolvedValue(clientScope());
      mockListByIds.mockResolvedValue([{ file: fileRow(), grants: [] }]);

      const [view] = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      const card = view?.requestSharedFile;
      if (card?.kind !== 'client') throw new Error('expected a client card');
      expect(card.file.fileName).toBe('Requirements.pdf');
      expect(card.file.uploadedByName).toBe('Sarah Chen @ Acme Corp');
      expect(card.file.visibleToLiveTrackIds).toEqual([REL_ID]);
      expect(JSON.stringify(view)).not.toContain('secret-key');
    });

    it('gets a client_removed tombstone for a file deleted after it was shared', async () => {
      mockAuthorizeScope.mockResolvedValue(clientScope());
      mockListByIds.mockResolvedValue([
        { file: fileRow({ deletedAt: CLOSED_AT, deletedByUserId: CLIENT_USER_ID }), grants: [] },
      ]);

      const [view] = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      expect(view?.requestSharedFile).toEqual({
        kind: 'client_removed',
        fileName: 'Requirements.pdf',
      });
    });

    it('DROPS a share whose file sits on an expert track the client cannot see', async () => {
      mockAuthorizeScope.mockResolvedValue(clientScope());
      mockListByIds.mockResolvedValue([
        {
          file: fileRow({
            side: 'expert',
            audience: 'own_track',
            expertRelationshipId: OTHER_REL_ID,
          }),
          grants: [],
        },
      ]);

      const views = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      expect(views).toEqual([]);
    });
  });

  describe('admin viewer', () => {
    it('gets an admin card, tombstones included', async () => {
      mockAuthorizeScope.mockResolvedValue({
        ok: true,
        side: 'admin',
        request: { id: REQUEST_ID, company: { name: 'Acme Corp' } },
        tracks: [],
      });
      mockListByIds.mockResolvedValue([
        { file: fileRow({ deletedAt: CLOSED_AT, deletedByUserId: CLIENT_USER_ID }), grants: [] },
      ]);

      const [view] = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      const card = view?.requestSharedFile;
      if (card?.kind !== 'admin') throw new Error('expected an admin card');
      expect(card.file.deleted).toBe(true);
      expect(card.file.deletedByName).toBe('Sarah Chen');
    });
  });

  describe('scope denied or file missing', () => {
    it('DROPS every share row when the scope is denied, keeping ordinary messages', async () => {
      mockAuthorizeScope.mockResolvedValue({ ok: false, code: 'request_files_not_found' });

      const views = await attachRequestFileCards(USER, REQUEST_ID, [
        messageRow('m1', null),
        messageRow('m2', FILE_ID),
      ]);

      expect(views.map((v) => v.id)).toEqual(['m1']);
      expect(mockListByIds).not.toHaveBeenCalled();
    });

    it('DROPS a share whose file is not on this request', async () => {
      mockAuthorizeScope.mockResolvedValue(clientScope());
      mockListByIds.mockResolvedValue([]);

      const views = await attachRequestFileCards(USER, REQUEST_ID, [messageRow('m1', FILE_ID)]);

      expect(views).toEqual([]);
    });
  });
});
